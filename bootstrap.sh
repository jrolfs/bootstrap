#!/usr/bin/env bash

set -euo pipefail

BOOTSTRAP_DIR="$HOME/.bootstrap"

function ensure_comand_line_tools() {
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
    return 0
  fi

  echo "Installing Nix..."
  curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix | sh -s -- install
}

function ensure_repository() {
  if [[ -d "$BOOTSTRAP_DIR" ]]; then
    echo "Updating bootstrap repository..."
    cd "$BOOTSTRAP_DIR"
    git pull
    return 0
  fi

  echo "Cloning bootstrap repository..."
  git clone https://github.com/jrolfs/bootstrap.git "$BOOTSTRAP_DIR"
  cd "$BOOTSTRAP_DIR"
}

ensure_comand_line_tools
ensure_nix
ensure_repository

nix run .#bootstrap