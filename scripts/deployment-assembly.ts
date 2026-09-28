import { readFileSync } from "node:fs";
import { matchesGlob, resolve } from "node:path";
import type { SecretRequirement } from "./deployment-secrets";

interface Artifact {
  type: string;
  environment?: string;
  dependencies?: string[];
  properties?: { templateFile?: string; stackName?: string };
  metadata?: Record<string, { type: string; data: unknown }[]>;
  additionalMetadataFile?: string;
}
const booleanOptions = new Set(["all", "exclusively", "e", "force", "f", "hotswap", "hotswap-fallback", "watch", "logs", "rollback", "R", "execute", "previous-parameters", "asset-prebuild", "asset-parallelism", "import-existing-resources", "revert-drift", "express", "ignore-no-stacks", "validation", "lookups", "strict", "trace", "debug", "debug-app", "debug-cli", "ec2creds", "i", "version-reporting", "telemetry", "path-metadata", "asset-metadata", "staging", "notices", "color", "ci", "yes", "y", "quiet", "q", "verbose", "v", "help", "h", "version", "json", "long", "l", "show-dependencies", "d"]);

/** CDK switches remain intact; only stack selectors and wrapper-owned paths are inspected. */
export function deploymentArguments(args: readonly string[]): { selectors: string[]; all: boolean; exclusively: boolean; profile?: string; region?: string; app?: string; output?: string; forwarded: string[]; execute: boolean } {
  const selectors: string[] = [];
  const forwarded: string[] = [];
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const start = index;
    const arg = args[index];
    if (!arg.startsWith("-")) { selectors.push(arg); forwarded.push(arg); continue; }
    const [key, inline] = arg.replace(/^-+/, "").split(/=(.*)/s, 2);
    if (key === "watch") throw new Error("Use npm run deploy for a completed deployment. CDK watch cannot refresh secrets from a pre-synthesized assembly.");
    if (key.startsWith("no-")) { values.set(key.slice(3), "false"); forwarded.push(arg); continue; }
    if (/^v+$/.test(key)) { forwarded.push(arg); continue; }
    if (booleanOptions.has(key)) {
      const next = args[index + 1];
      values.set(key, inline ?? (next === "true" || next === "false" ? args[++index] : "true"));
    } else {
      const value = inline ?? args[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`--${key} needs a value.`);
      values.set(key, value);
    }
    if (!["app", "a", "output", "o"].includes(key)) forwarded.push(...args.slice(start, index + 1));
  }
  return { selectors, all: values.get("all") === "true", exclusively: values.get("exclusively") === "true" || values.get("e") === "true", profile: values.get("profile"), region: values.get("region"), app: values.get("app") ?? values.get("a"), output: values.get("output") ?? values.get("o"), forwarded, execute: values.get("execute") !== "false" && values.get("method") !== "prepare-change-set" };
}

export function inspectDeploymentAssembly(directory: string, selection: ReturnType<typeof deploymentArguments>) {
  const document = JSON.parse(readFileSync(resolve(directory, "manifest.json"), "utf8")) as { artifacts: Record<string, Artifact> };
  const stacks = Object.entries(document.artifacts).filter(([, artifact]) => artifact.type === "aws:cloudformation:stack");
  const selected = new Set<string>();
  if (selection.all) stacks.forEach(([id]) => selected.add(id));
  else if (!selection.selectors.length && stacks.length === 1) selected.add(stacks[0][0]);
  else for (const pattern of selection.selectors) {
    const matches = stacks.filter(([id, artifact]) => matchesGlob(id, pattern) || matchesGlob(artifact.properties?.stackName ?? id, pattern));
    if (!matches.length) throw new Error(`No synthesized stack matches ${pattern}.`);
    matches.forEach(([id]) => selected.add(id));
  }
  if (!selected.size) throw new Error("Select stacks to deploy or pass --all.");
  const includeDependencies = (id: string): void => {
    for (const dependency of document.artifacts[id]?.dependencies ?? []) {
      if (document.artifacts[dependency]?.type === "aws:cloudformation:stack" && !selected.has(dependency)) {
        selected.add(dependency); includeDependencies(dependency);
      }
    }
  };
  if (!selection.exclusively) for (const id of selected) includeDependencies(id);
  const requirements: SecretRequirement[] = [];
  let identity: { deployment: string; account: string; region: string; mode: "dev" | "prod" } | undefined;
  for (const id of selected) {
    const artifact = document.artifacts[id];
    const [, account, region] = /^aws:\/\/(\d{12})\/([^/]+)$/.exec(artifact.environment ?? "") ?? [];
    if (!account || !region) throw new Error(`${id} must have a concrete deployment account and region.`);
    const template = JSON.parse(readFileSync(resolve(directory, artifact.properties!.templateFile!), "utf8"));
    const marker = Object.values(template.Outputs ?? {}).find((output: any) => output.Description === "framework:deployment:v1") as { Value: string } | undefined;
    if (!marker || typeof marker.Value !== "string") throw new Error(`${id} has no resolved framework deployment identity.`);
    const metadata = JSON.parse(marker.Value);
    if (metadata.version !== 1 || !["dev", "prod"].includes(metadata.mode) || metadata.account !== account || metadata.region !== region) throw new Error(`${id} has invalid deployment metadata.`);
    if (identity && ["deployment", "account", "region", "mode"].some(key => metadata[key] !== identity![key as keyof typeof identity])) throw new Error("The selected stacks must belong to one deployment, mode, account and region.");
    identity = metadata;
    const entries = { ...artifact.metadata, ...(artifact.additionalMetadataFile ? JSON.parse(readFileSync(resolve(directory, artifact.additionalMetadataFile), "utf8")) : {}) };
    for (const records of Object.values(entries) as { type: string; data: SecretRequirement }[][]) for (const record of records) {
      if (record.type !== "framework:secret-parameter:v1") continue;
      const data = record.data;
      if (data.version !== 1 || !Array.isArray(data.path) || !data.path.length || !data.variable || !data.name || data.account !== account || data.region !== region || data.deployment !== metadata.deployment || data.mode !== metadata.mode || !template.Parameters?.[data.parameter]) throw new Error(`Invalid managed secret requirement in ${id}.`);
      requirements.push({ ...data, stack: artifact.properties?.stackName ?? id });
    }
  }
  return { identity: identity!, requirements, stacks: [...selected] };
}
