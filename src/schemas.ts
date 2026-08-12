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

export const gpgConfigurationSchema = z.object({
  /**
   * Primary key fingerprint, used as the idempotency check: when `gpg -K`
   * already lists it, the import is skipped.
   */
  fingerprint: z.string().min(1),
  /**
   * 1Password *document* holding the armored secret-key export
   * (`gpg --export-secret-keys --armor`). Piped straight into `gpg --import`,
   * never written to disk. Keep a passphrase on the key so the export is also
   * encrypted at rest inside 1Password.
   *
   * Accepts `op://Vault/Item` or a name resolved against `onePassword.vault`.
   */
  secretKeyOpReference: z.string().min(1).optional(),
  /**
   * 1Password document holding `gpg --export-ownertrust` output. Optional —
   * without it the imported key has no assigned trust.
   */
  ownertrustOpReference: z.string().min(1).optional(),
});

export const onePasswordConfigurationSchema = z.object({
  /**
   * Default vault used to expand short-form secret references (e.g.
   * `Item/field` -> `op://<vault>/Item/field`). Modules that fetch secrets
   * pass references through `readSecret`, which performs the expansion.
   */
  vault: z.string().min(1).optional(),
});

export const configurationSchema = z.object({
  knownHosts: z.array(z.string()),
  github: z.object({
    user: z.string(),
    email: z.string().email(),
    clientId: z.string().min(1),
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
  'gpg-imported',
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
export type OnePasswordConfiguration = z.infer<
  typeof onePasswordConfigurationSchema
>;
