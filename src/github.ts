import { ensureFile, exists } from 'https://deno.land/std@0.192.0/fs/mod.ts';
import {
  blue,
  bold,
  gray,
  green,
  red,
  yellow,
} from 'https://deno.land/std@0.192.0/fmt/colors.ts';

import {
  accessTokenResponseSchema,
  deviceCodeResponseSchema,
  githubKeysResponseSchema,
  githubUserResponseSchema,
} from './schemas.ts';
import { configuration, environment } from './configuration.ts';
import {
  openBrowser,
  promptLine,
  promptSecret,
  reportApiError,
} from './helpers.ts';
import { loadManifest, saveManifest, type SecretEntry } from './manifest.ts';
import { writeItemField } from './onepassword.ts';

const DEVICE_CODE_FILE = `${Deno.env.get('HOME')}/.bootstrap/device-code.json`;

let githubAccessToken: string | null = null;

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

// GitHub's device-flow payload is snake_case; quoted keys keep the wire format
// intact without tripping the camelcase lint rule (same as resilio.ts).
interface PendingDeviceCode {
  readonly 'device_code': string;
  readonly 'user_code': string;
  readonly 'verification_uri': string;
  readonly interval: number;
  /** Epoch millis after which the code is no longer usable. */
  readonly 'expires_at': number;
}

/**
 * Prints the verification URL and user code. Called every time we start or
 * resume polling — including when resuming from a cached code, where the user
 * otherwise has no way to know what to type.
 */
const printDeviceCodeInstructions = (pending: PendingDeviceCode): void => {
  const minutes = Math.max(
    0,
    Math.round((pending.expires_at - Date.now()) / 60_000),
  );

  console.log('\nTo authenticate with GitHub:');
  console.log(`  1. Visit: ${pending.verification_uri}`);
  console.log(`  2. Enter code: ${pending.user_code}`);
  console.log(`  (code expires in ~${minutes}m)\n`);
};

const sleep = (seconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * Polls GitHub for the access token until the user completes authorization.
 *
 * Iterative (not recursive) and bounded by the code's expiry. Re-prints the
 * instructions periodically so the code stays visible amid the polling output,
 * and honours `slow_down` by backing the interval off as the spec requires.
 *
 * @returns The access token
 * @throws When the code expires, is denied, or the request fails
 */
const pollForToken = async (
  clientId: string,
  pending: PendingDeviceCode,
): Promise<string> => {
  let interval = pending.interval;
  let polls = 0;

  while (Date.now() < pending.expires_at) {
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
          device_code: pending.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      },
    );

    if (!response.ok) {
      await reportApiError(response);
      throw new Error('Failed to get access token');
    }

    const result = accessTokenResponseSchema.parse(await response.json());

    if (!('error' in result)) return result.access_token;

    if (result.error === 'authorization_pending') {
      polls += 1;
      // Re-surface the code every ~10 polls (~50s at the default interval) so
      // it's never scrolled off screen while waiting.
      if (polls % 10 === 0) printDeviceCodeInstructions(pending);
      else console.log('Polling for token...');

      await sleep(interval);
      continue;
    }

    if (result.error === 'slow_down') {
      // Per the device-flow spec, back off by 5s and keep polling.
      interval += 5;
      console.log(`Rate limited; slowing polling to ${interval}s`);
      await sleep(interval);
      continue;
    }

    console.error(JSON.stringify(result, null, 2));

    throw new Error(
      `Authentication failed: ${result.error_description ?? result.error}`,
    );
  }

  throw new Error(
    'Device code expired before authorization completed. Re-run bootstrap to ' +
      'get a fresh code.',
  );
};

