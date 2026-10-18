/**
 * What a deployed stack says about the deployment it belongs to.
 *
 * Every framework stack carries one output, described `framework:deployment:v1`,
 * whose value is the identity it was synthesized for. It is the authority for
 * which deployment, mode, account and region a stack belongs to: a stack name
 * or the selected AWS profile is not. A stack whose first create failed has no
 * outputs, but its template still holds the same output as a literal, so the
 * identity can be recovered from there.
 *
 * Pure: callers fetch stacks and templates, through whatever transport they use.
 */

export type DeploymentMode = "dev" | "prod";

export interface DeploymentIdentity {
  readonly deployment: string;
  readonly mode: DeploymentMode;
  readonly account: string;
  readonly region: string;
}

export const DEPLOYMENT_OUTPUT_DESCRIPTION = "framework:deployment:v1";

/** The fields of a `describe-stacks` entry this module reads; CLI and SDK shapes both fit. */
export interface ObservedStack {
  readonly StackName?: string;
  readonly StackId?: string;
  readonly StackStatus?: string;
  readonly StackStatusReason?: string;
  readonly CreationTime?: string;
  readonly LastUpdatedTime?: string;
  readonly Outputs?: readonly { readonly OutputKey?: string; readonly OutputValue?: string; readonly Description?: string }[];
  readonly Tags?: readonly { readonly Key?: string; readonly Value?: string }[];
}

export function parseIdentity(raw: string, owner = "a stack"): DeploymentIdentity {
  let value: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed as Record<string, unknown>;
  } catch {
    // Reported below with the owner's name.
  }
  if (
    !value ||
    value.version !== 1 ||
    typeof value.deployment !== "string" || !value.deployment ||
    (value.mode !== "dev" && value.mode !== "prod") ||
    typeof value.account !== "string" || !/^\d{12}$/.test(value.account) ||
    typeof value.region !== "string" || !value.region
  ) {
    throw new Error(`Invalid deployment metadata in ${owner}.`);
  }
  return { deployment: value.deployment, mode: value.mode, account: value.account, region: value.region };
}

export function identityFromOutputs(stack: ObservedStack): DeploymentIdentity | undefined {
  const raw = stack.Outputs?.find((output) => output.Description === DEPLOYMENT_OUTPUT_DESCRIPTION)?.OutputValue;
  return raw === undefined ? undefined : parseIdentity(raw, stack.StackName ?? "a stack");
}

/**
 * Contract 2 records the same identity twice more, where CloudFormation keeps it
 * for every stack, outputs or not: in the template's Metadata (readable from a
 * failed create or a stack awaiting review), and as stack tags, which
 * describe-stacks returns and CloudFormation copies onto the stack's resources.
 * The owner field says the stack is this framework's, not a lookalike's.
 */
export const DEPLOYMENT_METADATA_KEY = "framework:deployment";
export const FRAMEWORK_OWNER = "matts-aws-framework";
export const IDENTITY_TAGS = {
  owner: "framework:owner",
  deployment: "framework:deployment",
  mode: "framework:mode",
  contract: "framework:contract",
} as const;

export interface StackIdentity extends DeploymentIdentity {
  /** 1: the identity output only. 2: also template metadata and stack tags. */
  readonly contract?: 1 | 2;
  /** The stack's role in its deployment, e.g. CognitoStack (contract 2). */
  readonly stack?: string;
}

export function identityFromMetadata(metadata: unknown): StackIdentity | undefined {
  const value = metadata as Record<string, unknown> | undefined;
  if (!value || value.contract !== 2 || value.owner !== FRAMEWORK_OWNER) return undefined;
  try {
    const identity = parseIdentity(JSON.stringify({ ...value, version: 1 }));
    return { ...identity, contract: 2, ...(typeof value.stack === "string" ? { stack: value.stack } : {}) };
  } catch {
    return undefined;
  }
}

export function identityFromTags(stack: ObservedStack): StackIdentity | undefined {
  const tags = new Map((stack.Tags ?? []).map((tag) => [tag.Key, tag.Value]));
  if (tags.get(IDENTITY_TAGS.owner) !== FRAMEWORK_OWNER) return undefined;
  const location = stackLocation(stack.StackId);
  const mode = tags.get(IDENTITY_TAGS.mode);
  const deployment = tags.get(IDENTITY_TAGS.deployment);
  if (!location || !deployment || (mode !== "dev" && mode !== "prod")) return undefined;
  return { deployment, mode, account: location.account, region: location.region, contract: 2 };
}

/** A parsed template or its JSON text. YAML, intrinsics and anything unreadable give no identity. */
export function identityFromTemplate(template: unknown): StackIdentity | undefined {
  let document = template;
  if (typeof document === "string") {
    try { document = JSON.parse(document); } catch { return undefined; }
  }
  const fromMetadata = identityFromMetadata((document as { Metadata?: Record<string, unknown> } | undefined)?.Metadata?.[DEPLOYMENT_METADATA_KEY]);
  if (fromMetadata) return fromMetadata;
  const outputs = (document as { Outputs?: Record<string, { Description?: unknown; Value?: unknown }> } | undefined)?.Outputs;
  if (!outputs || typeof outputs !== "object") return undefined;
  const marker = Object.values(outputs).find((output) => output?.Description === DEPLOYMENT_OUTPUT_DESCRIPTION);
  if (typeof marker?.Value !== "string") return undefined;
  try { return parseIdentity(marker.Value); } catch { return undefined; }
}

export function stackLocation(stackId: string | undefined): { account: string; region: string } | undefined {
  const [, region, account] = /^arn:[^:]+:cloudformation:([^:]+):(\d{12}):stack\//.exec(stackId ?? "") ?? [];
  return region && account ? { account, region } : undefined;
}

export interface StackEvidence {
  readonly identity?: StackIdentity;
  /** Where the identity was read: tags and outputs from describe-stacks, or the deployed template. */
  readonly evidence: "tags" | "output" | "template" | "none";
  /** Set when the stack's own records contradict each other; such a stack is never adopted. */
  readonly problem?: string;
}

const describeIdentity = (identity: DeploymentIdentity) => `${identity.deployment} (${identity.mode})`;

/** What a stack says about itself: tags, then its identity output, then (if given) its template. */
export function stackEvidence(stack: ObservedStack, template?: unknown): StackEvidence {
  const name = stack.StackName ?? "a stack";
  let output: DeploymentIdentity | undefined;
  try {
    output = identityFromOutputs(stack);
  } catch (error) {
    return { evidence: "none", problem: error instanceof Error ? error.message : `Invalid deployment metadata in ${name}.` };
  }
  const tagged = identityFromTags(stack);
  if (tagged && output && (tagged.deployment !== output.deployment || tagged.mode !== output.mode)) {
    return { evidence: "none", problem: `${name}'s tags say ${describeIdentity(tagged)} but its identity output says ${describeIdentity(output)}.` };
  }
  if (tagged) return { identity: tagged, evidence: "tags" };
  if (output) return { identity: { ...output, contract: 1 }, evidence: "output" };
  const fromTemplate = template === undefined ? undefined : identityFromTemplate(template);
  if (fromTemplate) return { identity: { ...fromTemplate, contract: fromTemplate.contract ?? 1 }, evidence: "template" };
  return { evidence: "none" };
}
