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

/** A parsed template or its JSON text. YAML, intrinsics and anything unreadable give no identity. */
export function identityFromTemplate(template: unknown): DeploymentIdentity | undefined {
  let document = template;
  if (typeof document === "string") {
    try { document = JSON.parse(document); } catch { return undefined; }
  }
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
