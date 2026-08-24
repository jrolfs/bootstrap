import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';

export const deviceCodeResponseSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string().url(),
  expires_in: z.number(),
  interval: z.number(),
});

export const accessTokenResponseSchema = z.union([
  z.object({
    access_token: z.string(),
    token_type: z.string(),
    scope: z.string(),
  }),
  z.object({
    error: z.string(),
    error_description: z.string().optional(),
    error_uri: z.string().optional(),
  }),
]);

export const githubKeysResponseSchema = z.array(z.object({
  id: z.number(),
  key: z.string(),
  title: z.string(),
}));

export const githubUserResponseSchema = z.object({
  login: z.string(),
});

const githubSshUrl = z
  .string()
  .regex(/^git@github\.com:.+\/.+\.git$/, 'Must be a valid GitHub SSH URL');

export const resilioConfigurationSchema = z.object({
  enabled: z.boolean().default(false),
  /**
   * Path of the synced configuration share. Used to wait for the initial sync
   * and to locate the mackup store. No share secret is configured: devices are
   * linked to a Resilio identity, which brings its shares along.
   */
  configSharePath: z.string().default('~/Configuration'),
  /**
   * Optional 1Password reference to a Resilio device *linking code*.
   *
   * Linking still has to be completed in the GUI (there's no CLI for it), but
   * when this is set the code is fetched and printed for copy-paste, so a
   * second device isn't needed mid-run. Generate the code on an already-linked
   * device and store it here shortly before provisioning — codes are
   * short-lived, so a stale one simply falls back to approving from another
   * device.
   *
   * Accepts a fully qualified `op://Vault/Item/field` reference or a short
   * `Item/field` / `Vault/Item/field` form resolved against
   * `onePassword.vault`. Note a reference cannot contain `/` or `&`, so items
   * or fields with those in their names must be addressed by UUID.
   */
  linkingCodeOpReference: z.string().min(1).optional(),
});

export const gpgKeyringSchema = z.object({
  /**
   * Manifest key prefix and CLI identifier — entries are recorded as
   * `<name>-secret-keys` and `<name>-ownertrust`.
   */
  name: z.string().min(1),
  /**
   * `GNUPGHOME` for this keyring, relative to `$HOME`. Omit for the default
   * `~/.gnupg`.
   *
   * GnuPG does not partition *secret* keys by keyring — `--keyring` only selects
   * a public keybox, while secret keys all live in one flat
   * `private-keys-v1.d` per GNUPGHOME. A separate home is therefore the only way
   * to keep an identity's secret key off a machine entirely.
   */
  home: z.string().optional(),
  /**
   * Fingerprint to export, and the idempotency check on import. Omit to export
   * *every* secret key in this GNUPGHOME — which is what a separate identity
   * keyring usually wants.
   */
  fingerprint: z.string().min(1).optional(),
  /** Machines this keyring belongs on. `["*"]` for all. */
  hosts: z.array(z.string()).default(['*']),
});

export const gpgConfigurationSchema = z.object({
  /** Keyrings to export/import. The first is treated as the default. */
  keyrings: z.array(gpgKeyringSchema).default([]),
});

export const onePasswordConfigurationSchema = z.object({
  /**
   * Account (sign-in address or user ID) to pass as `--account`.
   *
   * `op` refuses to guess: with more than one account configured every
   * invocation fails with "multiple accounts found", including `op whoami`. A
   * machine signed into both a personal and a work account is the normal case,
   * so pin the one holding these secrets. Omit when there's only ever one.
   */
  account: z.string().min(1).optional(),
  /**
   * Default vault used to expand short-form secret references (e.g.
   * `Item/field` -> `op://<vault>/Item/field`). Modules that fetch secrets
   * pass references through `readSecret`, which performs the expansion.
   */
  vault: z.string().min(1).optional(),
  /**
   * Vault the `secrets` CLI *creates* items in. Kept separate from `vault` so
   * machine secrets can live in a dedicated vault without breaking short-form
   * references that point at the personal one.
   *
   * A dedicated vault matters beyond tidiness: 1Password service accounts grant
   * access per vault, so a headless host can be given a token scoped to only
   * these secrets rather than an entire personal vault.
   */
  secretsVault: z.string().min(1).optional(),
});

export const configurationSchema = z.object({
  knownHosts: z.array(z.string()),
  github: z.object({
    user: z.string(),
    email: z.string().email(),
    clientId: z.string().min(1),
    /**
     * Private `owner/repo` slugs the HTTPS credential must be able to read.
     *
     * Probed by `secrets github token` right after capture, because the failure
     * this credential exists to work around is an *authorization* one: an
     * organization that restricts third-party OAuth Apps or personal access
     * tokens answers with a plain 404, indistinguishable from a typo. Better to
     * see that while the token is still on screen than halfway through an
     * activation.
     */
    credentialProbeRepositories: z.array(z.string()).default([]),
  }),
  homeshick: z.object({
    remote: z.string().url(),
  }),
  nixConfigRepo: githubSshUrl,
  nixConfigBranch: z.string().min(1).default('master'),
  privateCastleRepo: githubSshUrl,
  vscodeSyncRepo: githubSshUrl.optional(),
  onePassword: onePasswordConfigurationSchema.optional(),
  resilio: resilioConfigurationSchema.optional(),
  gpg: gpgConfigurationSchema.optional(),
});

export const environmentSchema = z.object({
  HOME: z.string().min(1),
});

export const phaseSchema = z.enum([
  'hostname-set',
  'nix-installed',
  'github-authed',
  'ssh-key-uploaded',
  'homebrew-installed',
  'op-installed',
  'op-authenticated',
  'private-cloned',
  'nix-config-cloned',
  'vscode-sync-cloned',
  'resilio-configured',
  'secrets-materialized',
  'gpg-imported',
  'castle-unlocked',
  'first-switch-completed',
  'mackup-restored',
]);

export const stateSchema = z.object({
  phases: z.array(phaseSchema).default([]),
  /**
   * The hostname chosen during the `hostname-set` phase. Persisted so the
   * flake selector (`…#<hostname>`) uses the confirmed value on every run
   * rather than re-reading a possibly-wrong live hostname, and so re-runs
   * skip the interactive prompt.
   */
  hostname: z.string().min(1).optional(),
});

export type Phase = z.infer<typeof phaseSchema>;
export type State = z.infer<typeof stateSchema>;
export type Configuration = z.infer<typeof configurationSchema>;
export type ResilioConfiguration = z.infer<typeof resilioConfigurationSchema>;
export type GpgConfiguration = z.infer<typeof gpgConfigurationSchema>;
export type GpgKeyring = z.infer<typeof gpgKeyringSchema>;
export type OnePasswordConfiguration = z.infer<
  typeof onePasswordConfigurationSchema
>;
