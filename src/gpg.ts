import { blue, bold, gray, yellow } from 'https://deno.land/std@0.192.0/fmt/colors.ts';

import { configuration } from './configuration.ts';
import { shell } from './helpers.ts';
import { loadManifest, saveManifest } from './manifest.ts';
import { createDocument, readDocument } from './onepassword.ts';
import { findBrewBinary } from './system.ts';

/** Manifest keys the GPG commands read and write. */
const SECRET_KEY = 'gpg-secret-key';
const OWNERTRUST = 'gpg-ownertrust';

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

/**
 * True when the keyring already contains `fingerprint` as a *secret* key.
 */
const hasSecretKey = async (
  gpg: string,
  fingerprint: string,
): Promise<boolean> => {
  const result = await shell(gpg, ['-K', '--with-colons'], { error: false });
  if (!result.success) return false;

  return result.stdout.toUpperCase().includes(fingerprint.toUpperCase());
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
): Promise<{ success: boolean; stderr: string }> => {
  const child = new Deno.Command(command, {
    args: [...args],
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();

  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();

  const { success, stderr } = await child.output();

  return { success, stderr: new TextDecoder().decode(stderr) };
};

/**
 * Resolves a manifest entry's reference, or null when it isn't recorded yet.
 */
const referenceFor = async (name: string): Promise<string | null> => {
  const manifest = await loadManifest();
  return manifest.secrets[name]?.reference ?? null;
};

/**
 * Imports the GPG secret key (and ownertrust) from 1Password documents recorded
 * in the manifest.
 *
 * Key material is piped directly into `gpg --import` on stdin — never written to
 * a temp file, never in argv. The import is skipped when the key is already
 * present, so re-runs are cheap.
 *
 * If the key is later moved to a hardware token the on-disk key files become
 * stubs that `gpg --card-status` regenerates from the inserted card, so this
 * becomes a no-op (the fingerprint check short-circuits) and only the non-secret
 * bits — public key, ownertrust, `sshcontrol` — still need to reach a machine.
 */
export const importGpgKeys = async (): Promise<void> => {
  const fingerprint = configuration.gpg?.fingerprint;

  if (!fingerprint) {
    console.log('No gpg.fingerprint configured; skipping key import');
    return;
  }

  const secretReference = await referenceFor(SECRET_KEY);

  if (!secretReference) {
    console.log(
      gray(
        `No \`${SECRET_KEY}\` in the manifest; skipping key import.\n` +
          '  Run `secrets gpg export` on a machine that already has the key.',
      ),
    );
    return;
  }

  const gpg = await findGpg();

  if (!gpg) {
    console.log(
      yellow('`gpg` not found; skipping key import (re-run after the switch).'),
    );
    return;
  }

  if (await hasSecretKey(gpg, fingerprint)) {
    console.log(`✓ GPG secret key ${fingerprint} already present`);
    return;
  }

  console.log(blue(bold('\nImporting GPG secret key from 1Password')));

  const armored = await readDocument(secretReference);

  if (!armored.includes('BEGIN PGP PRIVATE KEY BLOCK')) {
    throw new Error(
      `1Password document ${secretReference} does not look like an armored ` +
        'secret key export (no "BEGIN PGP PRIVATE KEY BLOCK").',
    );
  }

  const imported = await pipeInto(gpg, ['--batch', '--import'], armored);

  if (!imported.success) {
    throw new Error(`\`gpg --import\` failed:\n${imported.stderr}`);
  }

  console.log('✓ GPG secret key imported');

  const ownertrustReference = await referenceFor(OWNERTRUST);

  if (!ownertrustReference) {
    console.log(
      gray(
        `No \`${OWNERTRUST}\` in the manifest; the imported key has no ` +
          'assigned trust.',
      ),
    );
    return;
  }

  const ownertrust = await readDocument(ownertrustReference);
  const trusted = await pipeInto(
    gpg,
    ['--batch', '--import-ownertrust'],
    ownertrust,
  );

  if (!trusted.success) {
    console.log(
      yellow(`\`gpg --import-ownertrust\` failed:\n${trusted.stderr}`),
    );
    return;
  }

  console.log('✓ GPG ownertrust imported');
};

/**
 * Captures the current machine's GPG secret key and ownertrust into 1Password
 * documents, recording their references in the manifest.
 *
 * Run this from a machine that already holds the key — it's the counterpart to
 * `importGpgKeys` and removes the manual `op document create` dance.
 *
 * The export is streamed from `gpg` to `op` in memory; nothing is written to
 * disk. Keep a passphrase on the key so the stored copy is encrypted at rest
 * inside 1Password too.
 */
export const exportGpgKeys = async (): Promise<void> => {
  const fingerprint = configuration.gpg?.fingerprint;

  if (!fingerprint) {
    throw new Error('No gpg.fingerprint configured; cannot export');
  }

  const gpg = await findGpg();
  if (!gpg) throw new Error('`gpg` not found; cannot export');

  if (!(await hasSecretKey(gpg, fingerprint))) {
    throw new Error(
      `This machine has no secret key for ${fingerprint}; run the export from ` +
        'a machine that does.',
    );
  }

  console.log(blue(bold('\nExporting GPG secret key to 1Password')));

  const exported = await shell(
    gpg,
    ['--batch', '--armor', '--export-secret-keys', fingerprint],
    { error: false },
  );

  if (!exported.success || !exported.stdout.includes('PRIVATE KEY BLOCK')) {
    throw new Error(
      `\`gpg --export-secret-keys\` produced no key:\n${exported.stderr}`,
    );
  }

  const keyReference = await createDocument({
    title: 'GPG Secret Key',
    fileName: `${fingerprint}.asc`,
    contents: exported.stdout,
  });

  const ownertrust = await shell(gpg, ['--export-ownertrust'], {
    error: false,
  });

  const trustReference = ownertrust.success && ownertrust.stdout.trim()
    ? await createDocument({
      title: 'GPG Ownertrust',
      fileName: 'ownertrust.txt',
      contents: ownertrust.stdout,
    })
    : null;

  const manifest = await loadManifest();

  await saveManifest({
    ...manifest,
    secrets: {
      ...manifest.secrets,
      [SECRET_KEY]: {
        kind: 'document',
        reference: keyReference,
        description: `Armored secret key export for ${fingerprint}`,
        mode: '0600',
        hosts: ['*'],
      },
      ...(trustReference
        ? {
          [OWNERTRUST]: {
            kind: 'document' as const,
            reference: trustReference,
            description: 'gpg --export-ownertrust output',
            mode: '0600',
            hosts: ['*'],
          },
        }
        : {}),
    },
  });

  console.log(`✓ Exported and recorded ${keyReference}`);
  if (trustReference) console.log(`✓ Exported and recorded ${trustReference}`);
};
