import {
  blue,
  bold,
  gray,
  yellow,
} from 'https://deno.land/std@0.192.0/fmt/colors.ts';

import { configuration, environment } from './configuration.ts';
import { pathExists, promptLine, promptSecret, shell } from './helpers.ts';
import {
  bin,
  findBrewBinary,
  findSystemBinary,
  requireBrewBinary,
  requireSystemBinary,
} from './system.ts';

// Current 1Password 8 installs as `1Password.app`; earlier 8.x releases used
// `1Password 8.app`. Checking only the latter made `guiInstalled` always false,
// which silently skipped the (preferred) GUI-integration path and dropped
// straight into headless signin.
const ONEPASSWORD_GUI_APP_CANDIDATES = [
  '/Applications/1Password.app',
  '/Applications/1Password 8.app',
] as const;

/**
 * Resolved path to the installed 1Password desktop app, or null.
 *
 * The Linux app is an ordinary executable in the system profile rather than a
 * bundle, so it is looked up by name after the macOS bundle paths miss.
 */
const findGuiApp = async (): Promise<string | null> => {
  for (const candidate of ONEPASSWORD_GUI_APP_CANDIDATES) {
    if (await pathExists(candidate)) return candidate;
  }

  return await findSystemBinary('1password');
};

// The flake app's PATH excludes both the Homebrew prefix and the NixOS system
// profile, so `op` is never on PATH and `which op` can't find it — resolve it
// under one of those instead.
const requireOp = (): Promise<string> => requireSystemBinary('op');

/**
 * Where a service-account token is kept, on a host that authenticates with one.
 *
 * Deliberately *not* exported into the interactive shell environment. `op`
 * prefers a token over the desktop app whenever one is set, so a token in the
 * ambient environment would silently downgrade every interactive `op` call on a
 * machine that also has a desktop session — and since service accounts cannot
 * read Personal or Private vaults, references that work by hand would start
 * failing with nothing to explain why. Reading it per invocation keeps the two
 * authentication modes from fighting over one shell.
 */
const tokenPath = (): string =>
  `${environment().HOME}/.config/op/service-account-token`;

const readServiceAccountToken = async (): Promise<string | null> => {
  const fromEnvironment = Deno.env.get('OP_SERVICE_ACCOUNT_TOKEN');

  if (fromEnvironment) return fromEnvironment;

  const path = tokenPath();

  if (!(await pathExists(path))) return null;

  const token = (await Deno.readTextFile(path)).trim();

  return token.length > 0 ? token : null;
};

/**
 * Puts the token in *this process's* environment, where every `op` child
 * inherits it without any call site having to know it exists.
 *
 * Scoped to the bootstrap run by design — see `tokenPath`.
 */
const useServiceAccountToken = (token: string): void => {
  Deno.env.set('OP_SERVICE_ACCOUNT_TOKEN', token);
};

const usingServiceAccount = (): boolean =>
  Boolean(Deno.env.get('OP_SERVICE_ACCOUNT_TOKEN'));

/**
 * Global flags for `op` *data* commands (read, document get, item get, …).
 *
 * `--account` pins which account is used. Without it `op` can fail with
 * "multiple accounts found" on a machine signed into both a personal and a work
 * account, and vault names aren't unique across accounts, so the flag makes
 * resolution deterministic rather than dependent on desktop-app state.
 *
 * A service-account token identifies exactly one account by construction, and
 * `op` rejects `--account` alongside one, so the flag drops out in that mode.
 */
