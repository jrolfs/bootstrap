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
export type OnePasswordConfiguration = z.infer<
  typeof onePasswordConfigurationSchema
>;
