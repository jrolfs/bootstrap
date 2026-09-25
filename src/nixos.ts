import { configuration } from './configuration.ts';
import { pathExists, shell } from './helpers.ts';

/**
 * Installing NixOS onto the machine that is running this bootstrap.
 *
 * There is no NixOS equivalent of the macOS path's "install Nix onto the
 * existing OS": on NixOS the OS *is* a closure, so the install has to happen
 * from outside it. The outside, here, is the official installer image — an
 * ordinary NixOS running entirely in RAM, with a Nix store and a network. Given
 * those, the machine can install itself, and no second machine has to be
 * involved the way `nixos-anywhere` would require.
 *
 * So the bootstrap runs twice against one machine: once from the installer,
 * where it partitions the disk and writes the system closure to it, and again
 * after the reboot, where it picks up the user-level phases that every platform
 * shares.
 */

/** Marker present on any NixOS, installed or live. */
const NIXOS_MARKER = '/etc/NIXOS';

/**
 * Where the installer image mounts its read-only squashfs store, which an
 * installed system never has. Declared by nixpkgs in
 * `nixos/modules/installer/cd-dvd/iso-image.nix`, and the one difference
 * between the two that is both stable and cheap to test.
 */
const INSTALLER_STORE = '/nix/.ro-store';

/** Where disko leaves the formatted filesystems, and where nixos-install writes. */
const TARGET_ROOT = '/mnt';

export const isNixos = (): Promise<boolean> => pathExists(NIXOS_MARKER);

/**
 * Whether this is running from NixOS installer media rather than an installed
 * system.
 *
 * Guards the destructive phases structurally rather than by recorded state: the
 * partition step cannot run on a machine that has already been installed,
 * because such a machine has no read-only store to find. A stale
 * `state.json` therefore can't replay a disk wipe.
 */
export const isNixosInstaller = async (): Promise<boolean> =>
  (await isNixos()) && (await pathExists(INSTALLER_STORE));

/**
 * Flake reference for the system configuration, in `github:` form.
 *
 * The configured repository is an SSH URL, which is right everywhere else and
 * wrong here: the installer has no key, no `~/.gitconfig` to rewrite the URL,
 * and no credential helper. The repositories are public, so the installer can
 * fetch over the `github:` fetcher without authenticating at all — which is
 * what keeps GitHub sign-in out of this stage entirely.
 */
const systemFlake = (): string => {
  const { nixConfigRepo, nixConfigBranch } = configuration;
  const match = nixConfigRepo.match(
    /github\.com[:/](?<owner>[^/]+)\/(?<repository>[^/]+?)(\.git)?$/,
  );

  if (!match?.groups) {
    throw new Error(`cannot derive a flake reference from ${nixConfigRepo}`);
  }

  const { owner, repository } = match.groups;

  return `github:${owner}/${repository}/${nixConfigBranch}`;
};

/**
 * Nix on the installer has neither flakes nor `nix-command` enabled — the
 * settings that turn them on live in the configuration we are here to install.
 */
const NIX_FEATURES = ['--extra-experimental-features', 'nix-command flakes'];

const asRoot = (command: string, args: readonly string[]) =>
  Deno.uid() === 0
    ? { command, args: [...args] }
    : { command: 'sudo', args: [command, ...args] };

/**
 * Partitions, formats and mounts the target disk according to the host's disko
 * configuration, leaving the result mounted at `/mnt`.
 *
 * **This destroys everything on the configured device.** The device is named in
 * the host's `disko.nix` rather than discovered, so the blast radius is
 * reviewable in the repository instead of depending on what the kernel happened
 * to enumerate first.
 *
 * Runs the `diskoScript` built from the *pinned* disko in the system flake's
 * lock file, rather than `nix run github:nix-community/disko`, so the tool that
 * formats the disk is the same one the configuration was written against.
 */
export const partitionDisks = async (hostname: string): Promise<void> => {
  const flake = systemFlake();

  const built = await shell('nix', [
    'build',
    ...NIX_FEATURES,
    '--no-link',
    '--print-out-paths',
    `${flake}#nixosConfigurations.${hostname}.config.system.build.diskoScript`,
  ]);

  const script = built.stdout.trim();

  if (!script) throw new Error('disko produced no script to run');

  const { command, args } = asRoot(script, []);

  await shell(command, args, { stream: true });
};

/**
 * Installs the host's system closure onto the disks mounted at `/mnt`.
 *
 * Prompts for a root password at the end, which is `nixos-install`'s own
 * behaviour and worth keeping: it is the rescue path if the user account's
 * password (declared in the host configuration) ever fails to let you in.
 */
export const installSystem = async (hostname: string): Promise<void> => {
  const flake = systemFlake();

  const { command, args } = asRoot('nixos-install', [
    '--flake',
    `${flake}#${hostname}`,
    '--root',
    TARGET_ROOT,
    // The installer's channels are irrelevant to a flake-configured system and
    // copying them only slows the install down.
    '--no-channel-copy',
  ]);

  await shell(command, args, { stream: true });
};