const authenticateGitHub = async (clientId: string) => {
  if (githubAccessToken) {
    console.log('Using existing GitHub access token');
    return githubAccessToken;
  }

  // Resume a still-valid saved code (a killed/re-run bootstrap keeps the same
  // pending authorization) — but re-print the instructions, since the user
  // needs the code in front of them either way.
  if (await exists(DEVICE_CODE_FILE)) {
    const saved = JSON.parse(
      await Deno.readTextFile(DEVICE_CODE_FILE),
    ) as PendingDeviceCode;

    if (saved.expires_at > Date.now()) {
      console.log('Resuming saved device code');
      printDeviceCodeInstructions(saved);
      await openBrowser(saved.verification_uri);

      githubAccessToken = await pollForToken(clientId, saved);
      return githubAccessToken;
    }

    console.log('Saved device code expired; requesting a fresh one');
    await Deno.remove(DEVICE_CODE_FILE).catch(() => {});
  }

  const deviceCode = await getDeviceCode(clientId);
  const pending: PendingDeviceCode = {
    ...deviceCode,
    'expires_at': Date.now() + deviceCode.expires_in * 1000,
  };

  await ensureFile(DEVICE_CODE_FILE);
  await Deno.writeTextFile(DEVICE_CODE_FILE, JSON.stringify(pending));

  printDeviceCodeInstructions(pending);

  await openBrowser(pending.verification_uri);

  githubAccessToken = await pollForToken(clientId, pending);

  return githubAccessToken;
};

export const uploadGitHubKey = async (publicKey: string) => {
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

/**
 * Manifest entry for the git-credential-store line, and the defaults used when
 * it doesn't exist yet.
 *
 * `materialize` writes the field verbatim to `~/.git-credentials`, so the stored
 * value has to be a complete credential line rather than a bare token.
 */
const CREDENTIALS_ENTRY = 'github-credentials';
const CREDENTIALS_TARGET = '.git-credentials';
const CREDENTIALS_ITEM = 'GitHub HTTPS credentials';
const CREDENTIALS_FIELD = 'credential';
const CREDENTIALS_DESCRIPTION =
  'git-credential-store line for github.com, read during activation by brew ' +
  'bundle before home-manager exists';

const TOKEN_URL =
  'https://github.com/settings/tokens/new?scopes=repo&description=bootstrap%20https%20credentials';

interface CredentialLocation {
  readonly title: string;
  readonly field: string;
  /** Undefined falls back to the configured secrets vault. */
  readonly vault: string | undefined;
}

/**
 * Where to write the credential.
 *
 * Taken apart from the manifest entry's own reference when there is one, so a
 * re-run updates the item already recorded — even if it was renamed or moved to
 * another vault — instead of quietly creating a second one the manifest doesn't
 * point at.
 */
const credentialLocation = (entry?: SecretEntry): CredentialLocation => {
  const segments = entry?.reference.startsWith('op://')
    ? entry.reference.slice('op://'.length).split('/').filter((segment) =>
      segment.length > 0
    )
    : [];

  const [vault, title, field] = segments;

  return vault && title && field
    ? { vault, title, field }
    : { vault: undefined, title: CREDENTIALS_ITEM, field: CREDENTIALS_FIELD };
};

/**
 * Confirms the token works and reports which account it belongs to.
 *
 * @returns The authenticated login
 */
const verifyToken = async (token: string): Promise<string> => {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `token ${token}`,
    },
  });

  if (!response.ok) {
    await reportApiError(response);
    throw new Error(
      'The token was rejected by GitHub. Check that it was pasted whole and ' +
        "hasn't expired.",
    );
  }

  return githubUserResponseSchema.parse(await response.json()).login;
};

/**
 * Reports whether the token can read each configured private repository.
 *
 * A repository that exists but is out of the token's reach answers 404, exactly
 * as a misspelled one does — GitHub deliberately doesn't distinguish them. So
 * this can only say "reachable" or "not reachable", which is the distinction
 * that matters here anyway.
 *
 * @returns Slugs that were not reachable
 */
const probeRepositories = async (
  token: string,
): Promise<readonly string[]> => {
  const repositories = configuration.github.credentialProbeRepositories;

  if (repositories.length === 0) return [];

  console.log(blue(bold('\nChecking private repository access')));

  const results = await Promise.all(
    repositories.map(async (repository) => {
      const response = await fetch(
        `https://api.github.com/repos/${repository}`,
        {
          headers: {
            'Accept': 'application/vnd.github+json',
            'Authorization': `token ${token}`,
          },
        },
      );

      console.log(
        response.ok
          ? `${green('✓')} ${repository}`
          : `${red('✗')} ${repository} ${gray(`(${response.status})`)}`,
      );

      return { repository, reachable: response.ok };
    }),
  );

  return results.filter((result) => !result.reachable).map((result) =>
    result.repository
  );
};

interface CaptureCredentialsOptions {
  /** Overrides `configuration.github.user` in the credential line. */
  readonly user?: string;
}

