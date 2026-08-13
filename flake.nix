{
  description = "Bootstrap configuration";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils, ... }@inputs:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # macOS system tools live outside this PATH on purpose — anything not
        # listed here must be invoked by absolute path (see src/system.ts).
        runtimePath = pkgs.lib.makeBinPath [
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
        ];

        denoFlags = [
          "--allow-env"
          "--allow-net"
          "--allow-read"
          "--allow-run"
          "--allow-sys"
          "--allow-write"
        ];

        # Both entry points share the same runtime PATH and deno permissions and
        # differ only in module — and, for bootstrap, in priming sudo up front.
        #
        # `cd ${./src}` puts the CWD in the nix store, which is why the rebuild
        # invocation in src/nix.ts sets an explicit cwd: a bare `nix run` with no
        # attribute would otherwise resolve `.` to that store path.
        entry = { name, module, primeSudo ? false }:
          pkgs.writeScriptBin name ''
            #!${pkgs.bash}/bin/bash
            set -e

            ${pkgs.lib.optionalString primeSudo ''
              # Cache sudo credentials, then keep them warm for the long
              # activation that follows.
              sudo -v
              (while true; do sudo -n true; sleep 60; kill -0 "$$" || exit; done 2>/dev/null) &
            ''}

            export PATH=${runtimePath}

            cd ${./src}

            exec ${pkgs.deno}/bin/deno run \
              ${pkgs.lib.concatStringsSep " \\\n              " denoFlags} \
              ${module} "$@"
          '';

        bootstrap = entry {
          name = "bootstrap";
          module = "bootstrap.ts";
          primeSudo = true;
        };

        # Exposed as a package so the system flake can put it on PATH:
        #
        #   inputs.bootstrap.packages.${system}.secrets
        #
        # and runnable with no checkout at all via
        # `nix run github:jrolfs/bootstrap#secrets`, which is what breaks the
        # chicken-and-egg during migration. Note mutating subcommands need a
        # writable checkout (`nix run .#secrets`) since the manifest ships in
        # the store copy.
        secrets = entry {
          name = "secrets";
          module = "secrets.ts";
        };

      in
      {
        packages = {
          inherit bootstrap secrets;
          default = bootstrap;
        };

        src = ./src;

        apps = {
          bootstrap = {
            type = "app";
            program = "${bootstrap}/bin/bootstrap";
          };
          secrets = {
            type = "app";
            program = "${secrets}/bin/secrets";
          };
          default = {
            type = "app";
            program = "${bootstrap}/bin/bootstrap";
          };
        };
      }
    );
}
