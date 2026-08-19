import {
  bold,
  gray,
  red,
  yellow,
} from 'https://deno.land/std@0.192.0/fmt/colors.ts';

import { bootstrap } from './bootstrap.ts';
import { runSecrets, SECRETS_USAGE } from './secrets.ts';

/**
 * `bootstrap` — the single entry point, for provisioning a machine and for
 * managing the secrets it needs.
 *
 * One binary rather than one per area so that nothing generic reaches `PATH`:
 * `gpg`, `export` and `import` exist only as subcommands here and so can never
 * shadow the real tools of those names. It also means the CLI is identical
 * whether it came from the system closure or from a checkout's dev shell.
 *
 * Bare `bootstrap` prints usage rather than provisioning — the verb is always
 * required. `nix run github:jrolfs/bootstrap` still provisions, because the
 * flake app supplies `provision` for the bare-machine case where there is no
 * checkout and nothing on `PATH` yet.
 */

const USAGE = `${bold('bootstrap')} — machine provisioning and secrets

  bootstrap provision                 run every provisioning phase
  bootstrap secrets <command>         manage the 1Password-backed manifest
  bootstrap help                      this message

${gray('Phases are idempotent — a completed one is skipped, so re-running')}
${gray('provision after a failure resumes rather than starting over.')}

${SECRETS_USAGE}`;

const main = async (): Promise<void> => {
  const [command, ...rest] = Deno.args;

  try {
    switch (command) {
      case 'provision':
        return await bootstrap();
      case 'secrets':
        return await runSecrets(rest);
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        console.log(USAGE);
        return;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    console.error(red(error instanceof Error ? error.message : String(error)));
    console.error(yellow('\nRun `bootstrap help` for usage.'));
    Deno.exit(1);
  }
};

if (import.meta.main) main();
