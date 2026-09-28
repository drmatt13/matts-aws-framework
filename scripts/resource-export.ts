import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  getLocalTargets, isResourceAbsent, isResourceReference, resourceAttributeKey,
  resolveWorkflow, integrationKey, parseResourceManifest, type FrameworkConfig, type ResourceManifest,
} from "@repo/framework/config";

export interface DeploymentStack {
  readonly StackName?: string;
  readonly StackId?: string;
  readonly StackStatus?: string;
  readonly Outputs?: readonly { OutputKey?: string; OutputValue?: string; Description?: string }[];
}
const RESOURCE_PREFIX = "framework:resource:v1:";
const INTEGRATION_PREFIX = "framework:workflow-integration:";

export function readDeploymentStackPages(readPage: (token?: string) => { Stacks?: DeploymentStack[]; NextToken?: string }): DeploymentStack[] {
  const stacks: DeploymentStack[] = [];
  const seen = new Set<string>();
  let token: string | undefined;
  do {
    const page = readPage(token);
    stacks.push(...page.Stacks ?? []);
    token = page.NextToken;
    if (token && seen.has(token)) throw new Error("CloudFormation repeated a pagination token; export was aborted.");
    if (token) seen.add(token);
  } while (token);
  return stacks;
}

/** Deployed metadata is authoritative; local environment flags cannot relabel production. */
export function collectDevelopmentResources(stacks: readonly DeploymentStack[], deployment: string, config: FrameworkConfig): { manifest: ResourceManifest; stacks: readonly DeploymentStack[] } {
  const selected: DeploymentStack[] = [];
  let identity: { deployment: string; mode: string; account: string; region: string } | undefined;
  const attributes: Record<string, string> = Object.create(null);
  const integrations: Record<string, string> = Object.create(null);
  const put = (map: Record<string, string>, key: string, value: string): void => {
    if (Object.hasOwn(map, key)) throw new Error(`Duplicate deployed resource output ${key}. Existing local files were preserved.`);
    map[key] = value;
  };
  for (const stack of stacks) {
    const raw = stack.Outputs?.find((output) => output.Description === "framework:deployment:v1")?.OutputValue;
    if (!raw) continue;
    let metadata: any;
    try { metadata = JSON.parse(raw); } catch { throw new Error(`Invalid deployment metadata in ${stack.StackName}.`); }
    if (metadata.deployment !== deployment) continue;
    if (metadata.version !== 1 || metadata.mode !== "dev") throw new Error("Exporting production resources into the development environment is refused.");
    if (stack.StackStatus && !["CREATE_COMPLETE", "UPDATE_COMPLETE", "IMPORT_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"].includes(stack.StackStatus)) throw new Error(`${stack.StackName} is not in a completed deployment state. Existing local files were preserved.`);
    const parts = stack.StackId?.split(":");
    if (parts?.[3] !== metadata.region || parts?.[4] !== metadata.account) throw new Error(`${stack.StackName} has inconsistent account/region metadata.`);
    if (identity && ["deployment", "mode", "account", "region"].some((key) => metadata[key] !== identity![key as keyof typeof identity])) throw new Error("Deployment stacks disagree on their resource identity.");
    identity = metadata;
    selected.push(stack);
    for (const output of stack.Outputs ?? []) {
      if (output.OutputValue === undefined) continue;
      const description = output.Description ?? "";
      if (description.startsWith(RESOURCE_PREFIX)) put(attributes, description.slice(RESOURCE_PREFIX.length), output.OutputValue);
      if (description.startsWith(INTEGRATION_PREFIX)) put(integrations, description.slice(INTEGRATION_PREFIX.length), output.OutputValue);
    }
  }
  if (!identity) throw new Error(`No development resource metadata was found for ${deployment}. Deploy the updated framework before exporting.`);
  const manifest = parseResourceManifest(JSON.stringify({ version: 1, ...identity, attributes, integrations }));
  for (const target of getLocalTargets(config, ["http", "webSocket", "webSocketAuthorizer", "event", "service", "task", "workflow"])) {
    for (const reference of [...Object.values(target.environment).filter(isResourceReference), ...Object.values(target.secrets)]) {
      if (isResourceAbsent(reference) || (reference.fromEnv && !reference.secretArn)) continue;
      if (attributes[resourceAttributeKey(reference)] === undefined && !reference.optional) throw new Error(`${target.reference} needs an attribute absent from the deployment. Deploy the updated resource declarations before exporting.`);
    }
    if (target.kind === "workflow") for (const use of resolveWorkflow(config, target.id).integrations) {
      if (!Object.hasOwn(integrations, integrationKey(use.reference))) throw new Error(`${target.reference} needs ${integrationKey(use.reference)}, which this deployment has not published.`);
    }
  }
  return { manifest, stacks: selected };
}

/** Stage all files before replacing either; roll back replacements on a write failure. */
export function writeDevelopmentFiles(files: readonly { path: string; contents: string }[], replace: (from: string, to: string) => void = renameSync): void {
  const staged = files.map((file) => ({ ...file, temporary: `${file.path}.${randomUUID()}.tmp`, previous: existsSync(file.path) ? readFileSync(file.path) : undefined }));
  const replaced: typeof staged = [];
  try {
    for (const file of staged) { mkdirSync(dirname(file.path), { recursive: true }); writeFileSync(file.temporary, file.contents, { mode: 0o600 }); }
    for (const file of staged) { replace(file.temporary, file.path); replaced.push(file); }
  } catch (error) {
    for (const file of replaced.reverse()) {
      if (file.previous === undefined) rmSync(file.path, { force: true });
      else { writeFileSync(file.temporary, file.previous, { mode: 0o600 }); renameSync(file.temporary, file.path); }
    }
    throw error;
  } finally {
    for (const file of staged) rmSync(file.temporary, { force: true });
  }
}
