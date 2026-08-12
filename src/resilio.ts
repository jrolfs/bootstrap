import { ensureDir } from 'https://deno.land/std@0.192.0/fs/mod.ts';

import { configuration, environment } from './configuration.ts';
import { pathExists, shell } from './helpers.ts';
import { readSecret } from './onepassword.ts';
import type { ResilioConfiguration } from './schemas.ts';

const RESILIO_APP_PATH = '/Applications/Resilio Sync.app';
const RESILIO_SUPPORT_DIR = 'Library/Application Support/Resilio Sync';
const SYNC_CONF_NAME = 'sync.conf';

/**
 * Path to the Resilio Sync share secret persisted in the `private` homeshick
 * castle. The private castle must already be cloned before this is read.
 */
const PRIVATE_CASTLE_SECRET_PATH = (home: string): string =>
  `${home}/.homesick/repos/private/home/.config/resilio/configuration-share-secret`;

const expandHome = (home: string, candidate: string): string =>
  candidate.startsWith('~/') ? `${home}/${candidate.slice(2)}` : candidate;

// Resilio Sync's sync.conf uses snake_case keys; quoted property names keep
// the JSON wire format intact without tripping the camelcase lint rule.
interface SharedFolderConfig {
  readonly secret: string;
  readonly dir: string;
  readonly 'use_relay_server': boolean;
  readonly 'use_tracker': boolean;
  readonly 'search_lan': boolean;
}

interface SyncConfFile {
  readonly 'shared_folders': readonly SharedFolderConfig[];
}

/**
 * Installs the Resilio Sync cask via Homebrew if it is not already present.
 *
 * The cask is also declared in the nix-config Homebrew set, but bootstrap
 * runs before nix-darwin is activated so we install it eagerly here to
 * pre-seed config before launch.
 */
const ensureResilioInstalled = async (): Promise<void> => {
  if (Deno.build.os !== 'darwin') {
    console.log('Skipping Resilio install on non-darwin host');
    return;
  }

  if (await pathExists(RESILIO_APP_PATH)) {
    console.log('✓ Resilio Sync already installed');
    return;
  }

  console.log('Installing Resilio Sync via Homebrew...');
  await shell('brew', ['install', '--cask', 'resilio-sync']);
};

/**
 * Reads the configuration-share secret based on the configured source.
 *
 * Supported sources:
 *   - `private-castle` — read from the homeshick `private` castle (legacy /
 *     offline fallback).
 *   - `1password` — fetch via the 1Password CLI. The reference path is set
 *     in `configuration.resilio.configShareSecretOpReference` and is fully
 *     user-configurable (short or fully-qualified `op://...` form).
 *   - `prompt` — interactive prompt, not yet implemented.
 */
const readConfigShareSecret = async (
  resilio: ResilioConfiguration,
  home: string,
): Promise<string> => {
  switch (resilio.configShareSecretSource) {
    case 'private-castle': {
      const path = PRIVATE_CASTLE_SECRET_PATH(home);
      if (!(await pathExists(path))) {
        throw new Error(
          `Resilio share secret not found at ${path}. ` +
            'Ensure the private castle has been cloned before configuring Resilio.',
        );
      }
      const secret = (await Deno.readTextFile(path)).trim();
      if (!secret) {
        throw new Error(`Resilio share secret at ${path} is empty`);
      }
      return secret;
    }

    case 'prompt':
      // TODO(resilio): Implement interactive prompt. Use `Deno.stdin` to read a
      // line and trim. Useful for first-bootstrap-ever scenarios where the
      // private castle does not yet exist.
      throw new Error(
        'Resilio secret source "prompt" is not yet implemented',
      );

    case '1password': {
      const reference = resilio.configShareSecretOpReference;
      if (!reference) {
        throw new Error(
          'Resilio secret source "1password" requires ' +
            '`resilio.configShareSecretOpReference` to be set',
        );
      }
      const secret = await readSecret(reference);
      if (!secret) {
        throw new Error(
          `Resilio share secret fetched from 1Password (${reference}) is empty`,
        );
      }
      return secret;
    }
  }
};

const buildSyncConf = (secret: string, sharePath: string): SyncConfFile => ({
  'shared_folders': [
    {
      secret,
      dir: sharePath,
      'use_relay_server': true,
      'use_tracker': true,
      'search_lan': true,
    },
  ],
});

