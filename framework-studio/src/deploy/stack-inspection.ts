import type { StackInspectionRequest, StackInspectionSections, StackInspectionSection, InspectionResult } from "../../shared/stack-inspection";
import { call } from "../http";
import type { DeploymentScope } from "./context";
import { AwsReadError } from "./queries";

/** The actor and destination stay in every cache key, even when stack names coincide. */
export interface StackInspectionScope extends DeploymentScope {
  readonly profile: string;
  readonly deployment: string;
  readonly account: string;
  readonly region: string;
  readonly stack: string;
}

export async function inspectStack<S extends StackInspectionSection>(
  scope: StackInspectionScope,
  section: S,
  options: Pick<StackInspectionRequest, "stackId" | "cursor" | "stage" | "changeSetId" | "exportName"> = {},
  signal?: AbortSignal,
): Promise<StackInspectionSections[S]> {
  const values = { profile: scope.profile, deployment: scope.deployment, mode: scope.mode,
    account: scope.account, region: scope.region, stack: scope.stack, section, ...options, force: "1" };
  const params = new URLSearchParams(Object.entries(values).filter((pair): pair is [string, string] => pair[1] !== undefined));
  const result = await call<InspectionResult<StackInspectionSections[S]>>(`/deploy/stack?${params}`, undefined, signal);
  if (!result.ok) throw new AwsReadError(result.problem);
  const destination = /^arn:[^:]+:cloudformation:([^:]+):([^:]+):stack\/([^/]+)\/[^/]+$/.exec(result.value.stackId);
  if (!destination || destination[1] !== scope.region || destination[2] !== scope.account || destination[3] !== scope.stack
    || section === "overview" && (result.value as StackInspectionSections["overview"]).name !== scope.stack)
    throw new AwsReadError({ kind: "failed", message: "AWS returned details for another deployment context. Close this inspector and refresh the deployment." });
  if (options.stackId && result.value.stackId !== options.stackId)
    throw new AwsReadError({ kind: "failed", message: "AWS returned details for another stack. Close this inspector and refresh the deployment." });
  return result.value;
}

export const stackInspectionKey = (scope: StackInspectionScope, section: StackInspectionSection, options: object = {}) =>
  ["deploy", "stack", scope, section, options] as const;
