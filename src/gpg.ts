import { blue, bold, gray, yellow } from 'https://deno.land/std@0.192.0/fmt/colors.ts';

import { configuration } from './configuration.ts';
import { shell } from './helpers.ts';
import { readDocument } from './onepassword.ts';
import { findBrewBinary } from './system.ts';

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
 * Imports the GPG secret key (and ownertrust) from 1Password documents.
 *
 * Key material is piped directly into `gpg --import` on stdin — never written
 * to a temp file. The import is skipped when the key is already present, so
 * re-runs are cheap.
 *
 * If the key is later moved to a hardware token, the on-disk key files become
 * stubs that `gpg --card-status` regenerates from the inserted card, so this
 * phase becomes a no-op (the fingerprint check short-circuits) and only the
 * non-secret bits — public key, ownertrust, `sshcontrol` — still need to reach
 * a new machine.
 */
export const importGpgKeys = async (): Promise<void> => {
  const gpgConfiguration = configuration.gpg;

  if (!gpgConfiguration) {
    console.log('No gpg configuration; skipping key import');
    return;
  }

  const { fingerprint, secretKeyOpReference, ownertrustOpReference } =
    gpgConfiguration;

  if (!secretKeyOpReference) {
    console.log(
      gray(
        'No gpg.secretKeyOpReference configured; skipping key import.\n' +
          '  Export with `gpg --export-secret-keys --armor <fpr>`, store it as a\n' +
          '  1Password document, and set the reference to enable this phase.',
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

  const armored = await readDocument(secretKeyOpReference);

  if (!armored.includes('BEGIN PGP PRIVATE KEY BLOCK')) {
    throw new Error(
      `1Password document ${secretKeyOpReference} does not look like an ` +
        'armored secret key export (no "BEGIN PGP PRIVATE KEY BLOCK").',
    );
  }

  const imported = await pipeInto(gpg, ['--batch', '--import'], armored);

  if (!imported.success) {
    throw new Error(`\`gpg --import\` failed:\n${imported.stderr}`);
  }

  console.log('✓ GPG secret key imported');

  if (!ownertrustOpReference) {
    console.log(
      gray(
        'No gpg.ownertrustOpReference configured; the imported key has no\n' +
          '  assigned trust. Set it, or run `gpg --edit-key <fpr> trust`.',
      ),
    );
    return;
  }

  const ownertrust = await readDocument(ownertrustOpReference);
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
