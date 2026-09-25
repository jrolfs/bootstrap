import { bold, red, yellow } from 'https://deno.land/std@0.192.0/fmt/colors.ts';

import { pathExists, promptLine, shell } from './helpers.ts';

/**
 * Writing NixOS installer media.
 *
 * The one provisioning step that necessarily happens on a *different* machine
 * from the one being provisioned, which is why it's a subcommand rather than a
 * phase: there is no host being brought up here and nothing to resume.
 *
 * The safety property worth stating, because it's the reason this exists rather
 * than a line of `dd` in a runbook: **the target can only ever be one of the
 * removable devices this module enumerated.** A device is chosen from a list,
 * never parsed from an argument, so there is no spelling of the command that
 * writes to an internal disk. `dd` gives you exactly one chance to get
 * `/dev/disk0` wrong.
 */

interface RemovableDevice {
  /** Device node used for control operations (unmount, eject). */
  readonly path: string;
  /**
   * Device node used for the write itself.
   *
   * macOS exposes a raw character device alongside the buffered block device,
   * and writing to the raw one is many times faster — it skips the buffer cache
   * rather than dirtying a gigabyte of it. Linux has no such split.
   */
  readonly writePath: string;
  readonly description: string;
  readonly size: string;
}

const isDarwin = (): boolean => Deno.build.os === 'darwin';

const asRoot = (command: string, args: readonly string[]) =>
  Deno.uid() === 0
    ? { command, args: [...args] }
    : { command: 'sudo', args: [command, ...args] };

const gigabytes = (bytes: number): string =>
  `${(bytes / 1000 ** 3).toFixed(1)} GB`;

/**
 * External physical disks, as reported by `diskutil`.
 *
 * `external physical` does the filtering for us — synthesised APFS containers
 * and the internal drive never appear — and each disk is then queried
 * individually for the attributes worth showing and for a second opinion on
 * whether it is really external. plist comes back as XML, so it goes through
 * `plutil` to land as JSON.
 */
const darwinDevices = async (): Promise<readonly RemovableDevice[]> => {
  const listed = await shell('/bin/sh', [
    '-c',
    'diskutil list -plist external physical | plutil -convert json -o - -',
  ], { error: false, secret: true });

  if (!listed.success) return [];

  const { AllDisksAndPartitions: disks = [] } = JSON.parse(listed.stdout) as {
    AllDisksAndPartitions?: readonly { DeviceIdentifier: string }[];
  };

  const devices = await Promise.all(
    disks.map(async ({ DeviceIdentifier: identifier }) => {
      const info = await shell('/bin/sh', [
        '-c',
        `diskutil info -plist ${identifier} | plutil -convert json -o - -`,
      ], { error: false, secret: true });

      if (!info.success) return null;

      const details = JSON.parse(info.stdout) as {
        Internal?: boolean;
        Size?: number;
        MediaName?: string;
        BusProtocol?: string;
        IORegistryEntryName?: string;
      };

      // `external physical` should already exclude these; checked again because
      // the cost of being wrong is someone's boot drive.
      if (details.Internal) return null;

      return {
        path: `/dev/${identifier}`,
        writePath: `/dev/r${identifier}`,
        // IORegistryEntryName carries the vendor ("Samsung Type-C Media")
        // where MediaName is often just the form factor ("Type-C"). Picking the
        // right stick out of a list is the whole job, so prefer the longer one.
        description: [
          details.IORegistryEntryName ?? details.MediaName,
          details.BusProtocol,
        ]
          .filter(Boolean)
          .join(' · ') || identifier,
        size: gigabytes(details.Size ?? 0),
      };
    }),
  );

  return devices.filter((device): device is RemovableDevice => device !== null);
};

/**
 * Whole disks that `lsblk` reports as removable, hot-pluggable or USB-attached,
 * excluding any disk with a mounted partition — which is what keeps the running
 * system's own disk out of the list even on a machine whose root happens to sit
 * on removable media.
 */
