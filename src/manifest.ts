import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';

import { environment } from './configuration.ts';

/**
 * Manifest of 1Password secret references.
 *
 * References are *not* secrets, so this file is committed: it's the reviewable
 * source of truth for "which 1Password item holds what, and where does it go on
 * disk". That's what makes `secrets materialize` a single command — the
 * equivalent of `homeshick link private` — and it means a lost reference is a
 * `git log` away rather than a hunt through the vault.
 */

export const secretEntrySchema = z.object({
  /**
   * How to fetch it. `document` uses `op document get` (file attachments —
   * right for multi-line material like an armored key); `field` uses `op read`
   * (a single field value).
   */
  kind: z.enum(['document', 'field']).default('document'),
  /** `op://Vault/Item[/field]`, or a short form resolved against the vault. */
  reference: z.string().min(1),
  /** What this is, for `secrets list`. */
  description: z.string().default(''),
  /**
   * Where `materialize` writes it, relative to `$HOME`. Omit for secrets that a
   * dedicated command handles instead (e.g. the GPG key, which is imported into
   * the keyring rather than written to a path).
   */
  target: z.string().optional(),
  /** Mode for a materialized target. Credentials should stay `0600`. */
  mode: z.string().default('0600'),
  /**
   * Hosts this secret belongs on. `["*"]` means every machine. Anything else
   * gates it to the listed short hostnames — which is how a secondary keyring
   * lands on one machine and not the rest.
   */
  hosts: z.array(z.string()).default(['*']),
});

export const manifestSchema = z.object({
  version: z.literal(1),
  secrets: z.record(z.string(), secretEntrySchema).default({}),
});

export type SecretEntry = z.infer<typeof secretEntrySchema>;
export type Manifest = z.infer<typeof manifestSchema>;

/**
 * Manifest location.
 *
 * Lives in this repo rather than the nix config so the CLI and the bootstrap
 * phases that consume it stay in one place, and so `nix run
 * github:jrolfs/bootstrap#secrets` works with no checkout at all.
 */
const manifestPath = (): string =>
  new URL('../secrets.json', import.meta.url).pathname;

const emptyManifest = (): Manifest => ({ version: 1, secrets: {} });

export const loadManifest = async (): Promise<Manifest> => {
  try {
    const raw = await Deno.readTextFile(manifestPath());
    return manifestSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return emptyManifest();
    throw error;
  }
};

/**
 * Writes the manifest back.
 *
 * Only works against a writable checkout — when the CLI runs from the nix store
 * (`nix run github:…`) the path is read-only, so mutating commands must be run
 * from a clone. The error surfaces that rather than failing cryptically.
 */
export const saveManifest = async (manifest: Manifest): Promise<void> => {
  const path = manifestPath();

  try {
    await Deno.writeTextFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    if (
      error instanceof Deno.errors.PermissionDenied ||
      path.startsWith('/nix/store/')
    ) {
      throw new Error(
        `Cannot write the manifest at ${path} — it is read-only.\n` +
          'Mutating commands need a writable checkout: clone the bootstrap ' +
          'repo and run `nix run .#secrets -- …` from there.',
      );
    }
    throw error;
  }
};

/** True when `entry` applies to this machine. */
export const appliesToHost = (entry: SecretEntry, hostname: string): boolean =>
  entry.hosts.includes('*') || entry.hosts.includes(hostname);

/** Manifest entries that apply to this machine, as `[name, entry]` pairs. */
export const entriesForHost = (
  manifest: Manifest,
): readonly (readonly [string, SecretEntry])[] => {
  const { hostname } = environment();

  return Object.entries(manifest.secrets).filter(([, entry]) =>
    appliesToHost(entry, hostname)
  );
};
