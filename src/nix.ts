import { environment } from './configuration.ts';
import { shell } from './helpers.ts';
import { bin } from './system.ts';

const NIX_CONFIG_DIR = '.config/system';

const flakeDir = (home: string): string => `${home}/${NIX_CONFIG_DIR}`;

const flakeTarget = (home: string, hostname: string): string =>
  `${flakeDir(home)}#${hostname}`;

const hasCommand = async (command: string): Promise<boolean> => {
  const result = await shell('/usr/bin/which', [command], { error: false });
  return result.success && result.stdout.trim().length > 0;
};

/**
 * Flake references used to bootstrap the platform's rebuild tool before it is
 * installed on PATH.
 *
 * The attribute is required, not optional: nix-darwin's flake exposes
 * `packages.<system>.darwin-rebuild` but no `apps.<system>`, so a bare
 * `nix run github:nix-darwin/nix-darwin` fails to resolve an installable and
 * falls back to the current directory — which for this bootstrap is the store
 * path of its own `src` (the flake app does `cd ${./src}`), producing
 * "installable '/nix/store/…-src' does not correspond to a Nix language value".
 */
const REBUILD_FLAKE = {
  darwin: 'github:nix-darwin/nix-darwin#darwin-rebuild',
  linux: 'github:NixOS/nixpkgs#nixos-rebuild',
} as const;

// Enable explicitly rather than relying on /etc/nix/nix.conf: `sudo` runs as
// root, whose nix config we don't control, and a flake ref is not even a valid
// installable without the `flakes` feature.
const EXPERIMENTAL = [
  '--extra-experimental-features',
  'nix-command flakes',
] as const;

/**
 * Rebuilds the system from the consolidated flake at `~/.config/system`.
 *
 * On the first run the platform's rebuild tool is not yet on PATH, so we
 * bootstrap it via `nix run`. On subsequent runs the rebuild tool installed
 * by the previous switch is used directly.
 *
 * The subprocess `cwd` is set to the flake directory so that any relative
 * resolution lands somewhere sane instead of the bootstrap's own store path.
 */
export const ensureSystemRebuild = async (): Promise<void> => {
  const { HOME, hostname } = environment();
  const target = flakeTarget(HOME, hostname);
  const cwd = flakeDir(HOME);
  const os = Deno.build.os;

  if (os !== 'darwin' && os !== 'linux') {
    throw new Error(`Unsupported operating system for system rebuild: ${os}`);
  }

  const installed = await hasCommand(
    os === 'darwin' ? 'darwin-rebuild' : 'nixos-rebuild',
  );

  if (installed) {
    const tool = os === 'darwin' ? 'darwin-rebuild' : 'nixos-rebuild';
    console.log(`✓ ${tool} on PATH; using installed binary`);

    await shell(
      bin.sudo,
      ['-E', tool, 'switch', '--flake', target, '--show-trace'],
      { cwd },
    );
    return;
  }

  console.log(`Bootstrapping ${REBUILD_FLAKE[os]} via \`nix run\`...`);

  await shell(
    bin.sudo,
    [
      '-E',
      'nix',
      ...EXPERIMENTAL,
      'run',
      REBUILD_FLAKE[os],
      '--',
      'switch',
      '--flake',
      target,
      '--show-trace',
    ],
    { cwd },
  );
};
