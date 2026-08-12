import { blue, bold, gray } from 'https://deno.land/std@0.192.0/fmt/colors.ts';

import { shell } from './helpers.ts';

const isDarwin = (): boolean => Deno.build.os === 'darwin';

/**
 * macOS `LocalHostName` (the Bonjour/mDNS name) accepts only ASCII letters,
 * digits, and hyphens — no spaces or dots. Collapse anything else to a single
 * hyphen and trim leading/trailing hyphens.
 */
const sanitizeLocalHostName = (name: string): string =>
  name
    .trim()
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * Apply `name` to every place the OS records a hostname.
 *
 * macOS keeps three separate values (and caches DNS): the Unix `HostName`
 * that `Deno.hostname()` / `hostname -s` read, the Bonjour `LocalHostName`,
 * and the Sharing/Finder `ComputerName`. A fresh Mac usually leaves `HostName`
 * unset, so the shell hostname falls back to a DHCP/marketing name — which is
 * exactly why the flake selector needs this set before the first switch. This
 * mirrors the `reset-host` zsh function in the nix config.
 *
 * Linux/NixOS has a single source of truth. `hostnamectl set-hostname` sets it
 * transiently so the selector resolves now; the declarative
 * `networking.hostName` re-asserts it permanently after the first switch.
 */
const applyHostname = async (name: string): Promise<void> => {
  if (isDarwin()) {
    const local = sanitizeLocalHostName(name);
    await shell('/usr/bin/sudo', ['scutil', '--set', 'HostName', name]);
    await shell('/usr/bin/sudo', ['scutil', '--set', 'LocalHostName', local]);
    await shell('/usr/bin/sudo', ['scutil', '--set', 'ComputerName', name]);
    await shell('/usr/bin/sudo', ['dscacheutil', '-flushcache'], {
      error: false,
    });
    await shell('/usr/bin/sudo', ['killall', '-HUP', 'mDNSResponder'], {
      error: false,
    });
    return;
  }

  await shell('/usr/bin/sudo', ['hostnamectl', 'set-hostname', name]);
};

/**
 * Interactively confirm (and, if needed, set) the machine's hostname before
 * anything depends on it. The flake selects its host configuration by hostname
 * (`~/.config/system#<hostname>`), so a wrong name here fails the first switch.
 *
 * Shows the current hostname, prompts for the intended one (defaulting to the
 * current short name), applies it across all OS surfaces, and returns the
 * confirmed value for the caller to persist and inject into the environment.
 */
export const ensureHostname = async (): Promise<string> => {
  const current = Deno.hostname().trim();
  const short = (current.split('.')[0] ?? current).toLowerCase();
  const wrap = 80;

  console.log(
    '\n\n',
    `🏷  ${blue(bold('Hostname'))}\n`,
    gray(
      'The flake selects a host config by hostname\n' +
        ' (~/.config/system#<hostname>), so it must match a configured host\n' +
        ' (e.g. ala, newt, irulan) before the first switch.',
    ),
    '\n',
    blue('‾'.repeat(wrap)),
  );
  console.log(` current hostname: ${bold(current)}  (short: ${bold(short)})`);

  const answer = (prompt(' Hostname for this machine?', short) ?? short)
    .trim()
    .toLowerCase();

  if (!answer) throw new Error('No hostname provided');

  if (answer === short) {
    console.log(
      gray(` Keeping "${answer}" (re-asserting across all OS surfaces).`),
    );
  } else {
    console.log(gray(` Setting hostname to "${answer}".`));
  }

  await applyHostname(answer);
  return answer;
};
