import { z } from "zod";

export const MfaChallengeNameSchema = z.enum([
  "SMS_MFA",
  "SOFTWARE_TOKEN_MFA",
  "EMAIL_OTP",
  "SMS_OTP",
]);

export type MfaChallengeName = z.infer<typeof MfaChallengeNameSchema>;

export const PasswordSignInRequestSchema = z.object({
  type: z.literal("password"),
  email: z.string().trim().email(),
  password: z.string().min(1),
  rememberMe: z.boolean().optional(),
});

export const MfaSignInRequestSchema = z.object({
  type: z.literal("mfa"),
  challengeName: MfaChallengeNameSchema,
  session: z.string().min(1),
  username: z.string().min(1),
  code: z.string().trim().min(1),
  rememberMe: z.boolean().optional(),
});

export const SignInRequestSchema = z.discriminatedUnion("type", [
  PasswordSignInRequestSchema,
  MfaSignInRequestSchema,
]);

export type SignInRequest = z.infer<typeof SignInRequestSchema>;

export const SignInChallengeSchema = z.object({
  name: MfaChallengeNameSchema,
  session: z.string().min(1),
  username: z.string().min(1),
  destination: z.string().optional(),
});

export type SignInChallenge = z.infer<typeof SignInChallengeSchema>;

export const SignInResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  idToken: z.string().optional(),
  challenge: SignInChallengeSchema.optional(),
});

export type SignInResponse = z.infer<typeof SignInResponseSchema>;

export const contract = {
  request: SignInRequestSchema,
  response: SignInResponseSchema,
} as const;
