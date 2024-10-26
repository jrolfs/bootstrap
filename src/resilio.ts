import { environment } from './configuration.ts';
import { shell } from './helpers.ts';

const waitForResilioSync = async (folderPath: string) => {
  const { HOME } = environment();

  const resilioApp = '/Applications/Resilio Sync.app';
  const maxAttempts = 60; // 5 minutes with 5-second intervals
  let attempts = 0;

  const isRunning = await shell('pgrep', ['-x', 'Resilio Sync'], {
    error: false,
  }).then(
    (result) => result.success,
  );

  if (!isRunning) {
    console.log('Launching Resilio Sync...');

    await shell('open', [resilioApp]);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  console.log(`Waiting for "${folderPath}" to sync...`);

  const checkSync = async (): Promise<boolean> => {
    try {
      const response = await fetch('http://localhost:8888/gui/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'action=get_folders',
      });

      if (!response.ok) return false;

      const data = await response.json();
      const folders = data.folders || [];
      const targetFolder = folders.find((f: any) => f.path === folderPath);

      if (!targetFolder) {
        console.log(`Folder ${folderPath} not found in Resilio Sync`);
        return false;
      }

      // Check if folder is in sync
      const progress = targetFolder.download_progress || 0;
      console.log(`Sync progress: ${progress}%`);
      return progress === 100;
    } catch (error) {
      console.error('Error checking sync status:', error);
      return false;
    }
  };

  while (attempts < maxAttempts) {
    if (await checkSync()) {
      console.log('✓ Sync complete!');
      return true;
    }

    attempts++;
    await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait 5 seconds between checks
  }

  throw new Error('Sync timed out after 5 minutes');
};

const bootstrap = async () => {
  try {
    environment();

    await setupSSHKey();
    await ensureHomebrew();
    await setupHomeshick();

    // Wait for Configuration folder to sync
    await waitForResilioSync(`${Deno.env.get('HOME')}/Configuration`);

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
