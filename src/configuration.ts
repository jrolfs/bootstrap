import { configurationSchema, environmentSchema } from './schemas.ts';

export const configuration = configurationSchema.parse({
  knownHosts: ['github.com'],
  github: {
    user: 'jrolfs',
    email: 'jamie.rolfs@gmail.com',
    clientId: 'Ov23littWGoGtwfc0yEv',
  },
  homeshick: {
    remote: 'https://github.com/andsens/homeshick.git',
  },
  // Repo is still named `macos` on GitHub; renaming to `nix` is deferred
  // (GitHub redirects would cover most cases, but a fresh SSH clone wants the
  // real name). Flip to `nix.git` once the rename happens.
  nixConfigRepo: 'git@github.com:jrolfs/macos.git',
  // Default branch override during the flake migration period.
  // Flip back to "master" once the migration branch is merged.
  nixConfigBranch: 'migration-flake',
  privateCastleRepo: 'git@github.com:jrolfs/private.git',
  vscodeSyncRepo: 'git@github.com:jrolfs/vscode.git',
  onePassword: {
    vault: 'Private',
  },
  resilio: {
    enabled: true,
    // No share secret: devices are linked to a Resilio *identity*, which
    // carries its shares with it. See src/resilio.ts.
    configSharePath: '~/Configuration',
  },
});

let parsedEnvironment: ReturnType<typeof getEnvironment> | null = null;

const getEnvironment = () => {
  try {
    return ({
      ...environmentSchema.parse(Deno.env.toObject()),
      hostname: Deno.hostname().trim().toLowerCase(),
    });
  } catch (error) {
    console.error(error);
    throw new Error('Failed to parse environment');
  }
};

export const environment = () => {
  if (parsedEnvironment) return parsedEnvironment;

  parsedEnvironment = getEnvironment();

  return parsedEnvironment;
};

/**
 * Override the memoized hostname after the `hostname-set` phase has confirmed
 * (and applied) it. Every consumer reads `environment().hostname`, so this is
 * the single point that makes the flake selector and SSH key comment use the
 * confirmed name rather than the live value read at process start.
 */
export const setHostname = (hostname: string): void => {
  const current = environment();
  parsedEnvironment = { ...current, hostname };
};
