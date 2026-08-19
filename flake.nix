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

        # One binary, `bootstrap`, dispatching every subcommand — so nothing
        # generically-named lands on PATH. `gpg` in particular exists only as
        # `bootstrap secrets gpg`, where it cannot shadow the real one.
        #
        # Sudo is primed only for `provision`: it's the one subcommand that runs
        # a system activation, and `bootstrap secrets list` shouldn't prompt.
        #
        # `cd ${./src}` puts the CWD in the nix store, which is why the rebuild
        # invocation in src/nix.ts sets an explicit cwd: a bare `nix run` with no
        # attribute would otherwise resolve `.` to that store path.
        bootstrap = pkgs.writeScriptBin "bootstrap" ''
          #!${pkgs.bash}/bin/bash
          set -e

          if [ "$1" = "provision" ]; then
            # Cache sudo credentials, then keep them warm for the long
            # activation that follows.
            sudo -v
            (while true; do sudo -n true; sleep 60; kill -0 "$$" || exit; done 2>/dev/null) &
          fi

          export PATH=${runtimePath}

          # `cd` below throws away the directory the user ran from, which is
          # the only way to find their checkout — the store copy of `src/` has
          # no path back to it. src/manifest.ts walks up from here.
          export BOOTSTRAP_INVOCATION_DIR="$PWD"

          # Read-only fallback for `nix run github:…`, where there is no
          # checkout at all: mutating commands still refuse it, but the
          # `secrets gpg import` read path works with nothing cloned.
          export SECRETS_MANIFEST_STORE=${./secrets.json}

          cd ${./src}

          exec ${pkgs.deno}/bin/deno run \
            ${pkgs.lib.concatStringsSep " \\\n            " denoFlags} \
            cli.ts "$@"
        '';

        # Same flags, but running the *working tree* so edits take effect with no
        # rebuild. Deliberately does not `cd`: staying put is what lets
        # src/manifest.ts find the checkout.
        #
        # No sudo priming — `provision` from a dev shell drops into the same
        # `sudo -v` the phases perform themselves, just later.
        bootstrapDev = pkgs.writeShellScriptBin "bootstrap" ''
          root=$(${pkgs.git}/bin/git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")

          exec ${pkgs.deno}/bin/deno run \
            ${pkgs.lib.concatStringsSep " \\\n            " denoFlags} \
            "$root/src/cli.ts" "$@"
        '';

        provisionApp = {
          type = "app";
          program = "${pkgs.writeShellScript "bootstrap-provision" ''
            exec ${bootstrap}/bin/bootstrap provision "$@"
          ''}";
        };

      in
      {
        # Exposed as a package so the system flake can put it on PATH:
        #
        #   inputs.bootstrap.packages.${system}.bootstrap
        #
        # and runnable with no checkout at all via
        # `nix run github:jrolfs/bootstrap`, which is what breaks the
        # chicken-and-egg during migration. Reads work there off the store copy
        # of the manifest; mutating subcommands need a clone, since only a
        # working tree can be written back to git.
        packages = {
          inherit bootstrap;
          default = bootstrap;
        };

        # `nix develop` for working on the CLI. This `bootstrap` shadows the one
        # from the system closure — the point of being in this repo, since
        # otherwise you'd edit src/ and keep running the pinned revision.
        #
        # Safe to shadow under the same name now that the verb is mandatory:
        # bare `bootstrap` prints usage instead of rebuilding the system.
        devShells.default = pkgs.mkShell {
          packages = [ pkgs.deno bootstrapDev ];

          shellHook = ''
            echo "bootstrap dev shell: \`bootstrap\` runs ./src (shadows the installed one)"
          '';
        };

        apps = {
          # Supplies `provision` so the fresh-machine one-liner stays
          # `nix run github:jrolfs/bootstrap` — there's no checkout and nothing
          # on PATH at that point, so it's the one place a bare invocation
          # should mean "do the thing".
          bootstrap = provisionApp;
          default = provisionApp;

          # Escape hatch for every other subcommand with nothing installed, e.g.
          # `nix run github:jrolfs/bootstrap#cli -- secrets list`.
          cli = {
            type = "app";
            program = "${bootstrap}/bin/bootstrap";
          };
        };
      }
    );
}
