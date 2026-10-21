/**
 * The parts of a reviewed deployment plan that are rules rather than AWS calls:
 * what a template change does, what a production review must confirm, and
 * whether a plan still describes what AWS holds. deploy.ts --plan and --apply
 * use them; Studio shows their output.
 */

export const PLAN_VERSION = 1;
/** How long a reviewed plan stays applicable: assets and change sets age, and so does a review. */
export const PLAN_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Resource types whose replacement or removal loses data or identity. */
export const STATEFUL_TYPES = new Set([
  "AWS::RDS::DBInstance", "AWS::RDS::DBCluster", "AWS::Cognito::UserPool", "AWS::S3::Bucket",
  "AWS::DynamoDB::Table", "AWS::DynamoDB::GlobalTable", "AWS::SecretsManager::Secret", "AWS::KMS::Key",
  "AWS::EFS::FileSystem", "AWS::Logs::LogGroup",
]);

export type ResourceAction = "add" | "modify" | "remove";
export type Replacement = "True" | "False" | "Conditional" | "Unknown";

export interface ResourceChange {
  readonly logicalId: string;
  readonly type: string;
  readonly action: ResourceAction;
  /** From a CloudFormation change set; "Unknown" for a template comparison. */
  readonly replacement: Replacement;
  /** For a removal: Delete (the default), Retain, RetainExceptOnCreate or Snapshot. */
  readonly deletionPolicy?: string;
  readonly stateful: boolean;
  /** The properties or attributes the change touches, when CloudFormation says. */
  readonly details?: readonly string[];
}

export interface ExportInUse {
  readonly stack: string;
  readonly exportName: string;
  readonly change: "removed" | "changed";
  readonly importers: readonly string[];
}

export interface StackFingerprint {
  readonly exists: boolean;
  readonly status?: string;
  /** LastUpdatedTime, or CreationTime for a stack never updated. */
  readonly updated?: string;
}

type Template = { Resources?: Record<string, { Type?: string; DeletionPolicy?: string; Properties?: unknown; [key: string]: unknown }>; Outputs?: Record<string, { Value?: unknown; Export?: { Name?: unknown } }> };

const stable = (value: unknown) => JSON.stringify(value, (_key, inner) =>
  inner && typeof inner === "object" && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b))) : inner);

/** Resource-level differences between the deployed and the synthesized template. */
export function templateChanges(deployed: Template | undefined, synthesized: Template): ResourceChange[] {
  const before = deployed?.Resources ?? {};
  const after = synthesized.Resources ?? {};
  const changes: ResourceChange[] = [];
  for (const [logicalId, resource] of Object.entries(after)) {
    const type = String(resource.Type ?? "Unknown");
    const previous = before[logicalId];
    if (!previous) changes.push({ logicalId, type, action: "add", replacement: "Unknown", stateful: STATEFUL_TYPES.has(type) });
    else if (stable(previous) !== stable(resource)) {
      const typeChanged = previous.Type !== resource.Type;
      changes.push({ logicalId, type, action: "modify", replacement: typeChanged ? "True" : "Unknown", stateful: STATEFUL_TYPES.has(type) || STATEFUL_TYPES.has(String(previous.Type)) });
    }
  }
  for (const [logicalId, resource] of Object.entries(before)) {
    if (after[logicalId]) continue;
    const type = String(resource.Type ?? "Unknown");
    changes.push({ logicalId, type, action: "remove", replacement: "Unknown", deletionPolicy: resource.DeletionPolicy ?? "Delete", stateful: STATEFUL_TYPES.has(type) });
  }
  return changes.sort((a, b) => a.action.localeCompare(b.action) || a.logicalId.localeCompare(b.logicalId));
}

