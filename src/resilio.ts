import { blue, bold, gray } from 'https://deno.land/std@0.192.0/fmt/colors.ts';

import { configuration, environment } from './configuration.ts';
import { pathExists, shell } from './helpers.ts';
import { bin, requireBrewBinary } from './system.ts';

const RESILIO_APP_PATH = '/Applications/Resilio Sync.app';

const expandHome = (home: string, candidate: string): string =>
  candidate.startsWith('~/') ? `${home}/${candidate.slice(2)}` : candidate;

/**
 * Installs the Resilio Sync cask via Homebrew if it is not already present.
 *
 * The cask is also declared in the nix-config Homebrew set, but bootstrap runs
 * before nix-darwin is activated so we install it eagerly here.
 *
 * macOS only *by implementation*, not because Resilio is macOS-only: on NixOS
 * the daemon and its shares are declared with `services.resilio`
 * (`enable` + `sharedFolders`). Note the headless `rslsync` daemon is also the
 * only thing that reads a `sync.conf`/JSON config — the macOS GUI app keeps its
 * state in SQLite databases under its Application Support directory, so there
 * is nothing to pre-seed here. See MIGRATION.md (phase 2).
 */
const ensureResilioInstalled = async (): Promise<void> => {
  if (Deno.build.os !== 'darwin') {
    console.log(
      'Skipping Resilio install on non-darwin host (NixOS uses services.resilio)',
    );
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
 * Installs Resilio Sync and walks the user through linking this machine to
 * their Resilio *identity*, which brings all of the identity's shares with it.
 *
 * This step is deliberately manual. Linking a device to an identity is a
 * pairing operation that requires approval from an already-linked device — by
 * design, there's no key or config file to plant, and the consumer app exposes
 * no CLI for it. (Cloning another device's Application Support directory would
 * duplicate the device identity and cause peer conflicts, so that's not a
 * supportable shortcut.)
 *
 * Adding individual shares by secret is the older mechanism and is not used
 * here: with an identity, shares arrive automatically once the device is
 * linked.
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

  // Foreground launch so the user can complete first-run and device linking.
  console.log('Launching Resilio Sync...');
  await shell(bin.open, [RESILIO_APP_PATH], { error: false });

  const wrap = 80;
  console.log(
    '\n\n',
    `📁 ${bold('Resilio Sync — link this device to your identity')}\n`,
    blue('‾'.repeat(wrap)),
    '\n',
    gray(
      ' Resilio just opened. Accept the EULA if prompted, then link this\n' +
        ' machine to your existing identity rather than creating a new one:\n' +
        '\n' +
        '   1. Choose to link/connect with an existing identity (during\n' +
        '      first-run setup, or Preferences -> Identity afterwards).\n' +
        '   2. Approve the request from an already-linked device.\n' +
        '   3. Once linked, the identity\'s shares appear automatically —\n' +
        `      including the one that syncs ${sharePath}.\n`,
    ),
  );

  // Pause until the user confirms. `prompt` returns null on non-interactive
  // stdin, which is fine — waitForResilioSync then polls for the sentinel.
  prompt('\n Press Enter once this device is linked and shares are syncing…');
};

/**
 * Waits for the configuration share to finish its initial sync.
 *
 * Bootstrap should not run `mackup restore` until `~/Configuration/mackup/`
 * exists, which is the signal we look for here.
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
      'check that this device is linked to the identity and that the share ' +
      'is syncing, then re-run bootstrap.',
  );
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
