import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { deploymentArguments, inspectDeploymentAssembly } from "./deployment-assembly";
import { assertDeploymentAllowed } from "./deployment-guard";
import { synchronizeDeploymentSecrets } from "./deployment-secrets";
import { acquireDeploymentLock, sweepStaleAssemblies } from "./deployment-workspace";
import { readDeploymentStackPages } from "./resource-export";

const root = resolve(__dirname, "..");
const cdk = require.resolve("aws-cdk/bin/cdk");

// What an interrupted run must still undo: the temporary assembly and the lock.
// The first Ctrl+C lets the running CDK command stop, so the finally blocks run;
// a second one cleans up immediately and exits.
const cleanups = new Set<() => void>();
let interrupted = false;
let current: ChildProcess | undefined;
function onSignal(signal: NodeJS.Signals): void {
  if (!interrupted) {
    interrupted = true;
    console.error("Interrupted. CloudFormation operations that already started continue in AWS; check the stacks before deploying again.");
    current?.kill(signal);
    return;
  }
  for (const cleanup of cleanups) { try { cleanup(); } catch { /* Best effort on the way out. */ } }
  process.exit(130);
}

function run(file: string, args: string[], cwd = root): Promise<void> {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd, stdio: "inherit", env: process.env });
    current = child;
    child.once("error", () => { current = undefined; reject(new Error("Unable to start deployment tooling.")); });
    child.once("exit", code => {
      current = undefined;
      if (code === 0) accept();
      else reject(new Error(interrupted ? "Deployment was interrupted." : `Deployment tooling exited with status ${code}.`));
    });
  });
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) { await run(cdk, ["deploy", "--help"]); return; }
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  // Validate inside main so declaration errors name their owners cleanly,
  // before synth, identity checks, secret synchronization or AWS deployment.
  const { default: framework } = await import("../framework.config");
  const { validateFrameworkConfig } = await import("@repo/framework/config");
  validateFrameworkConfig(framework);
  const selection = deploymentArguments(args);
  // The same file the CDK app and the resource catalog read.
  const inputFile = process.env.FRAMEWORK_INPUTS_FILE ? resolve(process.env.FRAMEWORK_INPUTS_FILE) : resolve(root, "cdk-app/.env");
  const authored = existsSync(inputFile) ? parseEnv(readFileSync(inputFile, "utf8")) : {};
  // An explicit flag or AWS_PROFILE selects named credentials. Otherwise the
  // AWS CLI and SDK use their standard default credential chain.
  const profile = selection.profile ?? process.env.AWS_PROFILE ?? authored.AWS_PROFILE;
  if (profile) process.env.AWS_PROFILE = profile;
  if (selection.region) process.env.AWS_REGION = selection.region;
  const cache = resolve(root, ".cache/deploy");
  mkdirSync(cache, { recursive: true });
  sweepStaleAssemblies(cache, Date.now());
  // A caller-named --output assembly is kept; the per-run temporary one is removed.
  const assembly = selection.output ? resolve(root, "cdk-app", selection.output) : mkdtempSync(resolve(cache, "assembly-"));
  const removeAssembly = () => rmSync(assembly, { recursive: true, force: true });
  if (!selection.output) cleanups.add(removeAssembly);
  let graph: ReturnType<typeof inspectDeploymentAssembly>;
  let release: (() => void) | undefined;
  try {
    try {
      await run(cdk, ["synth", ...selection.forwarded, ...(selection.app ? ["--app", selection.app] : []), "--quiet", "--output", assembly], resolve(root, "cdk-app"));
      graph = inspectDeploymentAssembly(assembly, selection);
      const region = graph.identity.region;
      if (selection.region && selection.region !== region) throw new Error("--region differs from the synthesized deployment region.");
      release = acquireDeploymentLock(cache, graph.identity.deployment);
      cleanups.add(release);
      const runAws = (command: string[]) => JSON.parse(execFileSync("aws", [...command, "--output", "json", "--region", region, ...(profile ? ["--profile", profile] : [])], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }));
      let account: string;
      try { account = runAws(["sts", "get-caller-identity"]).Account; }
      catch { throw new Error("Unable to verify the selected AWS identity. Check your development or deployment credentials."); }
      if (account !== graph.identity.account) throw new Error("The selected AWS credentials do not match the synthesized deployment account. No secrets were changed.");
      // What AWS already holds under this name decides whether it may be changed:
      // before any secret is written, so a refusal changes nothing.
      const deployed = assertDeploymentAllowed(graph.identity, args, {
        readStacks: () => readDeploymentStackPages(token => runAws(["cloudformation", "describe-stacks", "--no-paginate", ...(token ? ["--next-token", token] : [])])),
        readTemplate: name => runAws(["cloudformation", "get-template", "--stack-name", name, "--template-stage", "Original"]).TemplateBody,
      });
      if (deployed.kind === "rolled-back") console.log(`The last update of ${graph.identity.deployment} was rolled back; this deployment replaces it.`);
      if (deployed.kind === "failed") console.log(`${graph.identity.deployment} has stacks whose first create failed; CloudFormation removes and recreates them.`);
      // Users cannot override framework-owned parameters with a hand-authored ARN map.
      if (args.some(arg => graph.requirements.some(requirement => arg.includes(requirement.parameter)))) throw new Error("Managed secret parameters are supplied automatically; remove their --parameters overrides.");
      const client = new SecretsManagerClient({ region });
      let result;
      try {
        result = await synchronizeDeploymentSecrets(graph.requirements, authored, graph.identity, client, name => console.log(`Updated managed secret ${name}.`));
      } finally { client.destroy(); }
      try {
        await run(cdk, ["deploy", ...selection.forwarded, "--app", assembly, ...result.parameters.flatMap(value => ["--parameters", value])], resolve(root, "cdk-app"));
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : "Infrastructure deployment failed."} Secret updates already performed: ${result.updated.join(", ") || "none"}.`);
      }
    } finally {
      if (!selection.output) { removeAssembly(); cleanups.delete(removeAssembly); }
    }
    if (graph.identity.mode === "dev" && selection.execute) {
      try {
        await run(require.resolve("tsx/cli"), [resolve(root, "scripts/export-cdk-outputs.mjs"), "--cdk-app-name", graph.identity.deployment, "--region", graph.identity.region, ...(profile ? ["--profile", profile] : [])]);
      } catch {
        console.error("Infrastructure deployment succeeded, but development export failed. Previous local files were preserved. Run npm run export:cdk-outputs with the same profile and region after resolving the export error.");
        process.exitCode = 2;
      }
    }
  } finally {
    if (release) { release(); cleanups.delete(release); }
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Deployment failed."); process.exitCode = 1; });
