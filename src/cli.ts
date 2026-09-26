import {
  bold,
  gray,
  red,
  yellow,
} from 'https://deno.land/std@0.192.0/fmt/colors.ts';

import { bootstrap } from './bootstrap.ts';
import { writeInstallerMedia } from './media.ts';
import { runSecrets, SECRETS_USAGE } from './secrets.ts';
import { useSystemPath } from './system.ts';

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
  bootstrap media write <iso>         write installer media to a removable disk
  bootstrap secrets <command>         manage the 1Password-backed manifest
  bootstrap help                      this message

${gray('Phases are idempotent — a completed one is skipped, so re-running')}
${gray('provision after a failure resumes rather than starting over.')}

${SECRETS_USAGE}`;

const runMedia = async (args: readonly string[]): Promise<void> => {
  const [command, image] = args;

  if (command !== 'write' || !image) {
    throw new Error('Usage: bootstrap media write <iso>');
  }

  await writeInstallerMedia(image);
};

const main = async (): Promise<void> => {
  // Before anything shells out. The flake wrapper's PATH is nix store bin
  // directories only, which is right for the tools we pin and wrong for every
  // tool the system owns.
  useSystemPath();

  const [command, ...rest] = Deno.args;

  try {
    switch (command) {
      case 'provision':
        return await bootstrap();
      case 'media':
        return await runMedia(rest);
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
