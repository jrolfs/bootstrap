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

          exec ${pkgs.deno}/bin/deno run \
            --allow-run \
            --allow-env \
            --allow-read \
            --allow-write \
            --allow-net \
            ${./bootstrap.ts}
        '';

      in
      {
        packages = {
          inherit bootstrap;
          default = bootstrap;
        };
      }
    );
}