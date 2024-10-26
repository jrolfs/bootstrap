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
          export PATH=${pkgs.lib.makeBinPath [
            pkgs.deno
            pkgs.curl
            pkgs.git
            pkgs.openssh
            pkgs.coreutils
          ]}

          # Change to the directory containing the script and other files
          cd ${./src}

          exec ${pkgs.deno}/bin/deno run \
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
          default = bootstrap;
        };

        src = ./src;
      }
    );
}
