import {
  blue,
  bold,
  gray,
  yellow,
} from 'https://deno.land/std@0.192.0/fmt/colors.ts';

import { configuration } from './configuration.ts';
import { pathExists, shell } from './helpers.ts';
import { bin, findBrewBinary, requireBrewBinary } from './system.ts';

// Current 1Password 8 installs as `1Password.app`; earlier 8.x releases used
// `1Password 8.app`. Checking only the latter made `guiInstalled` always false,
// which silently skipped the (preferred) GUI-integration path and dropped
// straight into headless signin.
const ONEPASSWORD_GUI_APP_CANDIDATES = [
  '/Applications/1Password.app',
  '/Applications/1Password 8.app',
] as const;

/** Resolved path to the installed 1Password desktop app, or null. */
const findGuiApp = async (): Promise<string | null> => {
  for (const candidate of ONEPASSWORD_GUI_APP_CANDIDATES) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
};

// The flake app's PATH excludes the Homebrew prefix, so `op` is never on PATH
// and `which op` can't find it — resolve it under the brew prefixes instead.
const requireOp = (): Promise<string> => requireBrewBinary('op');

/**
 * Global flags for `op` *data* commands (read, document get, item get, …).
 *
 * `--account` pins which account is used. Without it `op` can fail with
 * "multiple accounts found" on a machine signed into both a personal and a work
 * account, and vault names aren't unique across accounts, so the flag makes
 * resolution deterministic rather than dependent on desktop-app state.
 *
 * Not applicable to `whoami` — see `isOpAuthenticated`.
 */
const opFlags = (): readonly string[] => {
  const account = configuration.onePassword?.account;

  return account ? ['--account', account] : [];
};

/**
 * Reusable interface to the 1Password CLI (`op`).
 *
 * This module is intentionally generic: bootstrap modules that need secrets
 * (e.g. `resilio.ts`) call into `readSecret` rather than reaching for `op`
 * themselves. Future phases can use this same surface — for example a
 * hypothetical `gpg-key` phase could call:
 *
 * ```ts
 * const armored = await readSecret('GPG Bootstrap Key/private');
 * await Deno.writeTextFile(`${HOME}/.gnupg/bootstrap.asc`, armored);
 * ```
 *
 * to materialize a GPG key from a 1Password document/field on first run.
 */

interface OpInstallationStatus {
  readonly cliInstalled: boolean;
  readonly guiInstalled: boolean;
}

/**
 * Probes the current installation state of the 1Password CLI and GUI.
 */
const inspectInstallation = async (): Promise<OpInstallationStatus> => {
  const cliInstalled = (await findBrewBinary('op')) !== null;
  const guiInstalled = (await findGuiApp()) !== null;
  return { cliInstalled, guiInstalled };
};

/**
 * Installs the 1Password GUI and CLI via Homebrew, skipping casks that are
 * already present. Darwin-only.
 */
export const ensureOpInstalled = async (): Promise<void> => {
  if (Deno.build.os !== 'darwin') {
    console.log('Skipping 1Password install on non-darwin host');
    return;
  }

  const { cliInstalled, guiInstalled } = await inspectInstallation();

  if (cliInstalled && guiInstalled) {
    console.log('✓ 1Password GUI + CLI already installed');
    return;
  }

  const casks: string[] = [];
  if (!guiInstalled) casks.push('1password');
  if (!cliInstalled) casks.push('1password-cli');

  console.log(`Installing 1Password casks: ${casks.join(', ')}`);
  await shell(await requireBrewBinary('brew'), [
    'install',
    '--cask',
    ...casks,
  ]);
};

/**
 * Returns true when `op whoami` succeeds — meaning the CLI has a valid
 * session token (either via GUI integration or a saved `op signin` session).
 */
