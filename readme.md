# Bootstrap

Provisions a fresh machine onto the flake-based nix configuration
(`~/.config/system`, the consolidated `jrolfs/macos` repo). Works on macOS
(nix-darwin) and NixOS/Linux — platform-specific steps are gated on the OS.

Two stages: a small bash entry point (`bootstrap.sh`) installs Lix and clones
this repo, then a Deno/TypeScript app (`src/`) runs an ordered, **resumable**
set of phases. State lives in `~/.bootstrap/state.json`; re-running the command
skips completed phases, so a failed step can be fixed and resumed.

## Usage

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/jrolfs/bootstrap/main/bootstrap.sh)"
```

`BOOTSTRAP_REF` selects which branch of this repo to run (default `main`). While
the flake migration is unmerged, run the migration branch:

```bash
BOOTSTRAP_REF=flake-migration bash -c "$(curl -fsSL \
  https://raw.githubusercontent.com/jrolfs/bootstrap/flake-migration/bootstrap.sh)"
```

## What it does

1. **Command Line Tools + Lix** — installs the Xcode CLT (macOS) and Lix.
2. **hostname-set** — confirms/sets the hostname *first*; the flake selects its
   host config by hostname (`~/.config/system#<hostname>`). macOS sets HostName
   + LocalHostName + ComputerName and flushes DNS; Linux uses `hostnamectl`.
3. **github-authed** — GitHub device-flow auth; generates an SSH key and uploads
   it (no secrets to handle — just follow the browser prompt).
4. **homebrew + 1Password** (macOS) — installs Homebrew, the 1Password GUI + CLI,
   and authenticates `op` (enable the GUI's CLI integration when prompted).
5. **clones** — the consolidated nix config → `~/.config/system`, the `private`
   homeshick castle (the only castle still linked), and the VS Code/Cursor
   settings-sync repo.
6. **resilio-configured** (macOS) — installs Resilio Sync, seeds the config
   share (secret via `op`), and guides first-run + adding the `~/Configuration`
   share, then waits for it to sync.
7. **gpg-imported** — imports every GPG keyring this host is entitled to from
   1Password, along with its ownertrust (see below).
8. **first switch** — `darwin-rebuild` / `nixos-rebuild switch --flake
   ~/.config/system#<hostname>` (bootstrapped via `nix run` on the first run).
9. **mackup-restored** (macOS) — confirmed `mackup restore` from the synced
   `~/Configuration/mackup`.

After the first switch on macOS: grant Full Disk Access to
`/usr/local/bin/icon-customizer` (System Settings → Privacy & Security).

## The `bootstrap` command

The system flake puts a single `bootstrap` binary on `PATH` (via
`inputs.bootstrap.packages.${system}.bootstrap`), so a provisioned machine can
manage its own secrets with no checkout:

```bash
bootstrap provision          # run every phase (idempotent; resumes)
bootstrap secrets list       # what's in the manifest, and which apply here
bootstrap secrets check      # verify every op:// reference resolves
bootstrap secrets materialize
bootstrap secrets gpg import
bootstrap help
```

Everything is a subcommand of one binary rather than several binaries, so
nothing generically named lands on `PATH` — `gpg` exists only as `bootstrap
secrets gpg` and can never shadow the real one. That also makes bare `bootstrap`
print usage instead of provisioning; the verb is always required.

With nothing installed yet, `nix run github:jrolfs/bootstrap` still provisions —
the flake app supplies `provision` for exactly that case. Reach the other
subcommands with `nix run github:jrolfs/bootstrap#cli -- secrets list`.

Mutating subcommands (`secrets add`, `secrets gpg export`) need a writable
checkout, since only a working tree can be committed back to git.

## Development

```bash
direnv allow   # or: nix develop
```

The dev shell puts a `bootstrap` on `PATH` that runs the *working tree*, so it
shadows the installed one and edits take effect with no rebuild.

```bash
deno check src/*.ts
deno lint src
```

## Configuration

Configuration lives in `src/configuration.ts` (schemas in `src/schemas.ts`):
the nix config + private + vscode-sync repo URLs and branch, 1Password vault,
and the Resilio share settings (secret source defaults to 1Password, with a
`private-castle` fallback). Authentication uses GitHub's Device Flow, so there
are no secrets to configure — follow the prompts during execution.
