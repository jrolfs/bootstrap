import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import { bold, red } from 'https://deno.land/std@0.192.0/fmt/colors.ts';
import { ensureFile, exists } from 'https://deno.land/std@0.192.0/fs/mod.ts';

import {
  accessTokenResponseSchema,
  commandResultSchema,
  configurationSchema,
  deviceCodeResponseSchema,
  environmentSchema,
  githubKeysResponseSchema,
  repositorySchema,
} from './schemas.ts';

// Add this new helper function near the top of the file
const reportApiError = async (response: Response) => {
  console.error(
    red(`${bold(response.status.toString())}: ${response.statusText}\n`),
    red(await response.text()),
  );
};

let githubAccessToken: string | null = null;

const configuration = configurationSchema.parse({
  github: {
    user: 'jrolfs',
    email: 'jamie.rolfs@gmail.com',
    clientId: 'Ov23littWGoGtwfc0yEv',
    repositories: [
      { url: 'git@github.com:jrolfs/neovim.git', name: 'neovim' },
      { url: 'git@github.com:jrolfs/private.git', name: 'private' },
      { url: 'git@github.com:jrolfs/macos.git', name: 'macos' },
      { url: 'git@github.com:jrolfs/dot.git', name: 'dot' },
    ],
  },
  homeshick: {
    remote: 'git://github.com/andsens/homeshick.git',
  },
});

const environment = () => ({
  ...environmentSchema.parse(Deno.env.toObject()),
  hostname: Deno.hostname().trim().toLowerCase(),
});

const decoder = new TextDecoder();

const shell = async (command: string, args: string[] = []) => {
  console.log(`Running: ${command} ${args.join(' ')}`);

  const process = new Deno.Command(command, {
    args,
    stdout: 'piped',
    stderr: 'piped',
  });

  const { success, stdout, stderr } = await process.output();

  return commandResultSchema.parse({
    success,
    stdout: decoder.decode(stdout),
    stderr: decoder.decode(stderr),
  });
};

const pathExists = async (path: string) => {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
};

const DEVICE_CODE_FILE = `${Deno.env.get('HOME')}/.bootstrap/device-code.json`;

const githubApiRequest = async (
  url: string,
  options: RequestInit,
  requiresAuth = true,
): Promise<Response> => {
  console.log(`GitHub API request: ${url}`);

  const makeRequest = (token?: string) => {
    const headers = new Headers(options.headers);
    if (token) {
      headers.set('Authorization', `token ${token}`);
    }
    return fetch(url, { ...options, headers });
  };

  // Use the stored access token if available
  let response = await makeRequest(githubAccessToken || undefined);

  if (requiresAuth && response.status === 401) {
    reportApiError(response);
    console.log('Authentication required. Initiating GitHub authentication...');
    githubAccessToken = await authenticateGitHub(configuration.github.clientId);
    response = await makeRequest(githubAccessToken);
  }

  if (!response.ok) {
    await reportApiError(response);
    throw new Error(`GitHub API request failed: ${response.statusText}`);
  }

  return response;
};

const getDeviceCode = async (clientId: string) => {
  const response = await fetch(
    'https://github.com/login/device/code',
    {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        scope: 'write:public_key',
      }),
    },
  );

  if (!response.ok) {
    await reportApiError(response);
    throw new Error('Failed to get device code');
  }

  return deviceCodeResponseSchema.parse(await response.json());
};

const pollForToken = async (
  clientId: string,
  deviceCode: string,
  interval: number,
): Promise<string> => {
  console.log('Polling for token...');

  const response = await fetch(
    'https://github.com/login/oauth/access_token',
    {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    },
  );

  if (!response.ok) {
    await reportApiError(response);
    throw new Error('Failed to get access token');
  }

  const data = await response.json();
  const result = accessTokenResponseSchema.parse(data);

  if ('error' in result) {
    if (result.error === 'authorization_pending') {
      await new Promise((resolve) => setTimeout(resolve, interval * 1000));

      return pollForToken(clientId, deviceCode, interval);
    }

    console.error(JSON.stringify(result, null, 2));

    throw new Error(
      `Authentication failed: ${result.error_description ?? result.error}`,
    );
  }

  return result.access_token;
};

