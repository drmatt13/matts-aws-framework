import path from "node:path";
import { executionPolicy } from "../policy";
import { runCodex } from "./codex";
import { runClaude } from "./claude";
import type { ProviderOptions, ProviderResult } from "./types";
export type { AgentProvider, ProviderOptions, ProviderResult, ProviderEvent, ProviderApproval } from "./types";

export async function runProvider(options: ProviderOptions, dependencies: {
  policy?: typeof executionPolicy; codex?: typeof runCodex; claude?: typeof runClaude;
} = {}): Promise<ProviderResult> {
  if (options.signal.aborted) return { status: "cancelled", sessionId: options.sessionId };
  try {
    const policy = (dependencies.policy ?? executionPolicy)(options.cwd, options.scratchDir ?? path.join(path.dirname(options.cwd), "provider-scratch"));
    if (options.provider === "codex") return await (dependencies.codex ?? runCodex)(options, policy);
    if (options.provider === "claude") return await (dependencies.claude ?? runClaude)(options, policy);
    throw new Error("Unsupported coding provider.");
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : "Provider setup failed." };
  }
}
