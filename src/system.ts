import { pathExists } from './helpers.ts';

/**
 * Absolute paths to macOS system tools that live at a fixed location.
 *
 * `useSystemPath` puts these directories on PATH, so most callers can just use
 * the name. This exists for the ones worth pinning anyway: `sudo` resolves the
 * command it runs against *its own* restricted PATH rather than ours, so
 * anything handed to it wants a full path regardless of what we set here.
 *
 * Anything whose location varies by platform or installation — sudo itself,
 * Homebrew, the NixOS profile — is resolved at runtime by the helpers below
 * instead of being listed here.
 */
export const bin = {
  sudo: '/usr/bin/sudo',
  scutil: '/usr/sbin/scutil',
  dscacheutil: '/usr/bin/dscacheutil',
  diskutil: '/usr/sbin/diskutil',
  killall: '/usr/bin/killall',
  open: '/usr/bin/open',
  pbcopy: '/usr/bin/pbcopy',
  plutil: '/usr/bin/plutil',
} as const;

const BREW_PREFIXES = ['/opt/homebrew', '/usr/local'] as const;

/**
 * Where the *system* keeps its tools, in resolution order.
 *
 * The flake wrapper sets PATH to nix store bin directories only, so nothing
 * here is findable by name unless we put it there. This list is the single
 * answer to "where does a system tool live", used both to resolve one by name
 * and to extend PATH so a plain invocation works (see `useSystemPath`).
 *
 * Order matters in one place especially: `/run/wrappers/bin` must precede the
 * NixOS system profile. NixOS installs setuid programs as wrappers there,
 * while `security/sudo.nix` *also* puts the package in
 * `environment.systemPackages` — so `/run/current-system/sw/bin/sudo` exists
 * and is the unwrapped binary, which resolves happily and then cannot elevate.
 * Finding the wrong one is worse than finding none.
 */
const SYSTEM_PATHS: readonly string[] = Deno.build.os === 'darwin'
  ? [
    '/usr/bin',
    '/usr/sbin',
    '/bin',
    '/sbin',
    ...BREW_PREFIXES.map((prefix) => `${prefix}/bin`),
  ]
  : [
    // Setuid wrappers first — see above.
    '/run/wrappers/bin',
    '/run/current-system/sw/bin',
    '/usr/bin',
    '/bin',
  ];

/**
 * Appends the system directories to this process's PATH, so tools we shell out
 * to can be invoked by name and inherited by children.
 *
 * Appended rather than prepended: everything the flake pins still wins, so
 * this changes which commands *resolve*, never which implementation a resolved
 * one gets. The alternative — an absolute path per tool — is what this codebase
 * did, and it grew a new special case every time provisioning met a directory
 * nobody had listed yet, each discovered as a failure mid-install.
 */
export const useSystemPath = (): void => {
  const current = Deno.env.get('PATH') ?? '';
  const missing = SYSTEM_PATHS.filter(
    (directory) => !current.split(':').includes(directory),
  );

  if (missing.length > 0) {
    Deno.env.set('PATH', [current, ...missing].filter(Boolean).join(':'));
  }
};

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
export const findSystemBinary = (name: string): Promise<string | null> =>
  firstExisting(SYSTEM_PATHS.map((directory) => `${directory}/${name}`));

/** As `findSystemBinary`, but throws with actionable context when absent. */
export const requireSystemBinary = async (name: string): Promise<string> => {
  const found = await findSystemBinary(name);

  if (!found) {
    throw new Error(
      `\`${name}\` not found in ${SYSTEM_PATHS.join(', ')} — the phase that ` +
        'installs it must run before this step.',
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

/**
 * Absolute path to `sudo`.
 *
 * Resolved rather than taken from `bin` because the location differs per
 * platform, and on NixOS the *wrong* one is present too: the setuid wrapper in
 * /run/wrappers/bin is the one that can elevate, while the copy in the system
 * profile is unwrapped and fails after resolving. SYSTEM_PATHS orders the
 * wrapper directory first for exactly this reason.
 */
export const sudo = async (): Promise<string> =>
  (await findSystemBinary('sudo')) ?? 'sudo';

/** Absolute path to `hostnamectl`, falling back to a bare PATH lookup. */
export const hostnamectl = async (): Promise<string> =>
  (await findSystemBinary('hostnamectl')) ?? 'hostnamectl';
