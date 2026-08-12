import { environment } from './configuration.ts';
import { shell } from './helpers.ts';

const NIX_CONFIG_DIR = '.config/system';

const flakeTarget = (home: string, hostname: string): string =>
  `${home}/${NIX_CONFIG_DIR}#${hostname}`;

const hasCommand = async (command: string): Promise<boolean> => {
  const result = await shell('/usr/bin/which', [command], { error: false });
  return result.success && result.stdout.trim().length > 0;
};

/**
 * Rebuilds the system from the consolidated flake at `~/.config/system`.
 *
 * On the first run the platform's rebuild tool is not yet on PATH, so we
 * bootstrap it via `nix run`. On subsequent runs the rebuild tool installed
 * by the previous switch is used directly.
 */
export const ensureSystemRebuild = async (): Promise<void> => {
  const { HOME, hostname } = environment();
  const target = flakeTarget(HOME, hostname);
  const os = Deno.build.os;

  if (os === 'darwin') {
    const installed = await hasCommand('darwin-rebuild');

    if (installed) {
      console.log('✓ darwin-rebuild on PATH; using installed binary');
      await shell('/usr/bin/sudo', [
        '-E',
        'darwin-rebuild',
        'switch',
        '--flake',
        target,
        '--show-trace',
      ]);
      return;
    }

    console.log('Bootstrapping nix-darwin via `nix run`...');
    await shell('/usr/bin/sudo', [
      '-E',
      'nix',
      'run',
      'github:nix-darwin/nix-darwin',
      '--',
      'switch',
      '--flake',
      target,
      '--show-trace',
    ]);
    return;
  }

  if (os === 'linux') {
    const installed = await hasCommand('nixos-rebuild');

    if (installed) {
      console.log('✓ nixos-rebuild on PATH; using installed binary');
      await shell('/usr/bin/sudo', [
        '-E',
        'nixos-rebuild',
        'switch',
        '--flake',
        target,
        '--show-trace',
      ]);
      return;
    }

    console.log('Bootstrapping NixOS via `nix run`...');
    await shell('/usr/bin/sudo', [
      '-E',
      'nix',
      'run',
      'github:NixOS/nixpkgs#nixos-rebuild',
      '--',
      'switch',
      '--flake',
      target,
      '--show-trace',
    ]);
    return;
  }

  throw new Error(`Unsupported operating system for system rebuild: ${os}`);
};
