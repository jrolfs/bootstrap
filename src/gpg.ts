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

/** Manifest key names per keyring. */
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
) => {
  const home = homeFor(keyring);

  return await shell(gpg, [...args], {
    error: false,
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
 * Imports one keyring's secret keys and ownertrust from 1Password.
 *
 * Skipped when the keyring already holds the key, so re-runs are cheap. A
 * secret-key export embeds the public half, so this reconstructs the public
 * keybox as well — no separate `.kbx` handling required.
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
          `${keyring.name}. Run \`secrets gpg export ${keyring.name}\` from a ` +
          'machine that holds it.',
      ),
    );
    return;
  }

  if (!appliesToHost(entry, hostname)) {
    console.log(gray(`${keyring.name} is not for this host; skipping`));
    return;
  }

  if (await hasSecretKey(gpg, keyring)) {
    console.log(`✓ ${keyring.name} secret key(s) already present`);
    return;
  }

  console.log(blue(bold(`\nImporting ${keyring.name} secret key(s)`)));

  const home = homeFor(keyring);

  // A fresh GNUPGHOME has to exist with 0700 before gpg will use it.
  if (home) {
    await Deno.mkdir(home, { recursive: true, mode: 0o700 });
    await Deno.chmod(home, 0o700);
  }

  const gpgEnvironment = home
    ? { ...Deno.env.toObject(), GNUPGHOME: home }
    : undefined;

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
 */
export const importGpgKeys = async (): Promise<void> => {
  const keyrings = keyringsForHost();

  if (keyrings.length === 0) {
    console.log('No gpg keyrings configured for this host; skipping');
    return;
  }

  const gpg = await findGpg();

  if (!gpg) {
    console.log(
      yellow('`gpg` not found; skipping key import (re-run after the switch).'),
    );
    return;
  }

  const manifest = await loadManifest();

  for (const keyring of keyrings) {
    await importKeyring(gpg, keyring, manifest);
  }
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
  ]);

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
  if (trustReference) console.log(`✓ recorded ${trustReference}`);
};