/**
 * Captures a GitHub personal access token into 1Password as the credential line
 * `~/.git-credentials` needs, and records it in the manifest.
 *
 * Interactive by design: a token can't be minted through the device flow the
 * rest of this module uses (GitHub has no API for issuing one), so the only
 * options are typing it into a browser and pasting it here, or typing it into a
 * browser and hand-building a 1Password item. This is the same work with the
 * item shape, the reference, and the manifest entry taken care of — the parts
 * that break silently when they drift.
 *
 * The token is never written to disk by this command and never appears in argv:
 * stdin to here, stdin to `op`.
 */
export const captureHttpsCredentials = async (
  options: CaptureCredentialsOptions = {},
): Promise<void> => {
  const user = options.user ?? configuration.github.user;

  console.log(
    blue(bold('\nGitHub HTTPS credential')) + '\n' +
      gray(
        [
          '  A classic personal access token with the `repo` scope, stored as',
          '  the complete git-credential-store line for github.com.',
          '',
          '  It exists because `brew bundle` runs inside activation, before',
          '  home-manager has configured git or gpg-agent can serve an SSH',
          '  key — so a private tap clone has nothing but ~/.git-credentials',
          '  to authenticate with.',
          '',
          `  1. Opening ${TOKEN_URL}`,
          '  2. Confirm the `repo` scope, set an expiry, generate.',
          '  3. Paste the token below (input is hidden).',
        ].join('\n'),
      ),
  );

  await promptLine(yellow('\nPress Enter to open the browser... '));
  await openBrowser(TOKEN_URL);

  const token = await promptSecret('Token: ');

  if (!token) throw new Error('No token entered');

  // Classic tokens are `ghp_`; `github_pat_` is the fine-grained kind, which an
  // organization can restrict separately. Worth naming, not worth refusing.
  if (!token.startsWith('ghp_')) {
    console.log(
      yellow(
        token.startsWith('github_pat_')
          ? "That's a fine-grained token. It can work, but organizations gate " +
            'those separately — if the check below fails, a classic token is ' +
            'the thing to try.'
          : "That doesn't look like a personal access token (expected a " +
            '`ghp_` prefix). Continuing anyway.',
      ),
    );
  }

  const login = await verifyToken(token);

  console.log(`${green('✓')} token authenticates as ${bold(login)}`);

  if (login !== user) {
    console.log(
      yellow(
        `The credential will be written for user "${user}", but the token ` +
          `belongs to "${login}". git ignores the username in a credential ` +
          'line, so this works either way — pass --user to change it.',
      ),
    );
  }

  const unreachable = await probeRepositories(token);

  if (unreachable.length > 0) {
    console.log(
      yellow(
        `\n${unreachable.length} repository(ies) unreachable: ` +
          `${unreachable.join(', ')}.\n` +
          'If the names are right, the organization is refusing the token — ' +
          'check its personal access token policy (Settings → Third-party ' +
          'Access). Storing it anyway; re-run this command once that changes.',
      ),
    );
  }

  const manifest = await loadManifest();
  const existing = manifest.secrets[CREDENTIALS_ENTRY];
  const { title, field, vault } = credentialLocation(existing);

  const reference = await writeItemField({
    title,
    field,
    vault,
    value: `https://${user}:${token}@github.com`,
    notes: [
      'Managed by `bootstrap secrets github token`.',
      '',
      'The whole field is written verbatim to ~/.git-credentials (0600) by',
      '`bootstrap secrets materialize`, so it has to stay a complete',
      'git-credential-store line — scheme, user, token, host.',
    ].join('\n'),
  });

  await saveManifest({
    ...manifest,
    secrets: {
      ...manifest.secrets,
      [CREDENTIALS_ENTRY]: {
        ...existing,
        kind: 'field',
        reference,
        description: existing?.description ?? CREDENTIALS_DESCRIPTION,
        target: existing?.target ?? CREDENTIALS_TARGET,
        mode: existing?.mode ?? '0600',
        hosts: existing?.hosts ?? ['*'],
      },
    },
  });

  console.log(
    `\n${green('✓')} recorded ${bold(CREDENTIALS_ENTRY)} → ${reference}`,
  );
  console.log(
    gray(
      'Commit secrets.json, then `bootstrap secrets materialize ' +
        `${CREDENTIALS_ENTRY}` + '` on each machine that needs the file.',
    ),
  );
};
