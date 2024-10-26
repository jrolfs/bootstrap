import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';

import { configuration, environment } from './configuration.ts';
import { uploadGitHubKey } from './github.ts';
import { pathExists, shell } from './helpers.ts';

const ensureHomebrew = async () => {
  if (await pathExists('/opt/homebrew')) {
    console.log('✓ Homebrew already installed');
    return;
  }

  console.log('Installing Homebrew...');

  const { stdout: bashPath } = await shell('which', ['bash']);
  if (!bashPath) throw new Error('Could not find bash executable');

  const response = await fetch(
    'https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh',
  );

  const installScript = await response.text();

  console.log('Installing Homebrew. This may take a while...');
  
  const command = new Deno.Command(bashPath.trim(), {
    args: ['-c', installScript],
    env: {
      ...Deno.env.toObject(),
      NONINTERACTIVE: '1',
    },
    stdin: 'null',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const { success } = await command.output();

  if (!success) {
    throw new Error('Homebrew installation failed');
  }

  console.log('Homebrew installation complete.');
};

const setupSSHKey = async () => {
  const { HOME, hostname } = environment();
  const sshPath = `${HOME}/.ssh/id_ed25519`;
  const publicKeyPath = `${sshPath}.pub`;

  if (await pathExists(sshPath)) {
    console.log('✓ SSH key already exists');
  } else {
    console.log('Generating SSH key...');

    await shell('ssh-keygen', [
      '-t',
      'ed25519',
      '-C',
      `${configuration.github.email}+bootstrap-${hostname}@gmail.com`,
      '-f',
      sshPath,
      '-N',
      '',
    ]);
  }

  const publicKey = await Deno.readTextFile(publicKeyPath);
  await uploadGitHubKey(publicKey);
};

const setupHomeshick = async () => {
  const { HOME } = environment();
  const homeshickPath = `${HOME}/.homesick/repos/homeshick`;

  if (await pathExists(homeshickPath)) {
    console.log('✓ homeshick already installed');
  } else {
    console.log('Installing homeshick...');
    await shell('git', [
      'clone',
      configuration.homeshick.remote,
      homeshickPath,
    ]);
  }

  await Promise.all(
    configuration.github.repositories.map(
      async (repository) => {
        const repositoryPath = `${HOME}/.homesick/repos/${repository.name}`;

        if (await pathExists(repositoryPath)) {
          console.log(`✓ ${repository.name} already cloned, pulling...`);

          await shell('bash', [
            '-c',
            `source ${homeshickPath}/homeshick.sh && homeshick pull ${repository.name}`,
          ]);
        } else {
          console.log(`Cloning ${repository.name}...`);
          await shell('bash', [
            '-c',
            `source ${homeshickPath}/homeshick.sh && homeshick clone -b ${repository.url}`,
          ]);
        }
      },
    ),
  );

  console.log('Linking dotfiles...');
  await shell('bash', [
    '-c',
    `source ${homeshickPath}/homeshick.sh && homeshick link`,
  ]);
};

const bootstrap = async () => {
  try {
    environment();

    await setupSSHKey();
    await ensureHomebrew();
    await setupHomeshick();

    console.log('✨ Bootstrap complete!');
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('Validation error:', JSON.stringify(error.errors, null, 2));
    } else {
      console.error('Bootstrap failed:', error);
    }
    Deno.exit(1);
  }
};

if (import.meta.main) {
  bootstrap();
}
