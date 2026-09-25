import { pathExists } from './helpers.ts';

/**
 * Absolute paths to system tools.
 *
 * The flake app (`nix run .#bootstrap`) sets PATH to nix store bin dirs only —
 * no /usr/bin, /usr/sbin, /bin, and no Homebrew prefix. Anything not provided
 * by the flake therefore has to be invoked by absolute path, including via
 * `sudo`, which resolves the command against its own restricted PATH.
 *
 * Tools whose location isn't fixed (Homebrew prefix, NixOS system profile)
 * are resolved at runtime by the helpers below rather than listed here.
 */
export const bin = {
  sudo: '/usr/bin/sudo',
  scutil: '/usr/sbin/scutil',
  dscacheutil: '/usr/bin/dscacheutil',
  killall: '/usr/bin/killall',
  open: '/usr/bin/open',
  pbcopy: '/usr/bin/pbcopy',
} as const;

const BREW_PREFIXES = ['/opt/homebrew', '/usr/local'] as const;

// NixOS puts systemd tools in the system profile; /usr/bin covers non-NixOS.
const HOSTNAMECTL_CANDIDATES = [
  '/run/current-system/sw/bin/hostnamectl',
  '/usr/bin/hostnamectl',
] as const;

const firstExisting = async (
  candidates: readonly string[],
): Promise<string | null> => {
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
};

/**
 * Absolute path to a Homebrew-installed binary (`brew` itself included), or
 * null when it isn't present under any known prefix. Used instead of `which`,
 * which can't see the Homebrew prefix given the flake's restricted PATH.
 */
export const findBrewBinary = (name: string): Promise<string | null> =>
  firstExisting(BREW_PREFIXES.map((prefix) => `${prefix}/bin/${name}`));

/**
 * Absolute path to a tool provided by the *system* — the NixOS system profile
 * on Linux, Homebrew on macOS — or null when neither has it.
 *
 * Both are consulted because the platforms install the same tools from
 * different places: `op` is a Homebrew cask on macOS and a nix package on
 * NixOS, and neither location is on the flake app's PATH.
 */
export const findSystemBinary = async (
  name: string,
): Promise<string | null> => {
  const system = `/run/current-system/sw/bin/${name}`;

  return (await pathExists(system)) ? system : await findBrewBinary(name);
};

/** As `findSystemBinary`, but throws with actionable context when absent. */
export const requireSystemBinary = async (name: string): Promise<string> => {
  const found = await findSystemBinary(name);

  if (!found) {
    throw new Error(
      `\`${name}\` not found in the system profile or under ` +
        `${BREW_PREFIXES.join(' or ')} — the phase that installs it must run ` +
        'before this step.',
    );
  }

  return found;
};

/** As `findBrewBinary`, but throws with actionable context when absent. */
export const requireBrewBinary = async (name: string): Promise<string> => {
  const found = await findBrewBinary(name);

  if (!found) {
    throw new Error(
      `\`${name}\` not found under ${BREW_PREFIXES.join(' or ')} — the ` +
        'phase that installs it must run before this step.',
    );
  }

  return found;
};

/** Absolute path to `hostnamectl`, falling back to a bare PATH lookup. */
export const hostnamectl = async (): Promise<string> =>
  (await firstExisting(HOSTNAMECTL_CANDIDATES)) ?? 'hostnamectl';
