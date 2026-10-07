import { z } from "zod";

/**
 * One of the example agent's Gateway tools. The model reads the description
 * and the schema; the agent dispatches the call it chooses through its Gateway.
 */
export const contract = {
  description: "Add two numbers together.",
  request: z.object({
    a: z.number().describe("First number to add"),
    b: z.number().describe("Second number to add"),
  }),
  response: z.object({ sum: z.number() }),
} as const;
