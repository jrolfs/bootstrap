import { environment } from './configuration.ts';
import { pathExists } from './helpers.ts';

export const ensureNixDarwin = async () => {
  const darwinRebuildPath = '/run/current-system/sw/bin/darwin-rebuild';

  const installed = await pathExists(darwinRebuildPath);

  if (installed) {
    console.log('✓ nix-darwin already installed');
  } else {
    console.log('Installing nix-darwin...');
  }

  console.log('Rebuilding nix-darwin system...');

  const { DARWIN_INSTALLER: installer } = environment();

  const install = new Deno.Command(`${installer}/bin/darwin-installer`, {
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const { success } = await install.output();

  if (!success) throw new Error('Failed to install nix-darwin');
};
