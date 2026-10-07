import { z } from "zod";

/**
 * One of the example agent's Gateway tools. The model reads the description
 * and the schema; the agent dispatches the call it chooses through its Gateway.
 */
export const contract = {
  description: "Multiply two numbers together.",
  request: z.object({
    a: z.number().describe("First number to multiply"),
    b: z.number().describe("Second number to multiply"),
  }),
  response: z.object({ product: z.number() }),
} as const;
