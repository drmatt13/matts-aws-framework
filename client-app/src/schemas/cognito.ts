import { z } from "zod";

export const CognitoIdTokenPayloadSchema = z.object({
  sub: z.string().uuid(),
  aud: z.string(),
  email: z.string().email(),
  email_verified: z.boolean(),
  token_use: z.literal("id"),
  auth_time: z.number(),
  iss: z.string(),
  "cognito:username": z.string(),
  exp: z.number(),
  iat: z.number(),
  given_name: z.string().optional(),
  family_name: z.string().optional(),
});

export const CognitoAccessTokenPayloadSchema = z.object({
  sub: z.string().uuid(),
  token_use: z.literal("access"),
  scope: z.string(),
  auth_time: z.number(),
  iss: z.string(),
  exp: z.number(),
  iat: z.number(),
  client_id: z.string(),
  username: z.string(),
});

export const CognitoAuthResultSchema = z.object({
  idToken: z.string(),
  accessToken: z.string(),
  refreshToken: z.string(),
});

export type CognitoIdTokenPayload = z.infer<typeof CognitoIdTokenPayloadSchema>;
export type CognitoAccessTokenPayload = z.infer<
  typeof CognitoAccessTokenPayloadSchema
>;
export type CognitoAuthResult = z.infer<typeof CognitoAuthResultSchema>;