const isOpAuthenticated = async (): Promise<boolean> => {
  const op = await findBrewBinary('op');
  if (!op) return false;
  // Deliberately *not* passing `--account`. With desktop-app integration
  // `whoami` reports the session the app is providing, and adding the flag makes
  // `op` look for an explicit `op signin` session for that account instead —
  // which doesn't exist, so it fails with "account is not signed in" on a
  // perfectly healthy machine. Data commands take the flag happily; this one
  // does not. Adding it here would make the probe always fail and send
  // `ensureOpAuthenticated` through its guided loop into a throw.
  const result = await shell(op, ['whoami'], { error: false });
  return result.success;
};

/**
 * Reads a single line of trimmed input from stdin. Used for interactive
 * signin prompts.
 *
 * @param promptText Text to print before reading
 *
 * @returns Trimmed user input, or empty string on EOF
 */
const promptLine = async (promptText: string): Promise<string> => {
  await Deno.stdout.write(new TextEncoder().encode(promptText));

  const buffer = new Uint8Array(1024);
  const read = await Deno.stdin.read(buffer);
  if (read === null) return '';

  return new TextDecoder().decode(buffer.subarray(0, read)).trim();
};

/**
 * Walks the user through enabling the 1Password GUI's CLI integration. The
 * GUI does the heavy lifting; once "Connect with 1Password CLI" is toggled,
 * `op` inherits sessions transparently and we never have to type a password.
 */
const guideGuiIntegration = async (): Promise<void> => {
  console.log(
    blue(bold('\n1Password GUI integration')) +
      '\n' +
      gray(
        [
          '  1. Open 1Password (the GUI app) and sign in.',
          '  2. Open Settings -> Developer.',
          '  3. Check "Integrate with 1Password CLI".',
          '  4. Approve the biometric prompt.',
          '',
          '  Once enabled, `op whoami` should succeed without an explicit',
          '  signin — biometric unlocks are forwarded from the GUI to the',
          '  CLI automatically.',
        ].join('\n'),
      ),
  );

  // Best-effort: open the GUI for the user. Failure is non-fatal — they may
  // already have it open or running.
  const app = await findGuiApp();
  if (app) await shell(bin.open, ['-g', app], { error: false });

  await promptLine(yellow('\nPress Enter once GUI integration is enabled... '));
};

/**
 * Ensures `op whoami` succeeds via the 1Password desktop app's CLI
 * integration. No passwords or session tokens are involved. Whenever the app
 * is installed `op` defers to it, so this is the path that actually works —
 * and it's not macOS-specific: the Linux desktop app offers the same
 * integration, so this generalizes to any host with a desktop session.
 *
 * Loops the guided flow so the user can retry without re-running bootstrap.
 *
 * There's no way to detect that the "Integrate with 1Password CLI" toggle is
 * enabled short of trying `op whoami`, so we guide, then probe.
 *
 * A *truly* headless host (no desktop session at all) should use a 1Password
 * service account via `OP_SERVICE_ACCOUNT_TOKEN` rather than interactive
 * signin. An earlier `op account add` + `op signin` fallback lived here, but
 * it's unreachable wherever the app is installed and is the wrong mechanism
 * for automation, so it was removed.
 */
export const ensureOpAuthenticated = async (): Promise<void> => {
  if (Deno.build.os !== 'darwin') {
    // Linux NUC has no compelling op use case yet; gate aggressively until
    // there is one. See `bootstrap.ts` for the phase-level gate.
    return;
  }

  if (await isOpAuthenticated()) {
    console.log('✓ 1Password CLI already authenticated');
    return;
  }

  if (!(await findGuiApp())) {
    throw new Error(
      'The 1Password desktop app is not installed, so CLI integration is ' +
        'unavailable. Install it (the op-installed phase does this) and re-run.',
    );
  }

  // Retry the guided flow a few times — the user may need a couple of passes
  // to find the toggle. Capped so a non-interactive run can't spin forever.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await guideGuiIntegration();

    if (await isOpAuthenticated()) {
      console.log('✓ 1Password CLI authenticated via GUI integration');
      return;
    }

    console.log(
      yellow('`op whoami` still failing — check the toggle and try again.'),
    );
  }

  throw new Error(
    '1Password CLI authentication did not complete. Enable Settings -> ' +
      'Developer -> "Integrate with 1Password CLI" in the desktop app, ' +
      'confirm `op whoami` succeeds, then re-run bootstrap.',
  );
};

