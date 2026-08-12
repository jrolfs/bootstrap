import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';

import { configuration, environment } from './configuration.ts';
import { uploadGitHubKey } from './github.ts';
import { pathExists, shell } from './helpers.ts';
import { ensureSystemRebuild } from './nix.ts';
import { ensureOpAuthenticated, ensureOpInstalled } from './onepassword.ts';
import { configureResilio, waitForResilioSync } from './resilio.ts';
import { loadState, runPhase } from './state.ts';
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

const bootstrap = async (): Promise<void> => {
  try {
    environment();

    let state: State = await loadState();

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
        '1Password CLI authenticated (`op whoami`)',
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

    state = await runPhase(
      state,
      'first-switch-completed',
      'First darwin-rebuild/nixos-rebuild switch',
      async () => {
        await ensureSystemRebuild();
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

if (import.meta.main) {
  bootstrap();
}