/**
 * Pre-seeds `~/Library/Application Support/Resilio Sync/sync.conf` with the
 * configuration share before launching the app for the first time.
 *
 * The localhost:8888 HTTP API requires GUI-set credentials on first launch,
 * so pre-seeding `sync.conf` is the simplest reliable bootstrap path.
 *
 * If `sync.conf` already exists we merge the share into the existing
 * `shared_folders` array (idempotency); otherwise we write a fresh file.
 */
const seedSyncConf = async (
  resilio: ResilioConfiguration,
  home: string,
): Promise<void> => {
  const supportDir = `${home}/${RESILIO_SUPPORT_DIR}`;
  const syncConfPath = `${supportDir}/${SYNC_CONF_NAME}`;
  await ensureDir(supportDir);

  const secret = await readConfigShareSecret(resilio, home);
  const sharePath = expandHome(home, resilio.configSharePath);

  if (await pathExists(syncConfPath)) {
    const existingRaw = await Deno.readTextFile(syncConfPath);

    try {
      const existing = JSON.parse(existingRaw) as Partial<SyncConfFile>;
      const folders = existing['shared_folders'] ?? [];
      const alreadyConfigured = folders.some(
        (folder) => folder.secret === secret || folder.dir === sharePath,
      );

      if (alreadyConfigured) {
        console.log(`✓ Resilio sync.conf already references ${sharePath}`);
        return;
      }

      const next: SyncConfFile = {
        ...existing,
        'shared_folders': [
          ...folders,
          {
            secret,
            dir: sharePath,
            'use_relay_server': true,
            'use_tracker': true,
            'search_lan': true,
          },
        ],
      };

      await Deno.writeTextFile(syncConfPath, JSON.stringify(next, null, 2));
      console.log(`✓ Merged ${sharePath} share into existing sync.conf`);
      return;
    } catch (error) {
      console.warn(
        `Existing sync.conf at ${syncConfPath} was unparseable; overwriting:`,
        error,
      );
    }
  }

  const conf = buildSyncConf(secret, sharePath);
  await Deno.writeTextFile(syncConfPath, JSON.stringify(conf, null, 2));
  console.log(`✓ Wrote Resilio sync.conf with share ${sharePath}`);
};

/**
 * Installs Resilio Sync, pre-seeds `sync.conf` with the configuration share,
 * and launches the app so the daemon begins syncing.
 */
export const configureResilio = async (): Promise<void> => {
  const resilio = configuration.resilio;

  if (!resilio?.enabled) {
    console.log('Resilio configuration disabled; skipping');
    return;
  }

  if (Deno.build.os !== 'darwin') {
    console.log('Resilio configuration skipped on non-darwin host');
    return;
  }

  const { HOME } = environment();

  await ensureResilioInstalled();
  await seedSyncConf(resilio, HOME);

  // Launch Resilio Sync so the daemon picks up the pre-seeded sync.conf.
  // `open -g` keeps the launch in the background; the wait helper below
  // observes the sync progress separately.
  console.log('Launching Resilio Sync...');
  await shell('open', ['-g', RESILIO_APP_PATH], { error: false });
};

/**
 * Waits for the configuration share to finish its initial sync.
 *
 * Bootstrap should not run `mackup restore` until `~/Configuration/mackup/`
 * exists, which is the signal we look for here.
 *
 * Alternative implementation sketch (Syncthing fallback):
 *   1. `brew install syncthing` (or install via nix-config).
 *   2. Generate device ID with `syncthing generate`.
 *   3. POST to `http://localhost:8384/rest/config/folders` with
 *      `{ id: "configuration", path: "~/Configuration", devices: [...] }`.
 *   4. Each peer device must accept the folder once (per-device pairing
 *      round trip; one-time cost). Use `/rest/config/devices` to add peers.
 *   5. Poll `/rest/db/status?folder=configuration` until
 *      `globalBytes === inSyncBytes` and `needBytes === 0`.
 */
export const waitForResilioSync = async (): Promise<void> => {
  const resilio = configuration.resilio;
  if (!resilio?.enabled) return;

  const { HOME } = environment();
  const sharePath = expandHome(HOME, resilio.configSharePath);
  const mackupSentinel = `${sharePath}/mackup`;

  const maxAttempts = 60;
  const intervalMs = 5_000;

  console.log(`Waiting for ${mackupSentinel} to appear...`);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (await pathExists(mackupSentinel)) {
      console.log(`✓ ${mackupSentinel} is present; initial sync complete`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `Timed out waiting for ${mackupSentinel}; ` +
      'Resilio may need manual approval or peer connectivity check',
  );
};