const authenticateGitHub = async (clientId: string) => {
  if (githubAccessToken) {
    console.log('Using existing GitHub access token');
    return githubAccessToken;
  }

  if (await exists(DEVICE_CODE_FILE)) {
    const savedCode = JSON.parse(await Deno.readTextFile(DEVICE_CODE_FILE));

    if (savedCode.expires_at > Date.now()) {
      console.log('Using saved device code');
      return pollForToken(clientId, savedCode.device_code, savedCode.interval);
    }
  }

  const deviceCode = await getDeviceCode(clientId);

  await ensureFile(DEVICE_CODE_FILE);
  await Deno.writeTextFile(
    DEVICE_CODE_FILE,
    JSON.stringify({
      ...deviceCode,
      expires_at: Date.now() + deviceCode.expires_in * 1000,
    }),
  );

  console.log('\nTo authenticate with GitHub:');
  console.log(`1. Visit: ${deviceCode.verification_uri}`);
  console.log(`2. Enter code: ${deviceCode.user_code}\n`);

  githubAccessToken = await pollForToken(
    clientId,
    deviceCode.device_code,
    deviceCode.interval,
  );

  return githubAccessToken;
};

const uploadGitHubKey = async (publicKey: string) => {
  const { hostname } = environment();

  const existingKeysResponse = await githubApiRequest(
    'https://api.github.com/user/keys',
    { headers: { 'Accept': 'application/vnd.github.v3+json' } },
  );

  const existingKeysData = await existingKeysResponse.json();
  const existingKeys = githubKeysResponseSchema.parse(existingKeysData);

  const keyTitle = `bootstrap-${hostname}`;
  const keyExists = existingKeys.some((key) => key.title === keyTitle);

  if (keyExists) {
    console.log('✓ SSH key already uploaded to GitHub');
    return;
  }

  await githubApiRequest('https://api.github.com/user/keys', {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: keyTitle,
      key: publicKey.trim(),
    }),
  });

  console.log('✓ SSH key uploaded to GitHub');
};

// Core functions
const ensureHomebrew = async () => {
  if (await pathExists('/opt/homebrew')) {
    console.log('✓ Homebrew already installed');
    return;
  }

  console.log('Installing Homebrew...');
  await shell('/bin/bash', [
    '-c',
    '$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)',
  ]);
};

const setupSSHKey = async () => {
  const { HOME, hostname } = environment();
  const sshPath = `${HOME}/.ssh/id_ed25519`;
  const publicKeyPath = `${sshPath}.pub`;

  if (await pathExists(sshPath)) {
    console.log('✓ SSH key already exists');
  } else {
    console.log('Generating SSH key...');

    await shell('ssh-keygen', [
      '-t',
      'ed25519',
      '-C',
      `${configuration.github.email}+bootstrap-${hostname}@gmail.com`,
      '-f',
      sshPath,
      '-N',
      '',
    ]);
  }

  const publicKey = await Deno.readTextFile(publicKeyPath);
  await uploadGitHubKey(publicKey);
};

const setupHomeshick = async () => {
  const { HOME } = environment();
  const homeshickPath = `${HOME}/.homesick/repos/homeshick`;

  if (await pathExists(homeshickPath)) {
    console.log('✓ homeshick already installed');
    return;
  }

  console.log('Installing homeshick...');
  await shell('git', [
    'clone',
    configuration.homeshick.remote,
    homeshickPath,
  ]);

  const cloneRepo = async (repository: z.infer<typeof repositorySchema>) => {
    const repoPath = `${HOME}/.homesick/repos/${repository.name}`;

    if (await pathExists(repoPath)) {
      console.log(`✓ ${repository.name} already cloned`);
      return;
    }

    console.log(`Cloning ${repository.name}...`);
    await shell('bash', [
      '-c',
      `source ${homeshickPath}/homeshick.sh && homeshick clone -b ${repository.url}`,
    ]);
  };

  await Promise.all(configuration.github.repositories.map(cloneRepo));

  console.log('Linking dotfiles...');
  await shell('bash', [
    '-c',
    `source ${homeshickPath}/homeshick.sh && homeshick link`,
  ]);
};

const bootstrap = async () => {
  try {
    environment();

    await setupSSHKey();
    await ensureHomebrew();
    await setupHomeshick();

    console.log('✨ Bootstrap complete!');
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('Validation error:', JSON.stringify(error.errors, null, 2));
    } else {
      console.error('Bootstrap failed:', error);
    }
    Deno.exit(1);
  }
};

if (import.meta.main) {
  bootstrap();
}
