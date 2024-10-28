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

  await openBrowser(deviceCode.verification_uri);

  githubAccessToken = await pollForToken(
    clientId,
    deviceCode.device_code,
    deviceCode.interval,
  );

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