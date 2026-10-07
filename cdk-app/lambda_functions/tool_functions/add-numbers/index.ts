import { tool } from "@repo/framework/runtime/tools";
import { contract } from "./contract";

/** Arithmetic acts as no one, so this is a service tool rather than an authenticated one. */
export const lambdaHandler = tool(contract, async ({ a, b }) => ({ sum: a + b }));