/**
 * Normalizes a secret reference. Accepts:
 *
 *   - `op://Vault/Item/field`        — fully qualified, returned as-is
 *   - `Vault/Item/field`             — prepended with `op://`
 *   - `Item/field`                   — vault filled in from `onePassword.vault`
 *
 * Throws if the short form is used without a configured default vault.
 *
 * @param reference Raw reference from configuration
 *
 * @returns Fully qualified `op://...` reference
 */
const normalizeReference = (reference: string): string => {
  if (reference.startsWith('op://')) return reference;

  const segments = reference.split('/').filter((part) => part.length > 0);

  if (segments.length === 3) return `op://${segments.join('/')}`;

  if (segments.length === 2) {
    const vault = configuration.onePassword?.vault;
    if (!vault) {
      throw new Error(
        `Short-form 1Password reference "${reference}" requires ` +
          '`configuration.onePassword.vault` to be set',
      );
    }
    return `op://${vault}/${segments.join('/')}`;
  }

  throw new Error(
    `Unrecognized 1Password reference: "${reference}". ` +
      'Expected "op://Vault/Item/field", "Vault/Item/field", or "Item/field".',
  );
};

/**
 * Invokes `op read <reference>` once and returns the secret. Surfaces stderr
 * if `op` fails — sessions can expire silently and the error message is the
 * useful signal for the caller's retry path.
 */
const opRead = async (
  reference: string,
): Promise<{ success: true; value: string } | { success: false; stderr: string }> => {
  const result = await shell(await requireOp(), ['read', reference, ...opFlags()], {
    error: false,
    secret: true,
  });
  if (result.success) {
    return { success: true, value: result.stdout.trim() };
  }
  return { success: false, stderr: result.stderr };
};

/**
 * Reads a secret from 1Password. Reference can be fully qualified or short
 * form (see `normalizeReference`). Retries once after re-authenticating if
 * the initial read fails (sessions can expire mid-bootstrap).
 *
 * @param reference Configured secret reference
 *
 * @returns Secret value with surrounding whitespace trimmed
 */
export const readSecret = async (reference: string): Promise<string> => {
  const resolved = normalizeReference(reference);

  const first = await opRead(resolved);
  if (first.success) return first.value;

  console.warn(
    yellow(
      `\`op read\` failed for ${resolved}; re-authenticating and retrying.\n` +
        first.stderr,
    ),
  );

  await ensureOpAuthenticated();

  const second = await opRead(resolved);
  if (second.success) return second.value;

  throw new Error(
    `Failed to read 1Password secret ${resolved} after re-auth:\n${second.stderr}`,
  );
};

interface DocumentReference {
  /** Item title, UUID, or domain — whatever `op document get` will accept. */
  readonly item: string;
  /** Vault to scope the lookup to, when one could be determined. */
  readonly vault: string | undefined;
}

/**
 * Splits a document reference into the item and vault `op document get` wants.
 *
 * `op document get` does *not* understand `op://` references — it fails with
 * `"op://…" isn't an item. Specify the item with its UUID, name, or domain.`
 * Only `op read` parses that syntax, and only for *field* references. Since
 * `createDocument` records `op://Vault/Item` in the manifest (opaque UUIDs would
 * defeat the point of a reviewable, committed manifest), the reference has to be
 * taken apart again here.
 *
 * Anything that isn't an `op://Vault/Item` is passed through untouched, so a
 * bare title or UUID still works, with the default vault applied.
 */
