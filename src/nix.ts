import { environment } from './configuration.ts';
import { pathExists } from './helpers.ts';

export const ensureNixDarwin = async () => {
  const darwinRebuildPath = '/run/current-system/sw/bin/darwin-rebuild';

  if (await pathExists(darwinRebuildPath)) {
    console.log('✓ nix-darwin already installed');
    return;
  }

  console.log('Installing nix-darwin...');

  const { DARWIN_INSTALLER: installer } = environment();

  const install = new Deno.Command(`${installer}/bin/darwin-installer`, {
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const { success } = await install.output();

  if (!success) throw new Error('Failed to install nix-darwin');
};

export const buildNixDarwin = async () => {
  const darwinRebuildPath = '/run/current-system/sw/bin/darwin-rebuild';

  if (!await pathExists(darwinRebuildPath)) {
    throw new Error(
      'darwin-rebuild not found, please ensure nix-darwin is installed',
    );
  }

  console.log('Rebuilding nix-darwin system...');
  const rebuild = new Deno.Command(darwinRebuildPath, {
    args: ['switch'],
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const { success } = await rebuild.output();

  if (!success) throw new Error('Failed to rebuild system');
};
