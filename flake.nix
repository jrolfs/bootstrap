{
  description = "Bootstrap configuration";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    darwin = {
      url = "github:LnL7/nix-darwin";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, darwin, ... }@inputs:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        darwinInstaller = pkgs.writeScriptBin "darwin-installer" ''
          #!${pkgs.bash}/bin/bash
          set -e
          
          INSTALLER_RESULT=$(mktemp -d)
          cd "$INSTALLER_RESULT"
          
          # Build the installer in the temp directory
          nix-build https://github.com/LnL7/nix-darwin/archive/master.tar.gz -A darwin-rebuild
          
          # Run the installer
          ./result/bin/darwin-rebuild switch --show-trace
          
          # Clean up
          rm -rf "$INSTALLER_RESULT"
        '';

        bootstrap = pkgs: darwinInstaller: pkgs.writeScriptBin "bootstrap" ''
          #!${pkgs.bash}/bin/bash
          set -e

          # Cache sudo credentials
          sudo -v

          # Keep sudo credentials fresh
          (while true; do sudo -n true; sleep 60; kill -0 "$$" || exit; done 2>/dev/null) &

          export PATH=${pkgs.lib.makeBinPath [
            pkgs.bash
            pkgs.coreutils
            pkgs.curl
            pkgs.deno
            pkgs.findutils
            pkgs.git
            pkgs.git-lfs
            pkgs.gnused
            pkgs.nix
            pkgs.openssh
            pkgs.which
          ]}

          # Make the darwin installer available to the bootstrap script
          export DARWIN_INSTALLER="${darwinInstaller}"
          export NIX_MACOS_EXCLUDE_CASKS="1password,firefox,google-chrome,slack,Xcode,zoom"

          cd ${./src}

          ${pkgs.deno}/bin/deno run \
            --allow-env \
            --allow-net \
            --allow-read \
            --allow-run \
            --allow-sys \
            --allow-write \
            bootstrap.ts
        '';

      in
      {
        packages = {
          inherit bootstrap;
          default = bootstrap pkgs darwinInstaller;
        };

        src = ./src;

        apps = {
          bootstrap = {
            type = "app";
            program = "${bootstrap pkgs darwinInstaller}/bin/bootstrap";
          };
        };
      }
    );
}
