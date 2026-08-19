import { bold, gray, green, red } from 'https://deno.land/std@0.192.0/fmt/colors.ts';
import { parse } from 'https://deno.land/std@0.192.0/flags/mod.ts';

import { environment } from './configuration.ts';
import { exportGpgKeys, importGpgKeys } from './gpg.ts';
import {
  appliesToHost,
  entriesForHost,
  loadManifest,
  manifestPath,
  saveManifest,
  secretEntrySchema,
} from './manifest.ts';
import { readDocument, readSecret } from './onepassword.ts';

/**
 * `bootstrap secrets` — manage the 1Password-backed secret manifest.
 *
 * The manifest (`secrets.json`) records `op://` references, which are not
 * secrets, so it is committed and reviewable. This is the interface to it:
 * capture material into 1Password, record where it lives, and put it back on a
 * new machine — the role the git-crypt'd castle used to play.
 *
 * Reached only through `src/cli.ts`; `gpg` stays a subcommand here rather than
 * becoming its own binary precisely so it can't shadow the real `gpg`.
 */

export const SECRETS_USAGE =
  `${bold('bootstrap secrets')} — 1Password-backed secret manifest

  … list                              show entries (● applies to this host)
  … check                             verify every reference resolves
  … materialize [<name>…]             write entries with a target to disk (0600)
  … add <name> --reference <op://…> [options]
                                      record an existing item's reference
  … gpg export [<keyring>]            capture a keyring -> 1Password (default: first)
  … gpg import                        import every keyring for this host

  add options: --target <path-relative-to-$HOME> --mode <0600>
               --hosts <a,b|*> --kind <document|field> --description <text>

Mutating commands (add, gpg export) need a writable checkout — run them from a
clone, not \`nix run github:…\`. \`bootstrap secrets list\` prints which manifest
resolved; SECRETS_MANIFEST overrides it.`;

const list = async (): Promise<void> => {
  const manifest = await loadManifest();
  const { hostname } = environment();
  const names = Object.keys(manifest.secrets).sort();

  // Printed unconditionally: which file is in play is the first thing to check
  // when a manifest looks unexpectedly empty or a write is refused.
  console.log(gray(`\nmanifest: ${await manifestPath()}`));

  if (names.length === 0) {
    console.log(
      gray('Manifest is empty. `bootstrap secrets gpg export` is a good start.'),
    );
    return;
  }

  console.log(bold(`\n${names.length} secret(s) — host: ${hostname}\n`));

  for (const name of names) {
    const entry = manifest.secrets[name];
    if (!entry) continue;

    const marker = appliesToHost(entry, hostname) ? green('●') : gray('○');
    const hosts = entry.hosts.join(',');
    const target = entry.target ? ` → ~/${entry.target} (${entry.mode})` : '';

    console.log(`${marker} ${bold(name)}  ${gray(`[${hosts}]`)}${target}`);
    console.log(`  ${gray(entry.reference)}`);
    if (entry.description) console.log(`  ${gray(entry.description)}`);
  }

  console.log(
    gray('\n● applies to this host, ○ gated to others\n'),
  );
};

const fetch = (kind: 'document' | 'field', reference: string) =>
  kind === 'document' ? readDocument(reference) : readSecret(reference);

const check = async (): Promise<void> => {
  const manifest = await loadManifest();
  const entries = Object.entries(manifest.secrets);

  console.log(gray(`\nmanifest: ${await manifestPath()}`));

  if (entries.length === 0) {
    console.log(gray('Manifest is empty; nothing to check.'));
    return;
  }

  let failures = 0;

  for (const [name, entry] of entries) {
    try {
      const value = await fetch(entry.kind, entry.reference);

      if (!value.trim()) throw new Error('resolved but empty');

      console.log(`${green('✓')} ${name} ${gray(`(${value.length} bytes)`)}`);
    } catch (error) {
      failures += 1;
      const message = error instanceof Error
        ? error.message.split('\n')[0]
        : String(error);
      console.log(`${red('✗')} ${name} — ${message}`);
    }
  }

  if (failures > 0) {
    throw new Error(`${failures} reference(s) failed to resolve`);
  }
};

const materialize = async (only: readonly string[]): Promise<void> => {
  const manifest = await loadManifest();
  const { HOME } = environment();

  const selected = entriesForHost(manifest).filter(([name, entry]) =>
    entry.target !== undefined &&
    (only.length === 0 || only.includes(name))
  );

  if (selected.length === 0) {
    console.log(
      gray('Nothing to materialize for this host (no entries with a target).'),
    );
    return;
  }

  for (const [name, entry] of selected) {
    if (!entry.target) continue;

    const path = `${HOME}/${entry.target}`;
    const contents = await fetch(entry.kind, entry.reference);

    await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    await Deno.writeTextFile(path, contents);
    await Deno.chmod(path, parseInt(entry.mode, 8));

    console.log(`${green('✓')} ${name} → ${path} (${entry.mode})`);
  }
};

interface AddOptions {
  readonly reference?: string;
  readonly kind?: string;
  readonly description?: string;
  readonly target?: string;
  readonly mode?: string;
  readonly hosts?: string;
}

const add = async (
  name: string | undefined,
  options: AddOptions,
): Promise<void> => {
  if (!name) throw new Error('`bootstrap secrets add` requires a name');
  if (!options.reference) {
    throw new Error(
      '`bootstrap secrets add` requires --reference op://Vault/Item[/field]',
    );
  }

  const manifest = await loadManifest();

  const entry = secretEntrySchema.parse({
    kind: options.kind ?? 'document',
    reference: options.reference,
    description: options.description ?? '',
    target: options.target,
    mode: options.mode ?? '0600',
    hosts: options.hosts ? options.hosts.split(',') : ['*'],
  });

  await saveManifest({
    ...manifest,
    secrets: { ...manifest.secrets, [name]: entry },
  });

  console.log(`${green('✓')} recorded ${bold(name)} → ${entry.reference}`);
};

/**
 * Dispatches the `secrets` subcommand tree.
 *
 * Throws rather than exiting: `src/cli.ts` owns error reporting so every
 * subcommand fails the same way.
 *
 * @param argv Arguments after `secrets`
 */
export const runSecrets = async (
  argv: readonly string[],
): Promise<void> => {
  // Every option is declared a string: std's parser is numeric by default, so
  // `--mode 0600` would otherwise arrive as the number 600 with the leading
  // zero silently dropped.
  const parsed = parse([...argv], {
    string: ['reference', 'kind', 'description', 'target', 'mode', 'hosts'],
  });
  const positional = parsed._.map(String);
  const [command, subcommand] = positional;

  switch (command) {
    case 'list':
      return await list();
    case 'check':
      return await check();
    case 'materialize':
      return await materialize(positional.slice(1));
    case 'add':
      return await add(subcommand, {
        reference: parsed['reference'],
        kind: parsed['kind'],
        description: parsed['description'],
        target: parsed['target'],
        mode: parsed['mode'],
        hosts: parsed['hosts'],
      });
    case 'gpg':
      if (subcommand === 'export') return await exportGpgKeys(positional[2]);
      if (subcommand === 'import') return await importGpgKeys();
      throw new Error(`Unknown gpg subcommand: ${subcommand ?? '(none)'}`);
    case undefined:
    case 'help':
    case '--help':
      console.log(SECRETS_USAGE);
      return;
    default:
      throw new Error(`Unknown secrets command: ${command}`);
  }
};
