import { blue, bold, red, green, gray } from 'https://deno.land/std@0.192.0/fmt/colors.ts';

const decoder = new TextDecoder();

export interface ShellOptions extends Deno.CommandOptions {
  error?: boolean;
}

/**
 * Wraps a string at a specified column width, breaking at word boundaries
 *
 * @param text The text to wrap
 * @param width The maximum width of each line (default: 60)
 *
 * @returns The wrapped text with lines joined by newlines
 */
export const wrapText = (text: string, width: number) => {
  const buildLines = (
    [word, ...remaining]: string[],
    accumulated: string,
    completed: string[],
  ): string[] => {
    if (!word) return accumulated ? [...completed, accumulated] : completed;

    const next = accumulated ? `${accumulated} ${word}` : word;

    return next.length <= width
      ? buildLines(remaining, next, completed)
      : buildLines(remaining, word, [...completed, accumulated]);
  };

  return buildLines(text.split(' '), '', []).join('\n');
};

export const shell = async (
  command: string,
  args: string[] = [],
  { error = true, ...options }: ShellOptions = {},
) => {
  const wrap = 80;
  const display = `${command} ${
    args.map((arg) => arg.split('\n')[0]).join(' ')
  }`.trim();

  console.log(
    '\n\n',
    `🪄 ${blue(bold('Executing ↯'))}\n`,
    `${gray(wrapText(display, wrap))}\n`,
    blue('‾'.repeat(wrap)),
  );

  const process = new Deno.Command(command, {
    args,
    stdout: 'piped',
    stderr: 'piped',
    ...options,
  });

  const subprocess = process.spawn();
  const chunks = {
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
  };

  for await (const chunk of subprocess.stdout) {
    await Deno.stdout.write(chunk);
    chunks.stdout = new Uint8Array([...chunks.stdout, ...chunk]);
  }

  for await (const chunk of subprocess.stderr) {
    await Deno.stderr.write(chunk);
    chunks.stderr = new Uint8Array([...chunks.stderr, ...chunk]);
  }

  const { success } = await subprocess.status;

  const color = success ? green : red;
  const icon = success ? '✅' : '❌';
  console.log(
    `${blue('┄'.repeat(wrap))}\n`,
    `${gray(wrapText(display, wrap))}\n`,
    `${icon} ${color(bold('Executed ↑'))}\n`,
    '\n\n',
  );

  if (success || !error) {
    return {
      success,
      stdout: decoder.decode(chunks.stdout),
      stderr: decoder.decode(chunks.stderr),
    };
  } else {
    throw new Error(
      red(`${bold(command)} failed:\n${decoder.decode(chunks.stderr)}`),
    );
  }
};

export const pathExists = async (path: string) => {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
};

export const reportApiError = async (response: Response) => {
  console.error(
    red(`${bold(response.status.toString())}: ${response.statusText}\n`),
    red(await response.text()),
  );
};
