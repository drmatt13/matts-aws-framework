import { z } from "zod";

/**
 * What the browser sends this agent, and the events it streams back. Projected
 * into @repo/api-contract, so the client is typed by the same declaration the
 * agent validates against.
 */
export const contract = {
  request: z.object({ message: z.string().min(1).max(2000) }),
  event: z.discriminatedUnion("type", [
    z.object({ type: z.literal("status"), text: z.string() }),
    z.object({
      type: z.literal("echo"),
      message: z.string(),
      length: z.number().int(),
      sub: z.string(),
    }),
  ]),
} as const;
