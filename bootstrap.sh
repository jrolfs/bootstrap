#!/usr/bin/env bash

set -euo pipefail

BOOTSTRAP_DIR="$HOME/.bootstrap"
OS="$(uname -s)"
# Branch of this repo to run. Defaults to main; override to test an unmerged
# branch, e.g. BOOTSTRAP_REF=flake-migration during the flake migration.
BOOTSTRAP_REF="${BOOTSTRAP_REF:-main}"

function ensure_comand_line_tools() {
  if [[ "$OS" != "Darwin" ]]; then
    return 0
  fi

  if xcode-select -p &> /dev/null; then
    echo "✓ Command Line Tools already installed"
    return 0
  fi

  echo "Installing Command Line Tools..."
  xcode-select --install

  # Wait for installation to complete
  echo "Waiting for Command Line Tools installation to complete..."
  until xcode-select -p &> /dev/null; do
    sleep 5
  done

  echo "✓ Command Line Tools installation complete"
}

NIX_PROFILE_SCRIPT="/nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh"

function source_nix_profile() {
  # bootstrap.sh runs as a non-login, non-interactive bash, which sources
  # neither /etc/profile nor the installer's shell hooks — so pull in the
  # profile ourselves to put `nix` on PATH.
  # TODO(lix): Verify this path against current Lix docs; the CppNix-compatible
  # layout uses it today but Lix may diverge in future releases.
  if [[ -e "$NIX_PROFILE_SCRIPT" ]]; then
    . "$NIX_PROFILE_SCRIPT"
  fi
}

function nix_installed() {
  # A *real* install — not a leftover empty /nix mountpoint, which lingers on
  # macOS after a Determinate/Lix uninstall until the next reboot (the APFS
  # store volume's synthetic firmlink). Keying off `[[ -d /nix ]]` alone would
  # false-positive on that empty directory, so check for actual install state.
  command -v nix >/dev/null 2>&1 && return 0
  [[ -e "$NIX_PROFILE_SCRIPT" ]] && return 0
  [[ -e "/nix/receipt.json" ]] && return 0
  [[ -n "$(ls -A /nix/store 2>/dev/null)" ]] && return 0
  return 1
}

function ensure_nix() {
  # Source first so the Lix-vs-other detection below can run `nix`.
  source_nix_profile

  if nix_installed; then
    # This bootstrap installs Lix and lets nix-darwin manage the daemon
    # (nix.enable = true; nix.package = lix). A Determinate/upstream install
    # (both also live at /nix and write /nix/receipt.json, so presence alone
    # can't tell them apart — the version string can) will fight nix-darwin at
    # the first switch. Refuse to build on top of it.
    if nix --version 2>/dev/null | grep -qi 'lix'; then
      echo "✓ Lix already installed"
      return 0
    fi

    echo "" >&2
    echo "✗ An existing non-Lix Nix was detected." >&2
    echo "  (\`nix --version\`: $(nix --version 2>/dev/null || echo 'unavailable'))" >&2
    echo "  This installer expects Lix + nix-darwin-managed nix; a Determinate/" >&2
    echo "  upstream install conflicts at the first switch. Uninstall it, then" >&2
    echo "  REBOOT (macOS leaves an empty /nix mount until you do), then re-run:" >&2
    echo "" >&2
    echo "      sudo /nix/nix-installer uninstall && sudo reboot" >&2
    echo "" >&2
    exit 1
  fi

  echo "Installing Lix..."
  # Lix is a CppNix fork; multi-user installer follows the same layout.
  curl --proto '=https' --tlsv1.2 -sSf -L https://install.lix.systems/lix | sh -s -- install

  source_nix_profile
}

function ensure_repository() {
  if [[ -d "$BOOTSTRAP_DIR" ]]; then
    echo "Updating bootstrap repository (ref: $BOOTSTRAP_REF)..."
    cd "$BOOTSTRAP_DIR"
    git fetch origin "$BOOTSTRAP_REF"
    git checkout "$BOOTSTRAP_REF"
    git pull --ff-only origin "$BOOTSTRAP_REF"
    return 0
  fi

  echo "Cloning bootstrap repository (ref: $BOOTSTRAP_REF)..."
  git clone --branch "$BOOTSTRAP_REF" https://github.com/jrolfs/bootstrap.git "$BOOTSTRAP_DIR"
  cd "$BOOTSTRAP_DIR"
}

ensure_comand_line_tools
ensure_nix
ensure_repository

nix run .#bootstrap
