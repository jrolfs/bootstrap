import {
  blue,
  bold,
  gray,
  green,
  red,
} from 'https://deno.land/std@0.192.0/fmt/colors.ts';

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

/**
 * Copies text to the macOS clipboard via `pbcopy`.
 *
 * The value is written to stdin rather than passed as an argument so it never
 * appears in the process table, and it is deliberately not logged.
 *
 * @param value Text to place on the clipboard
 *
 * @returns Whether the copy succeeded
 */
export const copyToClipboard = async (value: string): Promise<boolean> => {
  try {
    const child = new Deno.Command('/usr/bin/pbcopy', { stdin: 'piped' })
      .spawn();

    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(value));
    await writer.close();

    const { success } = await child.status;
    return success;
  } catch {
    return false;
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

export const openBrowser = async (url: string) => {
  const supported = ['windows', 'darwin', 'linux'] as const;
  type Supported = typeof supported[number];

  const isSupported = (os: string): os is Supported =>
    supported.includes(os as Supported);

  // Absolute path on darwin: the flake app's PATH has no /usr/bin.
  const openCommands = {
    windows: { cmd: 'cmd', args: ['/c', 'start'] },
    darwin: { cmd: '/usr/bin/open', args: [] },
    linux: { cmd: 'xdg-open', args: [] },
  };

  const os = Deno.build.os;

  if (!isSupported(os)) {
    console.error(`openBrowser: unsupported operating system "${os}"`);
    return;
  }

  const { cmd, args } = openCommands[os] ?? openCommands.linux;

  try {
    await new Deno.Command(cmd, { args: [...args, url] }).output();
  } catch (_) {
    console.log('openBrowser: failed to open browser automatically');
  }
};
