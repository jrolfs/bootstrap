import { bold, gray, green, red, yellow } from 'https://deno.land/std@0.192.0/fmt/colors.ts';

import { environment } from './configuration.ts';
import { exportGpgKeys, importGpgKeys } from './gpg.ts';
import {
  appliesToHost,
  entriesForHost,
  loadManifest,
  saveManifest,
  secretEntrySchema,
} from './manifest.ts';
import { readDocument, readSecret } from './onepassword.ts';

/**
 * `secrets` — manage the 1Password-backed secret manifest.
 *
 * The manifest (`secrets.json`) records `op://` references, which are not
 * secrets, so it is committed and reviewable. This CLI is the interface to it:
 * capture material into 1Password, record where it lives, and put it back on a
 * new machine — the role the git-crypt'd castle used to play.
 */

const USAGE = `${bold('secrets')} — 1Password-backed secret manifest

  secrets list                       show manifest entries (● applies to this host)
  secrets check                       verify every reference resolves
  secrets materialize [<name>…]       write entries with a target to disk (0600)
  secrets add <name> --reference <op://…> [options]
                                      record an existing item's reference
  secrets gpg export [<keyring>]      capture a keyring -> 1Password (default: first)
  secrets gpg import                  import every keyring for this host

  add options: --target <path-relative-to-$HOME> --mode <0600>
               --hosts <a,b|*> --kind <document|field> --description <text>

Mutating commands (add, gpg export) need a writable checkout — run them via
\`nix run .#secrets\` from a clone, not \`nix run github:…\`.`;

interface ParsedArgs {
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string>>;
}

const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;

    if (argument.startsWith('--')) {
      const key = argument.slice(2);
      const next = argv[index + 1];

      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        index += 1;
      } else {
        flags[key] = 'true';
      }
      continue;
    }

    positional.push(argument);
  }

  return { positional, flags };
};

const list = async (): Promise<void> => {
  const manifest = await loadManifest();
  const { hostname } = environment();
  const names = Object.keys(manifest.secrets).sort();

  if (names.length === 0) {
    console.log(gray('Manifest is empty. `secrets gpg export` is a good start.'));
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

const add = async (
  name: string | undefined,
  flags: Readonly<Record<string, string>>,
): Promise<void> => {
  if (!name) throw new Error('`secrets add` requires a name');
  if (!flags['reference']) {
    throw new Error('`secrets add` requires --reference op://Vault/Item[/field]');
  }

  const manifest = await loadManifest();

  const entry = secretEntrySchema.parse({
    kind: flags['kind'] ?? 'document',
    reference: flags['reference'],
    description: flags['description'] ?? '',
    target: flags['target'],
    mode: flags['mode'] ?? '0600',
    hosts: flags['hosts'] ? flags['hosts'].split(',') : ['*'],
  });

  await saveManifest({
    ...manifest,
    secrets: { ...manifest.secrets, [name]: entry },
  });

  console.log(`${green('✓')} recorded ${bold(name)} → ${entry.reference}`);
};

const main = async (): Promise<void> => {
  const { positional, flags } = parseArgs(Deno.args);
  const [command, subcommand] = positional;

  try {
    switch (command) {
      case 'list':
        await list();
        return;
      case 'check':
        await check();
        return;
      case 'materialize':
        await materialize(positional.slice(1));
        return;
      case 'add':
        await add(subcommand, flags);
        return;
      case 'gpg':
        if (subcommand === 'export') {
          return await exportGpgKeys(positional[2]);
        }
        if (subcommand === 'import') return await importGpgKeys();
        throw new Error(`Unknown gpg subcommand: ${subcommand ?? '(none)'}`);
      case undefined:
      case 'help':
      case '--help':
        console.log(USAGE);
        return;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    console.error(
      red(error instanceof Error ? error.message : String(error)),
    );
    console.error(yellow('\nRun `secrets help` for usage.'));
    Deno.exit(1);
  }
};

if (import.meta.main) main();
