import { blue, bold, gray, yellow } from 'https://deno.land/std@0.192.0/fmt/colors.ts';

import { configuration, environment } from './configuration.ts';
import { shell } from './helpers.ts';
import {
  appliesToHost,
  loadManifest,
  type Manifest,
  saveManifest,
} from './manifest.ts';
import { createDocument, readDocument } from './onepassword.ts';
import { findBrewBinary } from './system.ts';
import type { GpgKeyring } from './schemas.ts';

/**
 * Manifest key names per keyring.
 *
 * Three artifacts are needed to reconstitute a GNUPGHOME, and they're distinct:
 * `--export` carries *all* public keys (yours and other people's),
 * `--export-secret-keys` carries only your secret keys (each embedding its own
 * public half), and `--export-ownertrust` carries trust *assignments* —
 * fingerprint → trust level — not key material. Exporting only the latter two
 * silently drops every third-party public key in the keyring.
 */
const publicKeyName = (keyring: string): string => `${keyring}-public-keys`;
const secretKeyName = (keyring: string): string => `${keyring}-secret-keys`;
const ownertrustName = (keyring: string): string => `${keyring}-ownertrust`;

/**
 * Resolves `gpg`. It comes from the nix system profile after the first switch,
 * but during a first bootstrap that profile doesn't exist yet, so fall back to
 * Homebrew and finally to a bare PATH lookup.
 */
const findGpg = async (): Promise<string | null> => {
  const candidates = ['/run/current-system/sw/bin/gpg', '/usr/local/bin/gpg'];

  for (const candidate of candidates) {
    const probe = await shell('/usr/bin/which', [candidate], { error: false });
    if (probe.success) return candidate;
  }

  return await findBrewBinary('gpg');
};

/** Absolute GNUPGHOME for a keyring, or null for gpg's default. */
const homeFor = (keyring: GpgKeyring): string | null => {
  if (!keyring.home) return null;

  const { HOME } = environment();

  return keyring.home.startsWith('/')
    ? keyring.home
    : `${HOME}/${keyring.home}`;
};

/**
 * The directory gpg will actually use for this keyring, pinned or not.
 *
 * Distinct from `homeFor`, whose null means "don't inject GNUPGHOME" — the
 * default home still has to exist at 0700 or gpg warns about unsafe permissions
 * on every invocation. On a freshly provisioned machine that directory is
 * created by home-manager linking gpg.conf into it, which makes it 0755.
 */
const effectiveHome = (keyring: GpgKeyring): string =>
  homeFor(keyring) ?? Deno.env.get('GNUPGHOME') ??
    `${environment().HOME}/.gnupg`;

/**
 * Runs `gpg` scoped to a keyring.
 *
 * GNUPGHOME is set in the environment rather than passing `--homedir` so the
 * agent gpg spawns is scoped to that home too — otherwise one agent would serve
 * both keyrings and undo the isolation.
 */
const runGpg = async (
  gpg: string,
  keyring: GpgKeyring,
  args: readonly string[],
  { secret = false }: { secret?: boolean } = {},
) => {
  const home = homeFor(keyring);

  return await shell(gpg, [...args], {
    error: false,
    secret,
    ...(home ? { env: { ...Deno.env.toObject(), GNUPGHOME: home } } : {}),
  });
};

/** True when this keyring already holds the expected secret key(s). */
const hasSecretKey = async (
  gpg: string,
  keyring: GpgKeyring,
): Promise<boolean> => {
  const result = await runGpg(gpg, keyring, ['-K', '--with-colons']);
  if (!result.success) return false;

  if (!keyring.fingerprint) return result.stdout.includes('sec:');

  return result.stdout.toUpperCase().includes(
    keyring.fingerprint.toUpperCase(),
  );
};

/**
 * Feeds `input` to a command on stdin and returns whether it succeeded.
 *
 * Used so secret key material goes straight from 1Password into `gpg` without
 * ever being written to disk, and without appearing in argv. Deliberately does
 * not use `shell`, which logs the invocation and captures output.
 */
const pipeInto = async (
  command: string,
  args: readonly string[],
  input: string,
  env?: Record<string, string>,
): Promise<{ success: boolean; stderr: string }> => {
  const child = new Deno.Command(command, {
    args: [...args],
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
    ...(env ? { env } : {}),
  }).spawn();

  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();

  const { success, stderr } = await child.output();

  return { success, stderr: new TextDecoder().decode(stderr) };
};

/** Configured keyrings that apply to this machine. */
const keyringsForHost = (): readonly GpgKeyring[] => {
  const { hostname } = environment();

  return (configuration.gpg?.keyrings ?? []).filter((keyring) =>
    keyring.hosts.includes('*') || keyring.hosts.includes(hostname)
  );
};

