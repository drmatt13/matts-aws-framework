import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { inspectInfrastructureAssembly } from "../../scripts/infrastructure-inventory";
import { runCdkSynthesis, type CdkSynthesisRequest } from "../../scripts/cdk-synthesis";
import type { InfrastructureState } from "../shared/infrastructure";
import type { Mode, Snapshot } from "../shared/model";
import { selectedDeploymentInput } from "./deployment-inputs";

/** The current framework adapter. Inventory extraction and the runner know nothing about PROD_DEPLOYMENT. */
export function frameworkSynthesisInputs(root: string, mode: Mode, directory: string) {
  const relative = selectedDeploymentInput(root, mode);
  const source = path.join(root, relative);
  const text = existsSync(source) ? readFileSync(source, "utf8") : "";
  const values = Object.fromEntries(Object.entries(parseEnv(text)).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const file = path.join(directory, "inputs.env");
  // A final assignment overrides the original without reprinting quoted/multiline inputs.
  writeFileSync(file, `${text}\nPROD_DEPLOYMENT=${mode === "prod"}\n`, { mode: 0o600 });
  return { file, values, context: { useLocalDevStack: mode === "dev" }, description: {
    file: relative, modeSelection: `Isolated ${mode === "dev" ? "development" : "production"} input copy and matching CDK context`,
    profile: values.AWS_PROFILE || process.env.AWS_PROFILE || "Default AWS credential chain",
  } };
}

/** Covers inputs/context, framework/CDK implementation, workload assets and dependency versions. Never sent to the browser. */
export function infrastructureFingerprint(root: string, mode?: Mode): string {
  const hash = createHash("sha256");
  const visit = (relative: string): void => {
    const file = path.join(root, relative);
    if (!existsSync(file)) { hash.update(`${relative}:missing`); return; }
    const entries = readdirSync(file, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (["node_modules", "cdk.out", "dist", ".git", ".cache", "__pycache__"].includes(entry.name) || entry.isSymbolicLink()) continue;
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile() && !/\.tsbuildinfo$/.test(name)) { hash.update(name); hash.update(readFileSync(path.join(root, name))); }
    }
  };
  for (const directory of ["framework-config", "cdk-app/bin", "cdk-app/lib", "cdk-app/lambda_functions", "cdk-app/ecs_containers", "agents", "packages", "client-app/src", "client-app/public"]) visit(directory);
  for (const name of ["framework.config.ts", "package-lock.json", "package.json", "cdk-app/package.json", "cdk-app/deployment.ts", "cdk-app/database-settings.ts", "cdk-app/cdk.json", "cdk-app/cdk.context.json", ...(mode ? [selectedDeploymentInput(root, mode)] : ["cdk-app/.env", "cdk-app/.env.dev", "cdk-app/.env.prod"]), "client-app/package.json", "client-app/index.html", "client-app/vite.config.ts", ".dockerignore", "tsconfig.json"]) {
    hash.update(name); if (existsSync(path.join(root, name))) hash.update(readFileSync(path.join(root, name)));
  }
  return hash.digest("hex");
}

export function redactSynthesisError(error: unknown, values: Readonly<Record<string, string>>): string {
  let text = error instanceof Error ? error.message : "Synthesis failed.";
  for (const value of Object.values(values).filter(Boolean).sort((a, b) => b.length - a.length)) {
    for (const form of new Set([value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)])) text = text.split(form).join("[input value redacted]");
  }
  return text.slice(-6000);
}

export class InfrastructureService {
  private readonly states = new Map<Mode, InfrastructureState>();
  private readonly fingerprints = new Map<Mode, string>();
  private busy = false;
  constructor(private readonly root: string, private readonly snapshot: () => Snapshot | undefined,
    private readonly run: (request: CdkSynthesisRequest) => Promise<void> = runCdkSynthesis,
    private readonly changed: () => void = () => {}) {}

  get(mode: Mode): InfrastructureState {
    const state = this.states.get(mode) ?? { mode, status: "empty", stale: false };
    return { ...state, stale: !!state.inventory && (state.status === "failed" || this.fingerprints.get(mode) !== infrastructureFingerprint(this.root, mode)) };
  }

  /** Explicitly invoked. Switching graph/view or refreshing snapshots never calls this. */
  async synthesize(mode: Mode, profile?: string): Promise<InfrastructureState> {
    if (this.busy) throw Object.assign(new Error("An infrastructure synthesis is already running."), { status: 409 });
    if (profile && !/^[\w][\w.@+-]{0,127}$/.test(profile)) throw Object.assign(new Error("Use an AWS profile name containing letters, numbers, dots, underscores, +, @ or hyphens."), { status: 400 });
    const previous = this.states.get(mode);
    this.busy = true;
    this.states.set(mode, { ...previous, mode, status: "running", stale: !!previous?.inventory, startedAt: new Date().toISOString(), error: undefined });
    this.changed();
    const cache = path.resolve(this.root, ".cache/framework-studio/synthesis");
    let directory: string | undefined;
    let values: Record<string, string> = {};
    try {
      mkdirSync(cache, { recursive: true });
      directory = mkdtempSync(path.join(cache, `${mode}-`));
      const fingerprint = infrastructureFingerprint(this.root, mode);
      const snapshot = this.snapshot();
      const inputs = frameworkSynthesisInputs(this.root, mode, directory);
      values = inputs.values;
      const description = { ...inputs.description, ...(profile ? { profile } : {}) };
      await this.run({ repositoryRoot: this.root, outputDirectory: path.join(directory, "assembly"), context: inputs.context,
        environment: { FRAMEWORK_INPUTS_FILE: inputs.file, ...(profile || values.AWS_PROFILE ? { AWS_PROFILE: profile || values.AWS_PROFILE } : {}),
          // A parent shell must not make the deployment resolver disagree with the isolated catalog.
          PROD_DEPLOYMENT: mode === "prod" ? "true" : "false", FRAMEWORK_MODE: mode }, profile: profile || values.AWS_PROFILE });
      const inventory = inspectInfrastructureAssembly(path.join(directory, "assembly"));
      if (snapshot) for (const resource of inventory.resources) {
        if (resource.owners.length !== 1) continue;
        const source = snapshot.source.entities[resource.owners[0]!]?.key;
        if (source) resource.source = { file: source.file, line: source.line, column: source.column };
      }
      this.fingerprints.set(mode, fingerprint);
      this.states.set(mode, { mode, status: "ready", stale: false, generatedAt: new Date().toISOString(), sourceRevision: snapshot?.revision, inputs: description, inventory });
    } catch (error) {
      this.states.set(mode, { ...this.states.get(mode)!, status: "failed", stale: !!previous?.inventory, error: redactSynthesisError(error, values) });
    } finally {
      // Ephemeral input copies and raw templates never become the browser's inventory cache.
      try {
        if (directory) {
          const inside = path.relative(cache, path.resolve(directory));
          if (inside.startsWith("..") || path.isAbsolute(inside) || !inside) throw new Error("Refusing to remove a synthesis directory outside Studio's scratch directory.");
          rmSync(directory, { recursive: true });
        }
      } finally { this.busy = false; this.changed(); }
    }
    return this.get(mode);
  }
}
