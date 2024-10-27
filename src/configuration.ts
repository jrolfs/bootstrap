import { configurationSchema, environmentSchema } from './schemas.ts';

export const configuration = configurationSchema.parse({
  knownHosts: ['github.com'],
  github: {
    user: 'jrolfs',
    email: 'jamie.rolfs@gmail.com',
    clientId: 'Ov23littWGoGtwfc0yEv',
    repositories: [
      { url: 'git@github.com:jrolfs/neovim.git', name: 'neovim' },
      { url: 'git@github.com:jrolfs/private.git', name: 'private' },
      { url: 'git@github.com:jrolfs/macos.git', name: 'macos' },
      { url: 'git@github.com:jrolfs/dot.git', name: 'dot' },
    ],
  },
  homeshick: {
    remote: 'https://github.com/andsens/homeshick.git',
  },
});

let parsedEnvironment: ReturnType<typeof getEnvironment> | null = null;

const getEnvironment = () => {
  try {
    return ({
      ...environmentSchema.parse(Deno.env.toObject()),
      hostname: Deno.hostname().trim().toLowerCase(),
    });
  } catch (error) {
    console.error(error);
    throw new Error('Failed to parse environment');
  }
};

export const environment = () => {
  if (parsedEnvironment) return parsedEnvironment;

  parsedEnvironment = getEnvironment();

  return parsedEnvironment;
};