const findKeyring = (name: string): GpgKeyring | undefined =>
  (configuration.gpg?.keyrings ?? []).find((keyring) => keyring.name === name);

/**
 * Reconstitutes one keyring from 1Password: public keys, secret keys, ownertrust.
 *
 * Public keys are imported on every run (idempotent, and the only thing carrying
 * third-party keys); the secret import is skipped when already present;
 * ownertrust goes last since it references keys by fingerprint.
 */
const importKeyring = async (
  gpg: string,
  keyring: GpgKeyring,
  manifest: Manifest,
): Promise<void> => {
  const { hostname } = environment();
  const entry = manifest.secrets[secretKeyName(keyring.name)];

  if (!entry) {
    console.log(
      gray(
        `No \`${secretKeyName(keyring.name)}\` in the manifest; skipping ` +
          `${keyring.name}. Run \`bootstrap secrets gpg export ${keyring.name}\` from a ` +
          'machine that holds it.',
      ),
    );
    return;
  }

  if (!appliesToHost(entry, hostname)) {
    console.log(gray(`${keyring.name} is not for this host; skipping`));
    return;
  }

  console.log(blue(bold(`\nImporting ${keyring.name} keyring`)));

  const home = homeFor(keyring);

  // Has to exist at 0700 before gpg will use it without complaint. Applied to
  // the default home too, not just a pinned one — see `effectiveHome`.
  const directory = effectiveHome(keyring);
  await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
  await Deno.chmod(directory, 0o700);

  const gpgEnvironment = home
    ? { ...Deno.env.toObject(), GNUPGHOME: home }
    : undefined;

  // Public keys first: importing them is idempotent and cheap, and it's what
  // carries other people's keys. Done on every run (not gated on the secret-key
  // presence check) so a keyring that gained correspondents upstream actually
  // converges rather than being skipped forever.
  const publicEntry = manifest.secrets[publicKeyName(keyring.name)];

  if (publicEntry) {
    const publicKeys = await readDocument(publicEntry.reference);
    const importedPublic = await pipeInto(
      gpg,
      ['--batch', '--import'],
      publicKeys,
      gpgEnvironment,
    );

    console.log(
      importedPublic.success
        ? `✓ ${keyring.name} public keys imported`
        : yellow(
          `public key import failed for ${keyring.name}:\n` +
            importedPublic.stderr,
        ),
    );
  } else {
    console.log(gray(`No public keys recorded for ${keyring.name}`));
  }

  if (await hasSecretKey(gpg, keyring)) {
    console.log(`✓ ${keyring.name} secret key(s) already present`);
  } else {
    const armored = await readDocument(entry.reference);

    if (!armored.includes('BEGIN PGP PRIVATE KEY BLOCK')) {
      throw new Error(
        `1Password document ${entry.reference} does not look like an armored ` +
          'secret key export (no "BEGIN PGP PRIVATE KEY BLOCK").',
      );
    }

    const imported = await pipeInto(
      gpg,
      ['--batch', '--import'],
      armored,
      gpgEnvironment,
    );

    if (!imported.success) {
      throw new Error(
        `\`gpg --import\` failed for ${keyring.name}:\n${imported.stderr}`,
      );
    }

    console.log(`✓ ${keyring.name} secret key(s) imported`);
  }

  // Ownertrust last: it references keys by fingerprint, so the keys should
  // already be present.
  const trustEntry = manifest.secrets[ownertrustName(keyring.name)];

  if (!trustEntry) {
    console.log(gray(`No ownertrust recorded for ${keyring.name}`));
    return;
  }

  const ownertrust = await readDocument(trustEntry.reference);
  const trusted = await pipeInto(
    gpg,
    ['--batch', '--import-ownertrust'],
    ownertrust,
    gpgEnvironment,
  );

  console.log(
    trusted.success
      ? `✓ ${keyring.name} ownertrust imported`
      : yellow(
        `ownertrust import failed for ${keyring.name}:\n${trusted.stderr}`,
      ),
  );
};

/**
 * Imports every configured keyring that applies to this machine.
 *
 * A keyring gated to other hosts is skipped entirely — which is how a secondary
 * identity stays off a work machine. If a key later moves to a hardware token,
 * the on-disk files become stubs that `gpg --card-status` regenerates, and this
 * short-circuits on the presence check.
 *
 * @returns false when `gpg` isn't installed yet, so the caller leaves the phase
 * unrecorded and a later run retries
 */
