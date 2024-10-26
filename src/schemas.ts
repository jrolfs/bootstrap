import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';

export const commandResultSchema = z.object({
  success: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
});

export const repositorySchema = z.object({
  url: z
    .string()
    .regex(/^git@github\.com:.+\/.+\.git$/, 'Must be a valid GitHub SSH URL'),
  name: z.string().min(1),
});

export const deviceCodeResponseSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string().url(),
  expires_in: z.number(),
  interval: z.number(),
});

export const accessTokenResponseSchema = z.union([
  z.object({
    access_token: z.string(),
    token_type: z.string(),
    scope: z.string(),
  }),
  z.object({
    error: z.string(),
    error_description: z.string().optional(),
    error_uri: z.string().optional(),
  }),
]);

export const configurationSchema = z.object({
  github: z.object({
    user: z.string(),
    email: z.string().email(),
    clientId: z.string().min(1),
    repositories: repositorySchema.array(),
  }),
  homeshick: z.object({
    remote: z.string().url(),
  }),
});


export const environmentSchema = z.object({
  HOME: z.string().min(1),
});

export const githubKeysResponseSchema = z.array(z.object({
  id: z.number(),
  key: z.string(),
  title: z.string(),
}));