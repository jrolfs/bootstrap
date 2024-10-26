{
  description = "Bootstrap configuration";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        bootstrap = pkgs.writeScriptBin "bootstrap" ''
          #!${pkgs.bash}/bin/bash
          set -e
          export PATH=${pkgs.lib.makeBinPath [
            pkgs.bash
            pkgs.coreutils
            pkgs.curl
            pkgs.deno
            pkgs.git
            pkgs.nix
            pkgs.openssh
          ]}

          # Change to the directory containing the script and other files
          cd ${./src}

          # Run the bootstrap script
          ${pkgs.deno}/bin/deno run \
            --allow-env \
            --allow-net \
            --allow-read \
            --allow-run \
            --allow-sys \
            --allow-write \
            bootstrap.ts

          # Check if nix-darwin is installed
          if [ ! -f /run/current-system/sw/bin/darwin-rebuild ]; then
            echo "nix-darwin is not installed. Installing..."
            ${pkgs.nix}/bin/nix-build https://github.com/LnL7/nix-darwin/archive/master.tar.gz -A installer
            ./result/bin/darwin-installer
          else
            echo "nix-darwin is already installed."
          fi

          # Rebuild the system using the non-flake configuration
          if [ -f /run/current-system/sw/bin/darwin-rebuild ]; then
            echo "Rebuilding the system..."
            /run/current-system/sw/bin/darwin-rebuild switch
          else
            echo "Error: darwin-rebuild not found after installation attempt."
            exit 1
          fi
        '';

      in
      {
        packages = {
          inherit bootstrap;
          default = bootstrap;
        };

        src = ./src;
      }
    );
}