/** Exports the deployed template publishes that the new one removes or changes. */
export function changedExports(deployed: Template | undefined, synthesized: Template): { exportName: string; change: "removed" | "changed" }[] {
  const exportsOf = (template: Template | undefined) => new Map(Object.values(template?.Outputs ?? {})
    .filter((output) => typeof output.Export?.Name === "string")
    .map((output) => [output.Export!.Name as string, stable(output.Value)]));
  const before = exportsOf(deployed);
  const after = exportsOf(synthesized);
  return [...before].flatMap(([exportName, value]): { exportName: string; change: "removed" | "changed" }[] =>
    !after.has(exportName) ? [{ exportName, change: "removed" }]
    : after.get(exportName) !== value ? [{ exportName, change: "changed" }]
    : []);
}

export interface ConfirmationInput {
  readonly mode: "dev" | "prod";
  readonly firstDeploy: boolean;
  readonly iamBroadening: boolean;
  readonly changes: readonly ResourceChange[];
  readonly exportsInUse: readonly ExportInUse[];
}

/**
 * none: development continues on its own. click: a person approves.
 * name: a person types the deployment's name (production's consequential changes).
 */
export function confirmationLevel(input: ConfirmationInput): { level: "none" | "click" | "name"; reasons: string[] } {
  const reasons: string[] = [];
  const removals = input.changes.filter((change) => change.action === "remove");
  if (removals.length) reasons.push(`${removals.length} resource${removals.length === 1 ? "" : "s"} removed`);
  if (input.iamBroadening) reasons.push("IAM or security permissions broadened");
  if (input.mode === "prod") {
    const replaced = input.changes.filter((change) => change.replacement === "True" || change.replacement === "Conditional");
    if (replaced.length) reasons.push(`${replaced.length} resource${replaced.length === 1 ? "" : "s"} replaced`);
    const stateful = input.changes.filter((change) => change.stateful && change.action !== "add");
    if (stateful.length) reasons.push(`stateful resources changed: ${stateful.map((change) => change.logicalId).join(", ")}`);
    if (input.exportsInUse.length) reasons.push("exports other stacks import are changing");
    if (input.firstDeploy) reasons.push("the first deployment of this target");
    return { level: reasons.length ? "name" : "click", reasons };
  }
  return { level: reasons.length ? "click" : "none", reasons };
}

/** Why a plan no longer describes AWS, or undefined when it still does. */
export function staleness(planned: Readonly<Record<string, StackFingerprint>>, current: Readonly<Record<string, StackFingerprint>>): string | undefined {
  for (const [stack, before] of Object.entries(planned)) {
    const now = current[stack] ?? { exists: false };
    if (before.exists !== now.exists || before.status !== now.status || before.updated !== now.updated) {
      const describe = (fingerprint: StackFingerprint) => fingerprint.exists ? `${fingerprint.status} at ${fingerprint.updated}` : "absent";
      return `${stack} changed since the review (${describe(before)} then, ${describe(now)} now).`;
    }
  }
  return undefined;
}

/** What a review cannot establish, stated in every plan. */
export const PLAN_UNCERTAINTIES = {
  template: [
    "Replacement is not known from a template comparison: a modified resource may be replaced. Use a change-set review for certainty.",
    "Secret values are compared, never shown; changed values are written before the stacks update and reach runtime readers at once. Apply refuses if an authored value, or the value in Secrets Manager, changed since this review.",
    "Changes made outside CloudFormation (drift) are not part of this comparison.",
    "Custom resources run code whose effects a plan cannot predict.",
  ],
  "change-set": [
    "Parameters resolved when the change set runs (such as the bootstrap version) are not known until then.",
    "Secret values are compared, never shown; changed values are written before the change sets execute and reach runtime readers at once. Apply refuses if an authored value, or the value in Secrets Manager, changed since this review.",
    "CloudFormation compares against the deployed template and parameters; drift is included only in a drift-aware review.",
    "A stack whose imports depend on another stack's new exports can only be planned after that stack runs; it is deferred.",
    "Custom resources run code whose effects a plan cannot predict.",
  ],
} as const;
