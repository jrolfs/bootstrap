import { ensureFile, exists } from 'https://deno.land/std@0.192.0/fs/mod.ts';

import {
  accessTokenResponseSchema,
  deviceCodeResponseSchema,
  githubKeysResponseSchema
} from './schemas.ts';
import { configuration, environment } from './configuration.ts';
import { openBrowser, reportApiError } from './helpers.ts';

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