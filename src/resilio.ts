import { ensureDir } from 'https://deno.land/std@0.192.0/fs/mod.ts';
import { blue, bold, gray } from 'https://deno.land/std@0.192.0/fmt/colors.ts';

import { configuration, environment } from './configuration.ts';
import { pathExists, shell } from './helpers.ts';
import { bin, requireBrewBinary } from './system.ts';
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
  await shell(await requireBrewBinary('brew'), [
    'install',
    '--cask',
    'resilio-sync',
  ]);
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
  secret: string,
  sharePath: string,
  home: string,
): Promise<void> => {
  const supportDir = `${home}/${RESILIO_SUPPORT_DIR}`;
  const syncConfPath = `${supportDir}/${SYNC_CONF_NAME}`;
  await ensureDir(supportDir);

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
 * Installs Resilio Sync, best-effort pre-seeds `sync.conf` with the
 * configuration share, launches the app, and walks the user through the
 * first-run + folder-add if needed.
 *
 * Why the guided manual step: the pre-seeded `sync.conf` is the documented
 * path for the headless `rslsync` daemon, but the macOS **GUI** app manages
 * its folder list in its own storage and shows a first-run EULA, so the seed
 * may not take. Rather than silently assume it worked, we surface the secret
 * and pause so the folder can be added by hand when necessary — the step is
 * part of the process, not an undocumented gap.
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
  const sharePath = expandHome(HOME, resilio.configSharePath);

  await ensureResilioInstalled();

  const secret = await readConfigShareSecret(resilio, HOME);
  await ensureDir(sharePath);
  await seedSyncConf(secret, sharePath, HOME);

  // Foreground launch so the user can accept the EULA / complete first-run
  // and, if the pre-seed didn't take, add the share manually.
  console.log('Launching Resilio Sync...');
  await shell(bin.open, [RESILIO_APP_PATH], { error: false });

  const wrap = 80;
  console.log(
    '\n\n',
    `📁 ${bold('Resilio Sync — add the configuration share')}\n`,
    blue('‾'.repeat(wrap)),
    '\n',
    gray(
      ' If Resilio just opened to a first-run screen, accept the EULA (Standard\n' +
        ' setup is fine). Then confirm the folder below is present and syncing —\n' +
        ' the pre-seeded sync.conf usually adds it, but the GUI app may need it\n' +
        ' added by hand:\n',
    ),
    `\n   folder: ${bold(sharePath)}\n`,
    `   secret: ${bold(secret)}\n\n`,
    gray(
      ' To add manually: Resilio → "+" → "Enter a key or link" → paste the\n' +
        ` secret above → choose "${sharePath}" as the folder.`,
    ),
  );

  // Pause until the user confirms the share is set up. `prompt` returns null
  // on a non-interactive stdin, which is fine — waitForResilioSync then
  // polls for the sentinel regardless.
  prompt('\n Press Enter once the ~/Configuration folder is syncing in Resilio…');
};

const MACKUP_PATH = '/run/current-system/sw/bin/mackup';

/**
 * Restores app preferences from the synced `~/Configuration/mackup` store via
 * mackup, after the first system switch has installed mackup. Confirmed and
 * best-effort: skips cleanly if mackup isn't on the system yet or the synced
 * store hasn't arrived, so the user can always run `mkrs` later.
 */
export const restoreMackup = async (): Promise<void> => {
  const resilio = configuration.resilio;
  if (!resilio?.enabled || Deno.build.os !== 'darwin') return;

  const { HOME } = environment();
  const sharePath = expandHome(HOME, resilio.configSharePath);
  const mackupDir = `${sharePath}/mackup`;

  if (!(await pathExists(mackupDir))) {
    console.log(`No ${mackupDir} yet; skipping mackup restore (run \`mkrs\` later)`);
    return;
  }

  if (!(await pathExists(MACKUP_PATH))) {
    console.log(
      'mackup not installed on the system yet; skipping restore (run `mkrs` later)',
    );
    return;
  }

  const ok = confirm(
    'Restore app preferences from ~/Configuration via mackup now? (mackup restore -f)',
  );
  if (!ok) {
    console.log('Skipped mackup restore; run `mkrs` when ready.');
    return;
  }

  await shell(MACKUP_PATH, ['restore', '-f']);
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
