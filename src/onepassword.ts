import {
  blue,
  bold,
  gray,
  yellow,
} from 'https://deno.land/std@0.192.0/fmt/colors.ts';

import { configuration } from './configuration.ts';
import { pathExists, shell } from './helpers.ts';

const ONEPASSWORD_GUI_APP_PATH = '/Applications/1Password 8.app';

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
  const which = await shell('/usr/bin/which', ['op'], { error: false });
  const cliInstalled = which.success && which.stdout.trim().length > 0;
  const guiInstalled = await pathExists(ONEPASSWORD_GUI_APP_PATH);
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
  await shell('brew', ['install', '--cask', ...casks]);
};

/**
 * Returns true when `op whoami` succeeds — meaning the CLI has a valid
 * session token (either via GUI integration or a saved `op signin` session).
 */
const isOpAuthenticated = async (): Promise<boolean> => {
  const result = await shell('op', ['whoami'], { error: false });
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
  await shell('open', ['-g', ONEPASSWORD_GUI_APP_PATH], { error: false });

  await promptLine(yellow('\nPress Enter once GUI integration is enabled... '));
};

/**
 * Runs the headless `op account add` + `op signin` flow. Used when the GUI
 * is unavailable or the user prefers terminal-only signin.
 */
const guideHeadlessSignin = async (): Promise<string> => {
  console.log(blue(bold('\n1Password headless signin')));

  const configuredShorthand =
    configuration.onePassword?.accountShorthand?.trim();

  const shorthand =
    configuredShorthand && configuredShorthand.length > 0
      ? configuredShorthand
      : await promptLine('Account shorthand (e.g. "my"): ');

  if (!shorthand) {
    throw new Error('1Password account shorthand is required');
  }

  // `op account add` is interactive on its own (prompts for sign-in address,
  // email, secret key, password). We hand stdin/stdout straight through.
  console.log(
    gray(
      `Running \`op account add --shorthand ${shorthand}\` — follow the prompts.`,
    ),
  );

  const add = new Deno.Command('op', {
    args: ['account', 'add', '--shorthand', shorthand],
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const { success: addSuccess } = await add.output();
  if (!addSuccess) {
    throw new Error('`op account add` failed; cannot continue 1Password setup');
  }

  // `op signin --account <shorthand>` prints `export OP_SESSION_<id>=...` to
  // stdout. We capture and surface guidance for the user; once GUI
  // integration is configured this branch is rarely needed.
  console.log(
    gray(`Running \`op signin --account ${shorthand}\` — follow the prompts.`),
  );
  const signin = new Deno.Command('op', {
    args: ['signin', '--account', shorthand],
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const { success: signinSuccess } = await signin.output();
  if (!signinSuccess) {
    throw new Error('`op signin` failed; cannot continue 1Password setup');
  }

  return shorthand;
};

/**
 * Ensures `op whoami` succeeds. Prefers the 1Password GUI's CLI integration
 * (no password typing) and falls back to `op account add` + `op signin` when
 * the GUI isn't available.
 *
 * Loops until authentication succeeds — the user can retry the interactive
 * steps from a stale state without re-running bootstrap.
 *
 * Open question / TODO(onepassword): there's no reliable way to detect that
 * the GUI's "Integrate with 1Password CLI" toggle is enabled short of
 * actually trying `op whoami`. We rely on the user confirming the prompt
 * and then probe. If the probe fails we re-prompt or fall back to the
 * headless path.
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

  const guiInstalled = await pathExists(ONEPASSWORD_GUI_APP_PATH);

  // Loop until `op whoami` succeeds. Each iteration the user can pick the
  // GUI path (fast, no password) or fall through to headless.
  // Hard cap of attempts prevents infinite loops in CI-ish environments.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (guiInstalled) {
      await guideGuiIntegration();
      if (await isOpAuthenticated()) {
        console.log('✓ 1Password CLI authenticated via GUI integration');
        return;
      }

      const fallback = await promptLine(
        'GUI integration did not yield a session. Try headless signin? [y/N]: ',
      );
      if (!fallback.toLowerCase().startsWith('y')) {
        console.log('Retrying GUI integration flow...');
        continue;
      }
    }

    await guideHeadlessSignin();

    if (await isOpAuthenticated()) {
      console.log('✓ 1Password CLI authenticated via headless signin');
      return;
    }

    console.log(
      yellow(
        '`op whoami` still failing after signin attempt; retrying setup flow.',
      ),
    );
  }

  throw new Error(
    '1Password CLI authentication did not complete after multiple attempts',
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
  const result = await shell('op', ['read', reference], { error: false });
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
