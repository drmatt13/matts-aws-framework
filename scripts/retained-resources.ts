import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { writeDeploymentRecordAtomic } from "./deployment-artifact";

export interface RetainedResourceEvidence {
  readonly stack: string;
  readonly stackId: string;
  readonly logicalId: string;
  readonly type: string;
  readonly policy: string;
  readonly physicalId?: string;
  readonly templateDigest: string;
  /** Resolved physical Ref/GetAtt dependencies from the reviewed deployed template. */
  readonly dependencyPhysicalIds?: readonly string[];
}
export interface RetainedResourcesObservation {
  readonly reviewDigest: string;
  readonly createdAt: string;
  readonly phase: "before-teardown" | "teardown-completed" | "teardown-failed";
  readonly resources: readonly RetainedResourceEvidence[];
  readonly completedStackIds: readonly string[];
  readonly problem?: string;
}
export interface RetainedResourcesLedger {
  readonly version: 1;
  readonly account: string;
  readonly region: string;
  readonly deployment: string;
  readonly mode: "dev" | "prod";
  readonly observations: readonly RetainedResourcesObservation[];
}
function assertLedgerPath(root: string, file: string): void {
  const relative = path.relative(path.resolve(root), file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Retained-resource evidence escapes the checkout.");
  let cursor = path.resolve(root);
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    let entry: ReturnType<typeof lstatSync>;
    try { entry = lstatSync(cursor); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (entry.isSymbolicLink() || (cursor !== file && !entry.isDirectory()) || (cursor === file && !entry.isFile())) throw new Error(`Retained-resource evidence path is linked or has the wrong type: ${cursor}. Preserve and inspect it before recovery.`);
  }
}
function validLedger(value: any, account: string, region: string, deployment: string): value is RetainedResourcesLedger {
  const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !/[\x00-\x1f]/.test(value);
  const stackId = (value: unknown) => text(value) && new RegExp(`^arn:(?:aws|aws-us-gov|aws-cn):cloudformation:${region}:${account}:stack/[^/]+/[^/]+$`).test(value);
  const resource = (item: any) => item && text(item.stack) && stackId(item.stackId) && /^[A-Za-z][A-Za-z0-9]*$/.test(item.logicalId) && /^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$/.test(item.type) && ["Retain", "RetainExceptOnCreate", "Snapshot"].includes(item.policy) && text(item.templateDigest) && (item.physicalId === undefined || text(item.physicalId)) && (item.dependencyPhysicalIds === undefined || (Array.isArray(item.dependencyPhysicalIds) && item.dependencyPhysicalIds.every(text)));
  const observation = (item: any) => item && text(item.reviewDigest) && typeof item.createdAt === "string" && Number.isFinite(Date.parse(item.createdAt)) && ["before-teardown", "teardown-completed", "teardown-failed"].includes(item.phase) && Array.isArray(item.resources) && item.resources.every(resource) && Array.isArray(item.completedStackIds) && item.completedStackIds.every(stackId) && (item.problem === undefined || typeof item.problem === "string");
  return value?.version === 1 && value.account === account && value.region === region && value.deployment === deployment && (value.mode === "dev" || value.mode === "prod") && Array.isArray(value.observations) && value.observations.every(observation);
}
export function retainedResourcesFile(root: string, account: string, region: string, deployment: string): string {
  if (!/^\d{12}$/.test(account) || !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region) || !/^[a-z][a-z0-9-]{0,62}$/.test(deployment)) throw new Error("Invalid retained-resource ledger destination.");
  const file = path.resolve(root, ".framework", "retained-resources", account, region, deployment + ".json");
  assertLedgerPath(root, file);
  return file;
}
/** Local evidence survives removed declarations and deleted stacks. AWS must confirm availability. */
export function readRetainedResources(root: string, account: string, region: string, deployment?: string): RetainedResourcesLedger[] {
  const sample = retainedResourcesFile(root, account, region, deployment ?? "inventory");
  const files = deployment ? [sample] : existsSync(path.dirname(sample)) ? readdirSync(path.dirname(sample)).filter(name => /^[a-z][a-z0-9-]{0,62}\.json$/.test(name)).map(name => path.join(path.dirname(sample), name)) : [];
  return files.filter(existsSync).map(file => {
    assertLedgerPath(root, file);
    let ledger: unknown;
    try { ledger = JSON.parse(readFileSync(file, "utf8")); } catch { throw new Error(`Retained-resource evidence is unreadable: ${file}. Preserve and inspect this file before recovery.`); }
    if (!validLedger(ledger, account, region, path.basename(file, ".json"))) throw new Error(`Retained-resource evidence is invalid: ${file}. Preserve and inspect this file before recovery.`);
    return ledger;
  });
}
export function recordRetainedResources(root: string, identity: Omit<RetainedResourcesLedger, "version" | "observations">, observation: RetainedResourcesObservation): void {
  const file = retainedResourcesFile(root, identity.account, identity.region, identity.deployment);
  const existing = readRetainedResources(root, identity.account, identity.region, identity.deployment)[0];
  if (existing && existing.mode !== identity.mode) throw new Error("Retained-resource evidence belongs to another deployment mode; preserve the existing ledger.");
  mkdirSync(path.dirname(file), { recursive: true });
  assertLedgerPath(root, file);
  const ledger = { version: 1, ...identity, observations: [...existing?.observations ?? [], observation] } satisfies RetainedResourcesLedger;
  if (!validLedger(ledger, identity.account, identity.region, identity.deployment)) throw new Error("Invalid retained-resource evidence cannot be persisted. No destructive operation should proceed.");
  writeDeploymentRecordAtomic(file, ledger);
}
