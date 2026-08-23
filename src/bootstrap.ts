import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';

import { configuration, environment, setHostname } from './configuration.ts';
import { uploadGitHubKey } from './github.ts';
import { pathExists, shell } from './helpers.ts';
import { importGpgKeys } from './gpg.ts';
import { ensureHostname } from './hostname.ts';
import { ensureSystemRebuild } from './nix.ts';
import { ensureOpAuthenticated, ensureOpInstalled } from './onepassword.ts';
import {
  configureResilio,
  restoreMackup,
  waitForResilioSync,
} from './resilio.ts';
import { materializeSecrets } from './secrets.ts';
import { hasPhase, loadState, recordPhase, runPhase } from './state.ts';
import type { State } from './schemas.ts';

const NIX_CONFIG_DIR_REL = '.config/system';
const VSCODE_SYNC_DIR_REL = '.config/vscode-sync-settings';

const isDarwin = (): boolean => Deno.build.os === 'darwin';

const ensureHomebrew = async (): Promise<void> => {
  if (!isDarwin()) {
    console.log('Skipping Homebrew install on non-darwin host');
    return;
  }

  if (await pathExists('/opt/homebrew')) {
    console.log('✓ Homebrew already installed');
    return;
  }

  console.log('Installing Homebrew...');

  const { stdout: bashPath } = await shell('which', ['bash']);
  if (!bashPath) throw new Error('Could not find bash executable');

  const response = await fetch(
    'https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh',
  );

  const installScript = await response.text();

  const command = new Deno.Command(bashPath.trim(), {
    args: ['-c', installScript],
    env: {
      ...Deno.env.toObject(),
      NONINTERACTIVE: '1',
    },
    stdin: 'null',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const { success } = await command.output();

  if (!success) throw new Error('Homebrew installation failed');

  console.log('Homebrew installation complete.');
};

const setupSSHKey = async (): Promise<void> => {
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

const addKnownHosts = async (): Promise<void> => {
  const { HOME } = environment();
  const knownHostsPath = `${HOME}/.ssh/known_hosts`;

  await Deno.mkdir(`${HOME}/.ssh`, { recursive: true });

  const knownHosts = await Deno.readTextFile(knownHostsPath).catch(() => '');

  for (const host of configuration.knownHosts) {
    if (knownHosts.includes(host)) {
      console.log(`✓ ${host} already in known_hosts`);
      continue;
    }

    console.log(`Adding ${host} to known_hosts...`);
    const { stdout } = await shell('ssh-keyscan', [host]);
    await Deno.writeTextFile(knownHostsPath, stdout, { append: true });
  }
};

/**
 * Clones (or updates) a git repository to a target path.
 *
 * If `path` already exists, runs `git pull`. Otherwise clones from `url`.
 * When `branch` is provided, the clone is pinned to that branch.
 */
const cloneOrUpdate = async (
  url: string,
  path: string,
  branch?: string,
): Promise<void> => {
  if (await pathExists(path)) {
    console.log(`✓ ${path} already cloned; pulling`);
    await shell('git', ['-C', path, 'pull', '--ff-only']);
    return;
  }

  console.log(`Cloning ${url} -> ${path}...`);
  const args = ['clone'];
  if (branch) args.push('--branch', branch);
  args.push(url, path);
  await shell('git', args);
};

const cloneNixConfig = async (): Promise<void> => {
  const { HOME } = environment();
  const target = `${HOME}/${NIX_CONFIG_DIR_REL}`;
  await cloneOrUpdate(
    configuration.nixConfigRepo,
    target,
    configuration.nixConfigBranch,
  );
};

const cloneVscodeSync = async (): Promise<void> => {
  const repo = configuration.vscodeSyncRepo;
  if (!repo) {
    console.log('No vscodeSyncRepo configured; skipping');
    return;
  }
  const { HOME } = environment();
  const target = `${HOME}/${VSCODE_SYNC_DIR_REL}`;
  await cloneOrUpdate(repo, target);
};

const setupHomeshickAndPrivate = async (): Promise<void> => {
  const { HOME } = environment();
  const homeshickPath = `${HOME}/.homesick/repos/homeshick`;

  if (await pathExists(homeshickPath)) {
    console.log('✓ homeshick already installed');
  } else {
    console.log('Installing homeshick...');
    await shell('git', [
      'clone',
      configuration.homeshick.remote,
      homeshickPath,
    ]);
  }

  const privatePath = `${HOME}/.homesick/repos/private`;

  if (await pathExists(privatePath)) {
    console.log('✓ private castle already cloned; pulling');
    await shell('git', ['-C', privatePath, 'pull', '--ff-only']);
  } else {
    console.log('Cloning private castle...');
    const homeshick = `source ${homeshickPath}/homeshick.sh && homeshick`;
    await shell('bash', [
      '-c',
      `${homeshick} clone -b ${configuration.privateCastleRepo}`,
    ]);
  }

  console.log('Linking private castle...');
  const homeshick = `source ${homeshickPath}/homeshick.sh && homeshick`;
  await shell('bash', ['-c', `${homeshick} link --force private`]);
};

export const bootstrap = async (): Promise<void> => {
  try {
    environment();

    let state: State = await loadState();

    // Confirm/set the hostname first — the flake selects its host config by
    // hostname, so everything downstream (SSH key comment, the flake selector)
    // depends on it being correct. The chosen name is persisted to state and
    // injected into the memoized environment; on a re-run we skip the prompt
    // but still re-inject so the selector uses the confirmed value.
    if (hasPhase(state, 'hostname-set')) {
      if (state.hostname) setHostname(state.hostname);
      console.log(`✓ hostname ${state.hostname ?? '(unset)'} (cached)`);
    } else {
      const hostname = await ensureHostname();
      setHostname(hostname);
      state = { ...state, hostname };
      state = await recordPhase(state, 'hostname-set');
    }

    // Nix is installed by bootstrap.sh; record that fact so future phases can
    // reason about it. Re-running bootstrap.sh is itself idempotent, so we
    // record this unconditionally on every run.
    state = await runPhase(
      state,
      'nix-installed',
      'Nix installation recorded',
      async () => {
        await Promise.resolve();
      },
    );

    state = await runPhase(
      state,
      'github-authed',
      'GitHub authentication + SSH key upload',
      async () => {
        await setupSSHKey();
      },
    );

    // `setupSSHKey` performs both key generation and upload; we capture both
    // under a single subsequent phase so re-runs after partial failure still
    // resolve to the same point. Separate phase here is a placeholder for
    // future granularity.
    state = await runPhase(
      state,
      'ssh-key-uploaded',
      'SSH key upload sentinel',
      async () => {
        await Promise.resolve();
      },
    );

    state = await runPhase(state, 'homebrew-installed', 'Homebrew', async () => {
      await ensureHomebrew();
    });

    // 1Password install + authentication run on darwin only. Linux has no
    // compelling NUC use case for `op` yet (no Resilio there either); these
    // phases are skipped via the `isDarwin()` gate. If `op` becomes useful
    // on Linux later, drop the gate and Linux will pick it up automatically.
    if (isDarwin()) {
      state = await runPhase(
        state,
        'op-installed',
        '1Password GUI + CLI install',
        async () => {
          await ensureOpInstalled();
        },
      );

      state = await runPhase(
        state,
        'op-authenticated',
        '1Password CLI authorized (`op vault list`)',
        async () => {
          await ensureOpAuthenticated();
        },
      );
    }

    await addKnownHosts();

    state = await runPhase(
      state,
      'private-cloned',
      'Private castle clone + link',
      async () => {
        await setupHomeshickAndPrivate();
      },
    );

    state = await runPhase(
      state,
      'nix-config-cloned',
      'Nix configuration clone',
      async () => {
        await cloneNixConfig();
      },
    );

    state = await runPhase(
      state,
      'vscode-sync-cloned',
      'VSCode sync settings clone',
      async () => {
        await cloneVscodeSync();
      },
    );

    state = await runPhase(
      state,
      'resilio-configured',
      'Resilio Sync configured',
      async () => {
        await configureResilio();
      },
    );

    // Wait for the configuration share to sync before the first system rebuild.
    // The rebuild itself may rely on mackup-restored prefs; first switch should
    // not run blind. No-op if Resilio is disabled.
    await waitForResilioSync();

    // Before the switch: `brew bundle` runs inside activation and clones the
    // private meterup tap, which needs ~/.git-credentials already on disk.
    // Darwin-only for the same reason the `op` phases are — nothing installs
    // `op` on Linux yet, and there are no Linux targets in the manifest.
    state = await runPhase(
      state,
      'secrets-materialized',
      'Manifest secrets written to disk',
      async () => {
        if (!isDarwin()) {
          console.log('Skipping secret materialization on non-darwin host');
          return;
        }

        await materializeSecrets();
      },
    );

    state = await runPhase(
      state,
      'first-switch-completed',
      'First darwin-rebuild/nixos-rebuild switch',
      async () => {
        await ensureSystemRebuild();
      },
    );

    // After the switch, not before: `gpg` itself is installed by the switch, and
    // home-manager is what creates `~/.gnupg`. Running earlier meant the import
    // always hit the "`gpg` not found" path on a fresh machine. Needs `op`
    // authenticated too, which an earlier phase handles.
    state = await runPhase(
      state,
      'gpg-imported',
      'GPG secret key + ownertrust import',
      () => importGpgKeys(),
    );

    // mackup restore runs after the switch — mackup is installed by the switch,
    // and the ~/Configuration/mackup store must have synced. Confirmed +
    // best-effort; no-op if either isn't ready (run `mkrs` later).
    state = await runPhase(
      state,
      'mackup-restored',
      'mackup restore from ~/Configuration',
      async () => {
        await restoreMackup();
      },
    );

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

// Kept so `deno run src/bootstrap.ts` still works when iterating on the phases
// directly. The shipped path is `bootstrap provision` via src/cli.ts.
if (import.meta.main) {
  bootstrap();
}
