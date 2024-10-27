import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';

import {
  accessTokenResponseSchema,
  commandResultSchema,
  configurationSchema,
  deviceCodeResponseSchema,
  environmentSchema,
  repositorySchema,
} from '../schemas.ts';

const configuration = configurationSchema.parse({
  github: {
    user: 'jrolfs',
    email: 'jamie.rolfs@gmail.com',
    clientId: 'Ov23liqO5PWve95MDvAu',
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

  const { installerSuccess, stdout, stderr } = await process.output();

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

  if (!response.ok) throw new Error('Failed to get device code');

  return deviceCodeResponseSchema.parse(await response.json());
};

const pollForToken = async (
  clientId: string,
  deviceCode: string,
  interval: number,
) => {
  while (true) {
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
      throw new Error('Failed to get access token');
    }

    const data = await response.json();
    const result = accessTokenResponseSchema.parse(data);

    if ('error' in result) {
      if (result.error === 'authorization_pending') {
        await new Promise((resolve) => setTimeout(resolve, interval * 1000));
        continue;
      }
      throw new Error(
        `Authentication failed: ${result.error_description ?? result.error}`,
      );
    }

    return result.access_token;
  }
};

const authenticateGitHub = async (clientId: string) => {
  const deviceCode = await getDeviceCode(clientId);

  console.log('\nTo authenticate with GitHub:');
  console.log(`1. Visit: ${deviceCode.verification_uri}`);
  console.log(`2. Enter code: ${deviceCode.user_code}\n`);

  return pollForToken(clientId, deviceCode.device_code, deviceCode.interval);
};

const uploadGitHubKey = async (publicKey: string) => {
  const { hostname } = environment();

  console.log('Initiating GitHub authentication...');
  const token = await authenticateGitHub(configuration.github.clientId);

  const response = await fetch('https://api.github.com/user/keys', {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `token ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: `bootstrap-${hostname}`,
      key: publicKey.trim(),
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to upload SSH key to GitHub: ${error}`);
  }

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
    return;
  }

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

const buildSystem = async () => {
  const { HOME } = environment();
  const darwinConfiguration = `${HOME}/.nixpkgs/darwin-configuration.nix`;

  if (!(await pathExists(darwinConfiguration))) {
    throw new Error(
      'darwin-configuration.nix not found. Make sure homeshick linked files correctly.',
    );
  }

  console.log('Building system configuration...');
  await shell('darwin-rebuild', ['switch']);
};

const bootstrap = async () => {
  try {
    environment();

    await setupSSHKey();
    await ensureHomebrew();
    await setupHomeshick();
    await buildSystem();

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
