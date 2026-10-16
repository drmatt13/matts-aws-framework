import { spawn } from "node:child_process";
import { findRepositoryRoot, resolveServicePort } from "../src/config/source";
import { resolveLocalWorkloadEnvironment } from "../src/local/environment";
import framework from "../../../framework.config";

async function main(): Promise<void> {
  const [id, separator, command, ...args] = process.argv.slice(2);
  if (!id || separator !== "--" || !command) throw new Error("Usage: run-service <service-id> -- <command> [...args]");
  const repositoryRoot = findRepositoryRoot();
  const env = await resolveLocalWorkloadEnvironment(framework, `service:${id}`, { repositoryRoot });
  // Ports belong to the container and the declaration, not to resource inputs:
  // the container's PORT when it sets one (framework:generate checks that it
  // agrees), otherwise the declared port, which is the one ECS is given.
  env.PORT = process.env.PORT || String(resolveServicePort(framework, id, { repositoryRoot }));
  const child = spawn(command, args, { env, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => child.kill(signal));
  child.once("error", () => { console.error(`Unable to start service ${id}.`); process.exitCode = 1; });
  child.once("exit", (code) => { process.exitCode = code ?? 1; });
}
void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Service startup failed."); process.exitCode = 1; });
