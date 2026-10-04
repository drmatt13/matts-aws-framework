import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { deploymentArguments, inspectDeploymentAssembly } from "./deployment-assembly";
import { synchronizeDeploymentSecrets } from "./deployment-secrets";

const root = resolve(__dirname, "..");
const cdk = require.resolve("aws-cdk/bin/cdk");
function run(file: string, args: string[], cwd = root): Promise<void> {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd, stdio: "inherit", env: process.env });
    child.once("error", () => reject(new Error("Unable to start deployment tooling.")));
    child.once("exit", code => code === 0 ? accept() : reject(new Error(`Deployment tooling exited with status ${code}.`)));
  });
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) { await run(cdk, ["deploy", "--help"]); return; }
  // Validate inside main so declaration errors name their owners cleanly,
  // before synth, identity checks, secret synchronization or AWS deployment.
  const { default: framework } = await import("../framework.config");
  const { validateFrameworkConfig } = await import("@repo/framework/config");
  validateFrameworkConfig(framework);
  const selection = deploymentArguments(args);
  const inputFile = resolve(root, "cdk-app/.env");
  const authored = existsSync(inputFile) ? parseEnv(readFileSync(inputFile, "utf8")) : {};
  // One profile setting: the one cdk-app/.env already names for the local
  // containers, unless --profile or the shell says otherwise.
  const profile = selection.profile ?? process.env.AWS_PROFILE ?? authored.AWS_PROFILE ?? authored.LOCAL_AWS_PROFILE;
  if (profile) process.env.AWS_PROFILE = profile;
  if (selection.region) process.env.AWS_REGION = selection.region;
  const cache = resolve(root, ".cache/deploy");
  mkdirSync(cache, { recursive: true });
  const assembly = selection.output ? resolve(root, "cdk-app", selection.output) : mkdtempSync(resolve(cache, "assembly-"));
  await run(cdk, ["synth", ...selection.forwarded, ...(selection.app ? ["--app", selection.app] : []), "--quiet", "--output", assembly], resolve(root, "cdk-app"));
  const graph = inspectDeploymentAssembly(assembly, selection);
  if (selection.region && selection.region !== graph.identity.region) throw new Error("--region differs from the synthesized deployment region.");
  let account: string;
  try {
    const caller = JSON.parse(execFileSync("aws", ["sts", "get-caller-identity", "--output", "json", "--region", graph.identity.region, ...(profile ? ["--profile", profile] : [])], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    account = caller.Account;
  } catch { throw new Error("Unable to verify the selected AWS identity. Check your development or deployment credentials."); }
  if (account !== graph.identity.account) throw new Error("The selected AWS credentials do not match the synthesized deployment account. No secrets were changed.");
  // Users cannot override framework-owned parameters with a hand-authored ARN map.
  if (args.some(arg => graph.requirements.some(requirement => arg.includes(requirement.parameter)))) throw new Error("Managed secret parameters are supplied automatically; remove their --parameters overrides.");
  const client = new SecretsManagerClient({ region: graph.identity.region });
  let result;
  try {
    result = await synchronizeDeploymentSecrets(graph.requirements, authored, graph.identity, client, name => console.log(`Updated managed secret ${name}.`));
  } finally { client.destroy(); }
  try {
    await run(cdk, ["deploy", ...selection.forwarded, "--app", assembly, ...result.parameters.flatMap(value => ["--parameters", value])], resolve(root, "cdk-app"));
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : "Infrastructure deployment failed."} Secret updates already performed: ${result.updated.join(", ") || "none"}.`);
  }
  if (graph.identity.mode === "dev" && selection.execute) {
    try {
      await run(require.resolve("tsx/cli"), [resolve(root, "scripts/export-cdk-outputs.mjs"), "--cdk-app-name", graph.identity.deployment, "--region", graph.identity.region, ...(profile ? ["--profile", profile] : [])]);
    } catch {
      console.error("Infrastructure deployment succeeded, but development export failed. Previous local files were preserved. Run npm run export:cdk-outputs with the same profile and region after resolving the export error.");
      process.exitCode = 2;
    }
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Deployment failed."); process.exitCode = 1; });
