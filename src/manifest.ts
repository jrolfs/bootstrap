import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import { dirname, resolve } from 'https://deno.land/std@0.192.0/path/mod.ts';

import { environment } from './configuration.ts';
import { pathExists } from './helpers.ts';

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
   * `GNUPGHOME` (relative to `$HOME`) this entry belongs to, for GPG keyring
   * entries. Lets `secrets gpg import` route each export to the right keyring.
   */
  gnupgHome: z.string().optional(),
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
 * Marks a directory as a checkout of this repo. Both are required: `flake.nix`
 * alone matches any flake the CLI happens to be invoked from.
 */
const CHECKOUT_MARKERS = ['flake.nix', 'src/secrets.ts'] as const;

/**
 * Nearest enclosing checkout of this repo, or null.
 *
 * Walks up from the directory the CLI was *invoked* from — never from
 * `import.meta.url`. The flake wrapper `cd`s into the store copy of `src/`
 * before exec'ing deno, so a module-relative path resolves to a bare
 * `/nix/store/secrets.json` that exists under no circumstances, and it does so
 * for `nix run .#secrets` in a clone exactly as much as for
 * `nix run github:…`. The wrapper exports the pre-`cd` directory as
 * `BOOTSTRAP_INVOCATION_DIR` so this can recover it.
 */
const findCheckout = async (): Promise<string | null> => {
  const start = Deno.env.get('BOOTSTRAP_INVOCATION_DIR') ?? Deno.cwd();

  const walk = async (directory: string): Promise<string | null> => {
    const markers = await Promise.all(
      CHECKOUT_MARKERS.map((marker) => pathExists(`${directory}/${marker}`)),
    );

    if (markers.every(Boolean)) return directory;

    const parent = dirname(directory);

    return parent === directory ? null : await walk(parent);
  };

  return await walk(resolve(start));
};

interface ManifestLocation {
  readonly path: string;
  /** False for the store copy, which mutating commands must refuse. */
  readonly writable: boolean;
}

/**
 * Where the manifest lives for this invocation.
 *
 * A checkout wins, so `nix run .#secrets` writes to the working tree. Failing
 * that the flake-baked store copy is used, which lets a checkout-less
 * `nix run github:jrolfs/bootstrap#secrets` still *read* the committed manifest
 * — the case the `gpg-imported` bootstrap phase depends on.
 */
const manifestLocation = async (): Promise<ManifestLocation> => {
  const override = Deno.env.get('SECRETS_MANIFEST');
  if (override) return { path: override, writable: true };

  const checkout = await findCheckout();
  if (checkout) return { path: `${checkout}/secrets.json`, writable: true };

  const store = Deno.env.get('SECRETS_MANIFEST_STORE');
  if (store) return { path: store, writable: false };

  return { path: resolve(Deno.cwd(), 'secrets.json'), writable: true };
};

/** The resolved manifest path, for diagnostics. */
export const manifestPath = async (): Promise<string> =>
  (await manifestLocation()).path;

const emptyManifest = (): Manifest => ({ version: 1, secrets: {} });

export const loadManifest = async (): Promise<Manifest> => {
  const { path } = await manifestLocation();

  try {
    const raw = await Deno.readTextFile(path);
    return manifestSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return emptyManifest();
    throw error;
  }
};

/**
 * Writes the manifest back.
 *
 * Needs a writable checkout: the store copy can't be edited, so mutating
 * commands run from a clone. The error names the resolved path because the
 * failure mode it replaces was silent about which file it meant.
 */
export const saveManifest = async (manifest: Manifest): Promise<void> => {
  const { path, writable } = await manifestLocation();

  if (!writable) {
    throw new Error(
      `Cannot write the manifest: ${path} is in the nix store.\n` +
        'Mutating commands need a writable checkout — run `nix run .#secrets ' +
        '-- …` from a clone of this repo, or point SECRETS_MANIFEST at the ' +
        'file directly.',
    );
  }

  await Deno.writeTextFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
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
