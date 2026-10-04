import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { serveAgent } from "../src/runtime/agentcore-serve";

/**
 * One local agent session: the module at argv[2], served by the same adapter
 * AgentCore Runtime runs, on a free port it reports to the runner over IPC.
 * Its environment — the agent's declared inputs and the adapter settings — is
 * complete before the module is imported, as in a Runtime microVM.
 */
async function main(): Promise<void> {
  const entry = process.argv[2];
  if (!entry) throw new Error("serve-agent needs the agent's entry module.");
  const module = (await import(pathToFileURL(path.resolve(entry)).href)) as { handler?: unknown };
  const server = await serveAgent(module.handler, 0);
  process.send?.({ port: (server.address() as AddressInfo).port });
  // A session never outlives the runner that started it.
  process.on("disconnect", () => process.exit(0));
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.close();
      server.closeAllConnections();
      process.exit(0);
    });
  }
}

void main().catch((error: unknown) => {
  console.error("Agent startup failed:", error);
  process.exitCode = 1;
  process.disconnect?.();
});
