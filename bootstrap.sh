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

function ensure_nix() {
  if [[ -d "/nix" ]]; then
    echo "✓ Nix already installed"
  else
    echo "Installing Lix..."
    # Lix is a CppNix fork; multi-user installer follows the same layout.
    curl --proto '=https' --tlsv1.2 -sSf -L https://install.lix.systems/lix | sh -s -- install
  fi

  # Source the nix profile so `nix` is available in this shell session.
  # TODO(lix): Verify post-install profile path against current Lix docs;
  # CppNix-compatible layout uses the path below, but Lix may diverge in
  # future releases.
  if [[ -e "/nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh" ]]; then
    . /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
  fi
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