export const importGpgKeys = async (): Promise<boolean> => {
  const keyrings = keyringsForHost();

  if (keyrings.length === 0) {
    console.log('No gpg keyrings configured for this host; skipping');
    return true;
  }

  const gpg = await findGpg();

  if (!gpg) {
    console.log(
      yellow('`gpg` not found; skipping key import (re-run after the switch).'),
    );
    return false;
  }

  const manifest = await loadManifest();

  for (const keyring of keyrings) {
    await importKeyring(gpg, keyring, manifest);
  }

  return true;
};

/**
 * Captures a keyring's secret keys and ownertrust into 1Password documents and
 * records their references in the manifest.
 *
 * Run from a machine that holds the material. The export streams from `gpg` to
 * `op` in memory — nothing is written to disk. Keep a passphrase on the keys so
 * the stored copy is also encrypted at rest inside 1Password.
 *
 * @param name Keyring to export; defaults to the first configured one
 */
export const exportGpgKeys = async (name?: string): Promise<void> => {
  const configured = configuration.gpg?.keyrings ?? [];
  const keyring = name ? findKeyring(name) : configured[0];

  if (!keyring) {
    throw new Error(
      name
        ? `No gpg keyring named "${name}" in configuration`
        : 'No gpg keyrings configured',
    );
  }

  const gpg = await findGpg();
  if (!gpg) throw new Error('`gpg` not found; cannot export');

  if (!(await hasSecretKey(gpg, keyring))) {
    throw new Error(
      `This machine holds no secret key for "${keyring.name}"` +
        `${keyring.home ? ` in ${keyring.home}` : ''}; ` +
        'export from one that does.',
    );
  }

  console.log(blue(bold(`\nExporting ${keyring.name} to 1Password`)));

  // Omitting the fingerprint exports every secret key in the keyring, which is
  // what a separate identity home generally wants.
  const exported = await runGpg(gpg, keyring, [
    '--batch',
    '--armor',
    '--export-secret-keys',
    ...(keyring.fingerprint ? [keyring.fingerprint] : []),
  ], { secret: true });

  if (!exported.success || !exported.stdout.includes('PRIVATE KEY BLOCK')) {
    throw new Error(
      `\`gpg --export-secret-keys\` produced no key:\n${exported.stderr}`,
    );
  }

  const keyReference = await createDocument({
    title: `GPG ${keyring.name} secret keys`,
    fileName: `${keyring.name}-secret-keys.asc`,
    contents: exported.stdout,
  });

  // Always export *all* public keys, with no fingerprint filter: this is the
  // only artifact that carries other people's keys, and a keyring is not
  // reproducible without them. Not sensitive, but kept in the same store so
  // there's one mechanism.
  // Withheld not because it's sensitive but because it's ~170KB of armor that
  // buries the rest of the run.
  const publicKeys = await runGpg(
    gpg,
    keyring,
    ['--batch', '--armor', '--export'],
    { secret: true },
  );

  const publicReference =
    publicKeys.success && publicKeys.stdout.includes('PUBLIC KEY BLOCK')
      ? await createDocument({
        title: `GPG ${keyring.name} public keys`,
        fileName: `${keyring.name}-public-keys.asc`,
        contents: publicKeys.stdout,
      })
      : null;

  const ownertrust = await runGpg(gpg, keyring, ['--export-ownertrust']);

  const trustReference = ownertrust.success && ownertrust.stdout.trim()
    ? await createDocument({
      title: `GPG ${keyring.name} ownertrust`,
      fileName: `${keyring.name}-ownertrust.txt`,
      contents: ownertrust.stdout,
    })
    : null;

  const manifest = await loadManifest();

  const shared = {
    kind: 'document' as const,
    mode: '0600',
    hosts: keyring.hosts,
    ...(keyring.home ? { gnupgHome: keyring.home } : {}),
  };

  await saveManifest({
    ...manifest,
    secrets: {
      ...manifest.secrets,
      [secretKeyName(keyring.name)]: {
        ...shared,
        reference: keyReference,
        description: `Armored secret keys for the ${keyring.name} keyring`,
      },
      ...(publicReference
        ? {
          [publicKeyName(keyring.name)]: {
            ...shared,
            reference: publicReference,
            description:
              `All public keys in the ${keyring.name} keyring, including ` +
              'third parties',
          },
        }
        : {}),
      ...(trustReference
        ? {
          [ownertrustName(keyring.name)]: {
            ...shared,
            reference: trustReference,
            description: `Ownertrust for the ${keyring.name} keyring`,
          },
        }
        : {}),
    },
  });

  console.log(`✓ recorded ${keyReference}`);
  if (publicReference) console.log(`✓ recorded ${publicReference}`);
  if (trustReference) console.log(`✓ recorded ${trustReference}`);
};
