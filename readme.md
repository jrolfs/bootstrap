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
7. **first switch** — `darwin-rebuild` / `nixos-rebuild switch --flake
   ~/.config/system#<hostname>` (bootstrapped via `nix run` on the first run).
8. **mackup-restored** (macOS) — confirmed `mackup restore` from the synced
   `~/Configuration/mackup`.

After the first switch on macOS: grant Full Disk Access to
`/usr/local/bin/icon-customizer` (System Settings → Privacy & Security).

## Development

### Prerequisites

- Devbox (or `nix run nixpkgs#deno`)

### Running locally

```bash
# Type check + lint
deno check src/*.ts
deno lint src

# Run the orchestrator directly
nix run .#bootstrap
```

## Configuration

Configuration lives in `src/configuration.ts` (schemas in `src/schemas.ts`):
the nix config + private + vscode-sync repo URLs and branch, 1Password vault,
and the Resilio share settings (secret source defaults to 1Password, with a
`private-castle` fallback). Authentication uses GitHub's Device Flow, so there
are no secrets to configure — follow the prompts during execution.
