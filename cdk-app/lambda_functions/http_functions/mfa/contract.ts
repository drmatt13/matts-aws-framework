import { z } from "zod";

/**
 * Two-step verification with an authenticator app (TOTP).
 *
 * `status` reads whether it is on; `setup` issues a new secret to scan;
 * `verify` checks the first code from the app and turns it on.
 */
export const MfaRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }),
  z.object({ action: z.literal("setup") }),
  z.object({
    action: z.literal("verify"),
    code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from your app."),
  }),
]);

export type MfaRequest = z.infer<typeof MfaRequestSchema>;

export const MfaResponseSchema = z.object({
  totpEnabled: z.boolean().optional(),
  /** Base32 secret, for typing into an app by hand. */
  secretCode: z.string().optional(),
  /** The same secret as an otpauth:// URI, for apps that open one. */
  otpauthUri: z.string().optional(),
  error: z.string().optional(),
});

export type MfaResponse = z.infer<typeof MfaResponseSchema>;

export const contract = {
  request: MfaRequestSchema,
  response: MfaResponseSchema,
} as const;
