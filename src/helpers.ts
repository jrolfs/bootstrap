import { bold, red } from 'https://deno.land/std@0.192.0/fmt/colors.ts';

const decoder = new TextDecoder();

export interface ShellOptions {
  error?: boolean;
}

export const shell = async (
  command: string,
  args: string[] = [],
  { error = true }: ShellOptions = {},
) => {
  console.log(
    `Running: ${command} ${args.map((arg) => arg.split('\n')[0]).join(' ')}`,
  );

  const process = new Deno.Command(command, {
    args,
    stdout: 'piped',
    stderr: 'piped',
  });

  const { success, stdout, stderr } = await process.output();

  if (success || !error) {
    return {
      success,
      stdout: decoder.decode(stdout),
      stderr: decoder.decode(stderr),
    };
  } else {
    throw new Error(red(`${bold(command)} failed:\n${decoder.decode(stderr)}`));
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
