import { z } from "zod";

/**
 * A harmless probe of the whole tool path: the model's arguments, the user's
 * identity and the result all cross the Gateway, and nothing touches data.
 */
export const contract = {
  description: "Echo a message back, with its length and the signed-in user it was echoed for.",
  request: z.object({
    message: z.string().min(1).max(2000).describe("The text to echo"),
  }),
  response: z.object({
    message: z.string(),
    length: z.number().int(),
    sub: z.string().describe("The Cognito subject of the user the tool acted as"),
  }),
} as const;
