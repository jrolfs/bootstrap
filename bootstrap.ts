import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";

// Schema definitions
const CommandResultSchema = z.object({
  success: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
});

const GitHubSSHUrlSchema = z
  .string()
  .regex(/^git@github\.com:.+\/.+\.git$/, "Must be a valid GitHub SSH URL");

const RepositorySchema = z.object({
  url: GitHubSSHUrlSchema,
  name: z.string().min(1),
});

const DeviceCodeResponseSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string().url(),
  expires_in: z.number(),
  interval: z.number(),
});

// For the success case
const AccessTokenSuccessSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  scope: z.string(),
});

// For the error case (during polling)
const AccessTokenErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
  error_uri: z.string().optional(),
});

// Combined response type
const AccessTokenResponseSchema = z.union([
  AccessTokenSuccessSchema,
  AccessTokenErrorSchema,
]);

const EnvSchema = z.object({
  HOME: z.string().min(1),
});

const ConfigSchema = z.object({
  github: z.object({
    user: z.string(),
    email: z.string().email(),
    clientId: z.string().min(1),
    repositories: RepositorySchema.array(),
  }),
  homeshick: z.object({
    remote: z.string().url(),
  }),
});

// Configuration
const config = ConfigSchema.parse({
  github: {
    user: "jrolfs",
    email: "jamie.rolfs@gmail.com",
    clientId: "Ov23liqO5PWve95MDvAu",
    repositories: [
      { url: "git@github.com:jrolfs/neovim.git", name: "neovim" },
      { url: "git@github.com:jrolfs/private.git", name: "private" },
      { url: "git@github.com:jrolfs/macos.git", name: "macos" },
      { url: "git@github.com:jrolfs/dot.git", name: "dot" },
    ],
  },
  homeshick: {
    remote: "git://github.com/andsens/homeshick.git",
  },
});

// Environment validation
const getEnvironment = () => {
  const env = {
    HOME: Deno.env.get("HOME"),
  };

  return EnvSchema.parse(env);
};

// Utilities
const decoder = new TextDecoder();

const exec = async (cmd: string, args: string[] = []) => {
  console.log(`Running: ${cmd} ${args.join(" ")}`);
  
  const process = new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
  });

  const { success, stdout, stderr } = await process.output();

  return CommandResultSchema.parse({
    success,
    stdout: decoder.decode(stdout),
    stderr: decoder.decode(stderr),
  });
};

const pathExists = async (path: string) => {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
};

// GitHub Authentication
const getDeviceCode = async (clientId: string) => {
  const response = await fetch(
    "https://github.com/login/device/code",
    {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        scope: "write:public_key",
      }),
    },
  );

  if (!response.ok) {
    throw new Error("Failed to get device code");
  }

  const data = await response.json();
  return DeviceCodeResponseSchema.parse(data);
};

const pollForToken = async (
  clientId: string,
  deviceCode: string,
  interval: number,
) => {
  while (true) {
    const response = await fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: clientId,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      },
    );

    if (!response.ok) {
      throw new Error("Failed to get access token");
    }

    const data = await response.json();
    const result = AccessTokenResponseSchema.parse(data);

    if ("error" in result) {
      if (result.error === "authorization_pending") {
        await new Promise((resolve) => setTimeout(resolve, interval * 1000));
        continue;
      }
      throw new Error(`Authentication failed: ${result.error_description ?? result.error}`);
    }

    return result.access_token;
  }
};

const authenticateGitHub = async (clientId: string) => {
  const deviceCode = await getDeviceCode(clientId);
  
  console.log("\nTo authenticate with GitHub:");
  console.log(`1. Visit: ${deviceCode.verification_uri}`);
  console.log(`2. Enter code: ${deviceCode.user_code}\n`);

  return pollForToken(clientId, deviceCode.device_code, deviceCode.interval);
};

const uploadGitHubKey = async (publicKey: string) => {
  console.log("Initiating GitHub authentication...");
  const token = await authenticateGitHub(config.github.clientId);
  
  const { stdout: hostname } = await exec("hostname", ["-s"]);
  const cleanHostname = hostname.trim().toLowerCase();

  const response = await fetch("https://api.github.com/user/keys", {
    method: "POST",
    headers: {
      "Accept": "application/vnd.github.v3+json",
      "Authorization": `token ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: `bootstrap-${cleanHostname}`,
      key: publicKey.trim(),
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to upload SSH key to GitHub: ${error}`);
  }

  console.log("✓ SSH key uploaded to GitHub");
};

// Core functions
const ensureHomebrew = async () => {
  if (await pathExists("/opt/homebrew")) {
    console.log("✓ Homebrew already installed");
    return;
  }

  console.log("Installing Homebrew...");
  await exec("/bin/bash", [
    "-c",
    "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)",
  ]);
};

const setupSSHKey = async () => {
  const { HOME } = getEnvironment();
  const sshPath = `${HOME}/.ssh/id_ed25519`;
  const publicKeyPath = `${sshPath}.pub`;

  if (await pathExists(sshPath)) {
    console.log("✓ SSH key already exists");
    return;
  }

  const { stdout: hostname } = await exec("hostname", ["-s"]);
  const cleanHostname = hostname.trim().toLowerCase();

  console.log("Generating SSH key...");
  await exec("ssh-keygen", [
    "-t",
    "ed25519",
    "-C",
    `${config.github.email}+bootstrap-${cleanHostname}@gmail.com`,
    "-f",
    sshPath,
    "-N",
    "",
  ]);

  const publicKey = await Deno.readTextFile(publicKeyPath);
  await uploadGitHubKey(publicKey);
};

const setupHomeshick = async () => {
  const { HOME } = getEnvironment();
  const homeshickPath = `${HOME}/.homesick/repos/homeshick`;

  if (await pathExists(homeshickPath)) {
    console.log("✓ homeshick already installed");
    return;
  }

  console.log("Installing homeshick...");
  await exec("git", [
    "clone",
    config.homeshick.remote,
    homeshickPath,
  ]);

  const cloneRepo = async (repo: z.infer<typeof RepositorySchema>) => {
    const repoPath = `${HOME}/.homesick/repos/${repo.name}`;

    if (await pathExists(repoPath)) {
      console.log(`✓ ${repo.name} already cloned`);
      return;
    }

    console.log(`Cloning ${repo.name}...`);
    await exec("bash", [
      "-c",
      `source ${homeshickPath}/homeshick.sh && homeshick clone -b ${repo.url}`,
    ]);
  };

  await Promise.all(config.github.repositories.map(cloneRepo));

  console.log("Linking dotfiles...");
  await exec("bash", [
    "-c",
    `source ${homeshickPath}/homeshick.sh && homeshick link`,
  ]);
};

const buildSystem = async () => {
  const { HOME } = getEnvironment();
  const configPath = `${HOME}/.nixpkgs/darwin-configuration.nix`;

  if (!(await pathExists(configPath))) {
    throw new Error("darwin-configuration.nix not found. Make sure homeshick linked files correctly.");
  }

  console.log("Building system configuration...");
  await exec("darwin-rebuild", ["switch"]);
};

const bootstrap = async () => {
  try {
    getEnvironment();

    await setupSSHKey();
    await ensureHomebrew();
    await setupHomeshick();
    await buildSystem();

    console.log("✨ Bootstrap complete!");
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error("Validation error:", JSON.stringify(error.errors, null, 2));
    } else {
      console.error("Bootstrap failed:", error);
    }
    Deno.exit(1);
  }
};

if (import.meta.main) {
  bootstrap();
}