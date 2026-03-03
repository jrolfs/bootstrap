import { environment } from './configuration.ts';
import { pathExists, shell } from './helpers.ts';

const darwinConfigPath = (home: string) =>
  `${home}/.nixpkgs/darwin-configuration.nix`;

export const ensureNixDarwin = async () => {
  const darwinRebuildPath = '/run/current-system/sw/bin/darwin-rebuild';
  const installed = await pathExists(darwinRebuildPath);

  if (installed) {
    console.log('✓ nix-darwin already installed');
  } else {
    console.log('Installing nix-darwin...');
  }

  console.log('Rebuilding nix-darwin system...');

  const { HOME } = environment();
  const darwinConfig = darwinConfigPath(HOME);

  if (!(await pathExists(darwinConfig))) {
    throw new Error(
      `darwin-configuration.nix not found at ${darwinConfig}. Ensure homeshick has linked your dotfiles.`,
    );
  }

  // nix-darwin has no separate installer; first darwin-rebuild switch installs it
  // Use full path: Nix run environment has a minimal PATH and does not include /usr/bin
  await shell('/usr/bin/sudo', [
    '-E',
    'nix',
    'run',
    'github:LnL7/nix-darwin#darwin-rebuild',
    '--',
    'switch',
    '-I',
    `darwin-config=${darwinConfig}`,
  ]);
};
