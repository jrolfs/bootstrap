import { pathExists } from './helpers.ts';

export const ensureNixDarwin = async () => {
  const darwinRebuildPath = "/run/current-system/sw/bin/darwin-rebuild";
  
  if (await pathExists(darwinRebuildPath)) {
    console.log('✓ nix-darwin already installed');
    return;
  }

  console.log("Installing nix-darwin...");

  const installer = new Deno.Command("nix-build", {
    args: ["https://github.com/LnL7/nix-darwin/archive/master.tar.gz", "-A", "installer"],
    stdout: 'inherit',
    stderr: 'inherit',
  });
  
  const { success: installerSuccess } = await installer.output();
  if (!installerSuccess) {
    throw new Error("Failed to build nix-darwin installer");
  }

  const install = new Deno.Command("./result/bin/darwin-installer", {
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const { success: installSuccess } = await install.output();

  if (!installSuccess) throw new Error("Failed to install nix-darwin");
};

export const buildNixDarwin = async () => {
  const darwinRebuildPath = "/run/current-system/sw/bin/darwin-rebuild";
  
  if (!await pathExists(darwinRebuildPath)) {
    throw new Error("darwin-rebuild not found, please ensure nix-darwin is installed");
  }

  console.log("Rebuilding nix-darwin system...");
  const rebuild = new Deno.Command(darwinRebuildPath, {
    args: ["switch"],
    stdout: 'inherit',
    stderr: 'inherit',
  });
  
  const { success } = await rebuild.output();

  if (!success) throw new Error("Failed to rebuild system");
};
