# Bootstrap

Bootstrap script for setting up a new macOS system with:
- Nix + nix-darwin
- Homebrew
- SSH key generation and GitHub authentication
- Homeshick dotfile management

## Usage

Bootstrap a new machine with a single command:

```bash
curl -L https://raw.githubusercontent.com/jrolfs/bootstrap/main/bootstrap.sh | bash
```

## What it does

1. Installs Nix using the Determinate Systems installer
2. Clones this repository
3. Generates and uploads an SSH key to GitHub (using device flow authentication)
4. Installs Homebrew
5. Sets up homeshick and clones dotfile repositories
6. Builds the system using nix-darwin configuration

## Development

### Prerequisites

- Devbox

### Running locally

```bash
# Type check
deno check bootstrap.ts

# Run
nix run .#bootstrap
```

## Configuration

All configuration is in `bootstrap.ts`. The script uses GitHub's Device Flow for authentication, which means you don't need to handle any secrets - just follow the prompts during execution to authenticate via GitHub's website.