const linuxDevices = async (): Promise<readonly RemovableDevice[]> => {
  const listed = await shell('lsblk', [
    '--json',
    '--bytes',
    '-o',
    'PATH,SIZE,TYPE,MODEL,RM,HOTPLUG,TRAN,MOUNTPOINTS',
  ], { error: false, secret: true });

  if (!listed.success) return [];

  interface Block {
    readonly path: string;
    readonly size: number;
    readonly type: string;
    readonly model?: string;
    readonly rm?: boolean;
    readonly hotplug?: boolean;
    readonly tran?: string;
    readonly mountpoints?: readonly (string | null)[];
    readonly children?: readonly Block[];
  }

  const { blockdevices: blocks = [] } = JSON.parse(listed.stdout) as {
    blockdevices?: readonly Block[];
  };

  const mounted = (block: Block): boolean =>
    (block.mountpoints ?? []).some((mountpoint) => mountpoint !== null) ||
    (block.children ?? []).some(mounted);

  return blocks
    .filter((block) => block.type === 'disk')
    .filter((block) => block.rm || block.hotplug || block.tran === 'usb')
    .filter((block) => !mounted(block))
    .map((block) => ({
      path: block.path,
      writePath: block.path,
      description: [block.model?.trim(), block.tran]
        .filter(Boolean)
        .join(' · ') || block.path,
      size: gigabytes(block.size),
    }));
};

const unmount = async (device: RemovableDevice): Promise<void> => {
  if (isDarwin()) {
    await shell('diskutil', ['unmountDisk', device.path], { error: false });
    return;
  }

  const { command, args } = asRoot('umount', [`${device.path}*`]);
  await shell('/bin/sh', ['-c', [command, ...args].join(' ')], {
    error: false,
  });
};

const eject = async (device: RemovableDevice): Promise<void> => {
  if (isDarwin()) {
    await shell('diskutil', ['eject', device.path], { error: false });
    return;
  }

  await shell('sync', []);
  // eject isn't in every Linux install and the write is already flushed; this
  // is a courtesy so the stick can be pulled without a second thought.
  await shell('eject', [device.path], { error: false });
};

/**
 * Prompts for one of the enumerated devices.
 *
 * Returns null when the user declines, which the caller treats as "nothing
 * happened" rather than as a failure.
 */
const chooseDevice = async (
  devices: readonly RemovableDevice[],
): Promise<RemovableDevice | null> => {
  console.log('');
  devices.forEach((device, index) => {
    console.log(
      `  ${index + 1}. ${
        bold(device.path)
      }  ${device.size}  ${device.description}`,
    );
  });
  console.log('');

  const answer = await promptLine(
    `Which device? [1-${devices.length}, anything else cancels] `,
  );
  const choice = Number.parseInt(answer.trim(), 10);

  if (!Number.isInteger(choice) || choice < 1 || choice > devices.length) {
    return null;
  }

  return devices[choice - 1] ?? null;
};

/**
 * Writes an installer image to a removable device, after enumerating the
 * candidates and confirming the choice.
 *
 * @param image Path to the ISO to write.
 */
export const writeInstallerMedia = async (image: string): Promise<void> => {
  if (!await pathExists(image)) {
    throw new Error(`no such image: ${image}`);
  }

  const devices = isDarwin() ? await darwinDevices() : await linuxDevices();

  if (devices.length === 0) {
    throw new Error(
      'no removable devices found — plug the drive in and try again',
    );
  }

  const device = await chooseDevice(devices);

  if (!device) {
    console.log('Cancelled; nothing was written.');
    return;
  }

  console.log('');
  console.log(
    red(
      `This erases everything on ${
        bold(device.path)
      } (${device.size}, ${device.description}).`,
    ),
  );

  const confirmation = await promptLine("Type 'erase' to continue: ");

  if (confirmation.trim() !== 'erase') {
    console.log('Cancelled; nothing was written.');
    return;
  }

  await unmount(device);

  // Block size suffixes differ: BSD dd takes a lowercase `m`, GNU an uppercase
  // `M`, and each rejects the other. GNU also reports progress on request,
  // while BSD only does so when sent SIGINFO.
  const { command, args } = asRoot('dd', [
    `if=${image}`,
    `of=${device.writePath}`,
    ...(isDarwin() ? ['bs=4m'] : ['bs=4M', 'status=progress', 'conv=fsync']),
  ]);

  if (isDarwin()) {
    console.log(yellow('Writing — press Ctrl-T for progress.'));
  }

  await shell(command, args, { stream: true });

  await eject(device);

  console.log('');
  console.log(`✓ ${image} written to ${device.path}. Safe to unplug.`);
};
