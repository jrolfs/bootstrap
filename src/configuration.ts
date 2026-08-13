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
    // Default vault for expanding short-form references.
    vault: 'Private',
    // Where the `secrets` CLI creates items. A dedicated vault keeps machine
    // secrets separate from the ~1300-item personal vault, and — the real
    // reason — 1Password service accounts grant access per vault, so a headless
    // host (Irulan) can later be scoped to just this one.
    //
    // Create it with: op vault create Infrastructure
    secretsVault: 'Infrastructure',
  },
  gpg: {
    // op:// references live in secrets.json, recorded by `secrets gpg export` —
    // run that from a machine that already holds the material. Until then the
    // gpg-imported phase is inert.
    keyrings: [
      {
        name: 'default',
        fingerprint: '91C155A78968EEE863ED8B22626AE770762AC2F3',
        hosts: ['*'],
      },
      {
        // Separate GNUPGHOME rather than `--keyring=fondo.kbx`: GnuPG doesn't
        // partition *secret* keys by keyring (they all live in one flat
        // private-keys-v1.d per home), so a separate home is the only way to
        // keep this identity's secret key off a machine entirely.
        //
        // Access it with: GNUPGHOME=~/.gnupg-fondo gpg …
        name: 'fondo',
        home: '.gnupg-fondo',
        hosts: ['newt', 'ala'],
      },
    ],
  },
  resilio: {
    enabled: true,
    // No share secret: devices are linked to a Resilio *identity*, which
    // carries its shares with it. See src/resilio.ts.
    configSharePath: '~/Configuration',
    // Optional: a 1Password reference to a Resilio device linking code. When
    // set, bootstrap copies the code to the clipboard before opening Resilio so
    // linking is a ⌘V instead of a trip to another device. Codes are
    // short-lived — generate one on a linked device and stash it just before
    // provisioning. Left unset until such an item exists; absence just falls
    // back to approving from another device.
    // linkingCodeOpReference: 'op://Private/<item-uuid>/<field-uuid>',
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