const parseDocumentReference = (reference: string): DocumentReference => {
  const fallbackVault = configuration.onePassword?.vault;

  if (!reference.startsWith('op://')) {
    return { item: reference, vault: fallbackVault };
  }

  const [vault, ...rest] = reference.slice('op://'.length).split('/').filter(
    (segment) => segment.length > 0,
  );

  if (!vault || rest.length === 0) {
    throw new Error(
      `Unusable 1Password document reference "${reference}": expected ` +
        'op://Vault/Item.',
    );
  }

  // A third segment makes it a *field* reference, which belongs to `op read`.
  // Documents are whole items, so anything beyond the vault is the title.
  return { item: rest.join('/'), vault };
};

/**
 * Fetches a 1Password *document* (file attachment) by name or `op://Vault/Item`
 * reference, returning its contents.
 *
 * Documents are a separate `op` surface from fields — `op read` handles field
 * references, `op document get` handles attachments — and are the right home
 * for multi-line material like an armored key export.
 *
 * @param nameOrReference Document title, or `op://Vault/Item`
 *
 * @returns The document contents
 * @throws When `op document get` fails after a re-auth attempt
 */
export const readDocument = async (
  nameOrReference: string,
): Promise<string> => {
  const args = (): string[] => {
    const { item, vault } = parseDocumentReference(nameOrReference);

    return [
      'document',
      'get',
      item,
      ...(vault ? ['--vault', vault] : []),
      ...opFlags(),
    ];
  };

  const attempt = async () =>
    await shell(await requireOp(), args(), { error: false, secret: true });

  const first = await attempt();
  if (first.success) return first.stdout;

  console.warn(
    yellow(
      `\`op document get\` failed for ${nameOrReference}; ` +
        `re-authenticating and retrying.\n${first.stderr}`,
    ),
  );

  await ensureOpAuthenticated();

  const second = await attempt();
  if (second.success) return second.stdout;

  throw new Error(
    `Failed to read 1Password document ${nameOrReference} after re-auth:\n` +
      second.stderr,
  );
};

interface CreateDocumentOptions {
  readonly title: string;
  readonly fileName: string;
  readonly contents: string;
  /** Overrides `onePassword.secretsVault`. */
  readonly vault?: string;
}

/**
 * Creates (or replaces) a 1Password document from in-memory contents and
 * returns its `op://Vault/Title` reference.
 *
 * `op document create` reads from stdin with `-`, so the payload never touches
 * disk and never appears in argv. When a document with this title already
 * exists it is edited in place, keeping the reference — and therefore the
 * manifest entry — stable across re-exports.
 *
 * @returns The `op://` reference to store in the manifest
 */
export const createDocument = async (
  options: CreateDocumentOptions,
): Promise<string> => {
  const { title, fileName, contents } = options;
  const vault = options.vault ?? configuration.onePassword?.secretsVault ??
    configuration.onePassword?.vault;

  if (!vault) {
    throw new Error(
      'No vault configured for document creation: set ' +
        '`onePassword.secretsVault`.',
    );
  }

  const op = await requireOp();

  const exists = await shell(
    op,
    ['item', 'get', title, '--vault', vault, ...opFlags()],
    { error: false },
  );

  const args = exists.success
    ? [
      'document',
      'edit',
      title,
      '-',
      '--vault',
      vault,
      '--file-name',
      fileName,
      ...opFlags(),
    ]
    : [
      'document',
      'create',
      '-',
      '--title',
      title,
      '--vault',
      vault,
      '--file-name',
      fileName,
      ...opFlags(),
    ];

  const child = new Deno.Command(op, {
    args,
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();

  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(contents));
  await writer.close();

  const { success, stderr } = await child.output();

  if (!success) {
    throw new Error(
      `\`op document ${exists.success ? 'edit' : 'create'}\` failed for ` +
        `${title}:\n${new TextDecoder().decode(stderr)}`,
    );
  }

  return `op://${vault}/${title}`;
};
