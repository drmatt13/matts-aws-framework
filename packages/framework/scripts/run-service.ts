import { spawn } from "node:child_process";
import { findRepositoryRoot } from "../src/config/source";
import { resolveLocalWorkloadEnvironment } from "../src/local/environment";
import framework from "../../../framework.config";

async function main(): Promise<void> {
  const [id, separator, command, ...args] = process.argv.slice(2);
  if (!id || separator !== "--" || !command) throw new Error("Usage: run-service <service-id> -- <command> [...args]");
  const env = await resolveLocalWorkloadEnvironment(framework, `service:${id}`, { repositoryRoot: findRepositoryRoot() });
  // Ports belong to Compose and its fixed networking, not to resource inputs.
  if (process.env.PORT) env.PORT = process.env.PORT;
  const child = spawn(command, args, { env, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => child.kill(signal));
  child.once("error", () => { console.error(`Unable to start service ${id}.`); process.exitCode = 1; });
  child.once("exit", (code) => { process.exitCode = code ?? 1; });
}
void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Service startup failed."); process.exitCode = 1; });
