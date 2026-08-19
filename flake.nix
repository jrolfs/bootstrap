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

            # `cd` below throws away the directory the user ran from, which is
            # the only way to find their checkout — the store copy of `src/` has
            # no path back to it. src/manifest.ts walks up from here.
            export BOOTSTRAP_INVOCATION_DIR="$PWD"

            # Read-only fallback for `nix run github:…#secrets`, where there is
            # no checkout at all: mutating commands still refuse it, but the
            # `gpg import` read path works with nothing cloned.
            export SECRETS_MANIFEST_STORE=${./secrets.json}

            cd ${./src}

            exec ${pkgs.deno}/bin/deno run \
              ${pkgs.lib.concatStringsSep " \\\n              " denoFlags} \
              ${module} "$@"
          '';

        # Same flags as `entry`, but running the *working tree* instead of the
        # store copy, so edits take effect with no rebuild. Deliberately does not
        # `cd`: staying put is what lets src/manifest.ts find the checkout.
        devEntry = { name, module }:
          pkgs.writeShellScriptBin name ''
            root=$(${pkgs.git}/bin/git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")

            exec ${pkgs.deno}/bin/deno run \
              ${pkgs.lib.concatStringsSep " \\\n              " denoFlags} \
              "$root/src/${module}" "$@"
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
        # chicken-and-egg during migration. Reads work there off the store copy
        # of the manifest; mutating subcommands need `nix run .#secrets` from a
        # clone, since only a working tree can be written back to git.
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

        # `nix develop` for working on the CLI. `secrets` here shadows the
        # system-wide one from the system flake — which is the point of being in
        # this repo, since otherwise you'd edit src/ and keep running the pinned
        # revision.
        #
        # The bootstrap entry point is *not* shadowed and is renamed: it primes
        # sudo and rebuilds the system, so it shouldn't be one typo away.
        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.deno
            (devEntry { name = "secrets"; module = "secrets.ts"; })
            (devEntry { name = "bootstrap-dev"; module = "bootstrap.ts"; })
          ];

          shellHook = ''
            echo "bootstrap dev shell: \`secrets\` runs ./src (shadows the installed one)"
            echo "                     \`bootstrap-dev\` runs the full bootstrap — it rebuilds the system"
          '';
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
