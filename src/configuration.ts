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
  nixConfigRepo: 'git@github.com:jrolfs/nix.git',
  // Default branch override during the flake migration period.
  // Flip back to "master" once the migration branch is merged.
  nixConfigBranch: 'migration-flake',
  privateCastleRepo: 'git@github.com:jrolfs/private.git',
  vscodeSyncRepo: 'git@github.com:jrolfs/vscode.git',
  onePassword: {
    // Account shorthand is filled in interactively on first signin. If known
    // ahead of time it can be hardcoded here (e.g. 'my').
    vault: 'Personal',
  },
  resilio: {
    enabled: true,
    // Default to 1Password so secrets stop relying on the private castle.
    // The `private-castle` source is still supported as a fallback for
    // offline / 1Password-unavailable scenarios.
    configShareSecretSource: '1password',
    // Short form `Item/field`; the vault is auto-prefixed from
    // `onePassword.vault` above. Edit to suit the actual item name.
    configShareSecretOpReference: 'Resilio Configuration Share/credential',
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
