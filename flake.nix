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

        bootstrap = pkgs: pkgs.writeScriptBin "bootstrap" ''
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
          default = bootstrap pkgs;
        };

        src = ./src;

        apps = {
          bootstrap = {
            type = "app";
            program = "${bootstrap pkgs}/bin/bootstrap";
          };
        };
      }
    );
}