const opFlags = (): readonly string[] => {
  if (usingServiceAccount()) return [];

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
    // Nothing to install: on NixOS both the CLI and the desktop app are
    // declared in the system configuration, so they arrive with the switch
    // that the install itself performed. Their absence is a configuration bug
    // rather than something to fix by running an installer here.
    if (await findSystemBinary('op')) {
      console.log('✓ 1Password CLI present (from the system configuration)');
      return;
    }

    throw new Error(
      '`op` is not in the system profile — add `_1password-cli` to the ' +
        "host's packages and switch, then re-run.",
    );
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
 * Returns true when `op` can actually read from the account.
 *
 * Probes with a data command rather than `whoami`, which only *reports* an
 * existing session and can't establish one: under desktop-app integration the
 * app delegates a session in response to a request that needs data, so on a
 * machine where no `op` command has run yet `whoami` fails with "account is not
 * signed in" no matter how correctly the GUI integration is configured. Measured
 * back to back on a healthy host — `whoami` fails, `vault list` succeeds, and
 * `whoami` then succeeds because the read established the session it reports.
 *
 * `vault list` is the cheapest command that proves what the phases downstream
 * need: not a session in the abstract, but authorized reads.
 */
const isOpAuthenticated = async (): Promise<boolean> => {
  const op = await findSystemBinary('op');
  if (!op) return false;

  const result = await shell(op, ['vault', 'list', ...opFlags()], {
    error: false,
  });

  return result.success;
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
          '  4. Make sure Settings -> Security -> unlock with Touch ID is on;',
          '     the integration delegates sessions through it.',
          '',
          '  Pressing Enter below runs a read against your account, which is',
          '  what makes the app delegate a session — approve the biometric',
          '  prompt when it appears. No password or session token is typed.',
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
 * Prompts for a service-account token, verifies it, and stores it `0600`.
 *
 * The token is the one credential that can't come from the manifest, for the
 * obvious reason: it is what makes reading the manifest possible. So it's typed
 * once per host, and `promptSecret` keeps it out of the scrollback.
 *
 * Create it on an already-authenticated machine with `op service-account
 * create`, granting read access to the vault the manifest references — and keep
 * a copy in 1Password, because the token is displayed exactly once. Note that
 * service accounts cannot be granted access to Personal or Private vaults at
 * all, so every reference a host resolves this way has to live in a shared
 * vault.
 */
const authenticateWithServiceAccount = async (): Promise<void> => {
  console.log('');
  console.log(
    'No 1Password desktop app on this host, so `op` authenticates with a ' +
      'service account.',
  );
  console.log(
    gray(
      'Create one on a machine that is already signed in:\n' +
        '  op service-account create irulan --vault Secrets:read_items',
    ),
  );
  console.log('');

  const token = (await promptSecret('Service account token: ')).trim();

  if (!token) throw new Error('no token entered');

  useServiceAccountToken(token);

  if (!(await isOpAuthenticated())) {
    Deno.env.delete('OP_SERVICE_ACCOUNT_TOKEN');

    throw new Error(
      "that token can't read from the account — check it was copied whole, " +
        'and that the service account has access to the vault the manifest ' +
        'references.',
    );
  }

  const path = tokenPath();

  await Deno.mkdir(path.replace(/\/[^/]+$/, ''), { recursive: true });
  await Deno.writeTextFile(path, `${token}\n`, { mode: 0o600 });
  // writeTextFile's mode is ignored when the file already exists, so set it
  // explicitly rather than trusting a first-run-only guarantee.
  await Deno.chmod(path, 0o600);

  console.log(`✓ 1Password CLI authenticated via service account (${path})`);
};

/**
 * Ensures `op` can read from the account via the 1Password desktop app's CLI
 * integration. No passwords or session tokens are involved. Whenever the app
 * is installed `op` defers to it, so this is the path that actually works —
 * and it's not macOS-specific: the Linux desktop app offers the same
 * integration, so this generalizes to any host with a desktop session.
 *
 * Loops the guided flow so the user can retry without re-running bootstrap.
 *
 * There's no way to detect that the "Integrate with 1Password CLI" toggle is
 * enabled short of asking `op` for data, so we guide, then probe.
 *
 * A *truly* headless host (no desktop session at all) uses a 1Password service
 * account instead, which is the branch below: the app can't delegate a session
 * when there is no session, and irulan has to come back from a power cut
 * without anyone at the keyboard. An earlier `op account add` + `op signin`
 * fallback lived here, but it's unreachable wherever the app is installed and
 * is the wrong mechanism for automation, so it was removed.
 *
 * The two modes coexist on one host rather than being a property of the
 * platform. A machine that is a desktop *and* a server — as irulan is — uses
 * the app when someone is logged in and the token when nobody is, and the only
 * thing that decides which is whether a token is present.
 */
export const ensureOpAuthenticated = async (): Promise<void> => {
  const existingToken = await readServiceAccountToken();

  if (existingToken) useServiceAccountToken(existingToken);

  if (await isOpAuthenticated()) {
    console.log(
      usingServiceAccount()
        ? '✓ 1Password CLI authenticated via service account'
        : '✓ 1Password CLI already authenticated',
    );
    return;
  }

  if (!(await findGuiApp())) {
    await authenticateWithServiceAccount();
    return;
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
      yellow(
        "`op` still can't read from the account — check the toggle, make sure " +
          'the app is unlocked, and try again.',
      ),
    );
  }

  throw new Error(
    '1Password CLI authentication did not complete. Enable Settings -> ' +
      'Developer -> "Integrate with 1Password CLI" in the desktop app, ' +
      'confirm `op vault list` succeeds, then re-run bootstrap. Note that ' +
      '`op whoami` is not a useful check here — it reports an existing ' +
      'session rather than establishing one, so it fails until some other ' +
      'command has been authorized.',
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
): Promise<
  { success: true; value: string } | { success: false; stderr: string }
> => {
  const result = await shell(await requireOp(), [
    'read',
    reference,
    ...opFlags(),
  ], {
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

/**
 * Vault the `secrets` CLI writes into.
 *
 * `secretsVault` first so machine secrets land in the dedicated vault, falling
 * back to the read-side default for an account that only has one.
 *
 * @param override Explicit vault from the caller
 */
const writeVault = (override?: string): string => {
  const vault = override ?? configuration.onePassword?.secretsVault ??
    configuration.onePassword?.vault;

  if (!vault) {
    throw new Error(
      'No vault configured for item creation: set ' +
        '`onePassword.secretsVault`.',
    );
  }

  return vault;
};

/** True when an item with this title already exists in the vault. */
const itemExists = async (
  op: string,
  title: string,
  vault: string,
): Promise<boolean> => {
  const result = await shell(
    op,
    ['item', 'get', title, '--vault', vault, ...opFlags()],
    { error: false },
  );

  return result.success;
};

/**
 * Runs `op` with `input` on stdin and returns its stdout.
 *
 * Deliberately not `shell`: the input is secret material, so it goes down a
 * pipe rather than through argv, and none of it is logged. 1Password's own
 * guidance is the same — assignment statements are visible to other processes,
 * JSON templates on stdin are not.
 *
 * @param args Arguments to `op`
 * @param input Payload for stdin
 * @param description What failed, for the error message
 */
const pipeToOp = async (
  args: readonly string[],
  input: string,
  description: string,
): Promise<string> => {
  const child = new Deno.Command(await requireOp(), {
    args: [...args],
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();

  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();

  const { success, stdout, stderr } = await child.output();

  if (!success) {
    throw new Error(
      `${description} failed:\n${new TextDecoder().decode(stderr)}`,
    );
  }

  return new TextDecoder().decode(stdout);
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
  const vault = writeVault(options.vault);

  const exists = await itemExists(await requireOp(), title, vault);

  const args = exists
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

  await pipeToOp(
    args,
    contents,
    `\`op document ${exists ? 'edit' : 'create'}\` for ${title}`,
  );

  return `op://${vault}/${title}`;
};

/** The parts of an `op item get --format json` payload this module touches. */
interface ItemField {
  readonly id?: string;
  readonly label?: string;
  readonly type?: string;
  readonly value?: string;
}

interface Item {
  readonly fields?: readonly ItemField[];
  readonly [key: string]: unknown;
}

/** Sets `field` to `value`, adding it as a concealed field if it's absent. */
const patchField = (item: Item, field: string, value: string): Item => {
  const matches = (candidate: ItemField): boolean =>
    candidate.id?.toLowerCase() === field.toLowerCase() ||
    candidate.label?.toLowerCase() === field.toLowerCase();

  const fields = item.fields ?? [];

  return {
    ...item,
    fields: fields.some(matches)
      ? fields.map((candidate) =>
        matches(candidate) ? { ...candidate, value } : candidate
      )
      : [...fields, { id: field, label: field, type: 'CONCEALED', value }],
  };
};

interface WriteFieldOptions {
  readonly title: string;
  /** Field label — the last segment of an `op://Vault/Item/field` reference. */
  readonly field: string;
  readonly value: string;
  /**
   * 1Password category for a newly created item, in the JSON template's
   * spelling (`API_CREDENTIAL`, not `API Credential`).
   */
  readonly category?: string;
  /** Item notes. Written on create only, so an update can't clobber edits. */
  readonly notes?: string;
  /** Overrides `onePassword.secretsVault`. */
  readonly vault?: string;
}

/**
 * Writes a single concealed field on a 1Password item, creating the item if it
 * doesn't exist, and returns its `op://Vault/Item/field` reference.
 *
 * Both paths go through a JSON template on stdin rather than an `op` assignment
 * statement (`credential=…`), which would put the secret in argv where any
 * other process can read it.
 *
 * The update path re-reads the whole item with `--reveal` and pipes it back
 * patched, which is 1Password's documented edit flow. A partial template would
 * be shorter, but whether unmentioned fields survive it is unspecified, and
 * losing a field on a credential item is not a nice way to find out.
 *
 * @returns The `op://` reference to store in the manifest
 */
export const writeItemField = async (
  options: WriteFieldOptions,
): Promise<string> => {
  const { title, field, value, category = 'API_CREDENTIAL', notes } = options;
  const vault = writeVault(options.vault);
  const op = await requireOp();

  const reference = `op://${vault}/${title}/${field}`;

  if (!(await itemExists(op, title, vault))) {
    const template: Item = {
      title,
      category,
      fields: [
        { id: field, label: field, type: 'CONCEALED', value },
        ...(notes
          ? [{
            id: 'notesPlain',
            label: 'notesPlain',
            type: 'STRING',
            value: notes,
          }]
          : []),
      ],
    };

    await pipeToOp(
      ['item', 'create', '-', '--vault', vault, ...opFlags()],
      JSON.stringify(template),
      `\`op item create\` for ${title}`,
    );

    return reference;
  }

  const current = await shell(
    op,
    [
      'item',
      'get',
      title,
      '--vault',
      vault,
      '--format',
      'json',
      '--reveal',
      ...opFlags(),
    ],
    { error: false, secret: true },
  );

  if (!current.success) {
    throw new Error(
      `\`op item get\` failed for ${title}:\n${current.stderr}`,
    );
  }

  await pipeToOp(
    ['item', 'edit', title, '--vault', vault, ...opFlags()],
    JSON.stringify(
      patchField(JSON.parse(current.stdout) as Item, field, value),
    ),
    `\`op item edit\` for ${title}`,
  );

  return reference;
};
