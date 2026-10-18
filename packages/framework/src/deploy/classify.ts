import {
  DEPLOYMENT_OUTPUT_DESCRIPTION,
  identityFromOutputs,
  identityFromTemplate,
  stackLocation,
  type DeploymentIdentity,
  type ObservedStack,
} from "./identity";

/**
 * Whether a deployment may be changed, from what CloudFormation says about it.
 *
 * A stack counts toward a deployment when its identity output names it, or when
 * its name follows the deployment's pattern (`<deployment>-<Suffix>`). The
 * second rule is what keeps a stack with no outputs (a failed first create, a
 * change set awaiting review, a stack from before the identity output existed)
 * from being mistaken for "nothing deployed". Such a stack is identified from
 * its template, or it is refused: nothing is adopted on a name alone.
 */

/**
 * `failed-create` and `paused` are failures the CDK CLI recovers from itself:
 * it deletes and recreates a stack whose first create failed, and it retries or
 * rolls back a stack `--no-rollback` paused. Only `failed` needs a person.
 */
export type StackHealth = "complete" | "rolled-back" | "in-progress" | "review" | "failed-create" | "paused" | "failed";

export function stackHealth(status: string | undefined): StackHealth {
  if (!status) return "failed";
  if (status === "ROLLBACK_COMPLETE" || status === "ROLLBACK_FAILED") return "failed-create";
  if (status === "CREATE_FAILED" || status === "UPDATE_FAILED") return "paused";
  if (status === "UPDATE_ROLLBACK_COMPLETE" || status === "IMPORT_ROLLBACK_COMPLETE") return "rolled-back";
  if (status === "REVIEW_IN_PROGRESS") return "review";
  if (status.endsWith("_IN_PROGRESS")) return "in-progress";
  if (status.endsWith("_COMPLETE")) return "complete";
  return "failed";
}

export interface ClassifiedStack {
  readonly name: string;
  readonly status: string;
  readonly health: StackHealth;
  readonly identity?: DeploymentIdentity;
  readonly evidence: "output" | "template" | "none";
}

export type DeploymentQuery = DeploymentIdentity;

export type DeploymentState =
  | { readonly kind: "absent" }
  | { readonly kind: "ready" | "rolled-back"; readonly stacks: readonly ClassifiedStack[] }
  | { readonly kind: "in-progress" | "failed"; readonly stacks: readonly ClassifiedStack[]; readonly deployable: boolean }
  | {
      readonly kind: "conflict";
      readonly reason: "unmarked" | "inconsistent" | "mixed" | "mode";
      readonly stacks: readonly ClassifiedStack[];
      readonly message: string;
    };

/** The deployment an identity output names, even when the rest of it does not parse. */
function namedDeployment(stack: ObservedStack): string | undefined {
  const raw = stack.Outputs?.find((output) => output.Description === DEPLOYMENT_OUTPUT_DESCRIPTION)?.OutputValue;
  try {
    const value: unknown = raw === undefined ? undefined : JSON.parse(raw);
    const deployment = (value as { deployment?: unknown } | undefined)?.deployment;
    return typeof deployment === "string" ? deployment : undefined;
  } catch {
    return undefined;
  }
}

export function deploymentCandidates(stacks: readonly ObservedStack[], deployment: string): ObservedStack[] {
  const pattern = new RegExp(`^${deployment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[A-Za-z0-9]+$`);
  return stacks.filter((stack) =>
    stack.StackStatus !== "DELETE_COMPLETE" &&
    (namedDeployment(stack) === deployment || pattern.test(stack.StackName ?? "")));
}

const names = (stacks: readonly { name: string }[]) => stacks.map((stack) => stack.name).join(", ");

export function classifyDeployment(
  stacks: readonly ObservedStack[],
  query: DeploymentQuery,
  templates: ReadonlyMap<string, unknown> = new Map(),
): DeploymentState {
  const where = `${query.account}/${query.region}`;
  const problems: string[] = [];
  const troubled = new Set<string>();
  const report = (name: string, problem: string) => { troubled.add(name); problems.push(problem); };
  const classified: ClassifiedStack[] = deploymentCandidates(stacks, query.deployment).map((stack) => {
    const name = stack.StackName ?? stack.StackId ?? "an unnamed stack";
    const status = stack.StackStatus ?? "UNKNOWN";
    let identity: DeploymentIdentity | undefined;
    let evidence: ClassifiedStack["evidence"] = "none";
    try {
      identity = identityFromOutputs(stack);
      if (identity) evidence = "output";
    } catch (error) {
      report(name, error instanceof Error ? error.message : `Invalid deployment metadata in ${name}.`);
      return { name, status, health: stackHealth(stack.StackStatus), evidence };
    }
    if (!identity) {
      identity = identityFromTemplate(templates.get(name));
      if (identity) evidence = "template";
    }
    if (identity) {
      const location = stackLocation(stack.StackId);
      if (identity.deployment !== query.deployment) {
        report(name, `${name} follows ${query.deployment}'s stack names but says it belongs to ${identity.deployment}.`);
      } else if (location && (location.account !== identity.account || location.region !== identity.region)) {
        report(name, `${name} says it belongs to ${identity.account}/${identity.region} but is deployed in ${location.account}/${location.region}.`);
      } else if (identity.account !== query.account || identity.region !== query.region) {
        report(name, `${name} belongs to ${identity.account}/${identity.region}, not ${where}.`);
      }
    }
    return { name, status, health: stackHealth(stack.StackStatus), identity, evidence };
  });

  if (!classified.length) return { kind: "absent" };

  const unmarked = classified.filter((stack) => stack.evidence === "none" && !troubled.has(stack.name));
  if (unmarked.length) {
    return {
      kind: "conflict", reason: "unmarked", stacks: classified,
      message: `${names(unmarked)} in ${where} ${unmarked.length === 1 ? "matches" : "match"} ${query.deployment}'s stack names but ${unmarked.length === 1 ? "carries" : "carry"} no framework deployment identity. ${unmarked.length === 1 ? "It is" : "They are"} not adopted automatically: inspect ${unmarked.length === 1 ? "it" : "them"} in CloudFormation, then delete ${unmarked.length === 1 ? "it" : "them"} or deploy under another name.`,
    };
  }
  if (problems.length) {
    return {
      kind: "conflict", reason: "inconsistent", stacks: classified,
      message: `${problems.join(" ")} Inspect ${query.deployment}'s stacks in CloudFormation before deploying; nothing was adopted.`,
    };
  }

  const identities = new Map(classified.map((stack) => [`${stack.identity!.mode}|${stack.identity!.account}|${stack.identity!.region}`, stack.identity!]));
  if (identities.size > 1) {
    return {
      kind: "conflict", reason: "mixed", stacks: classified,
      message: `${query.deployment}'s stacks in ${where} disagree about their deployment: ${classified.map((stack) => `${stack.name} (${stack.identity!.mode})`).join(", ")}. Inspect them in CloudFormation and remove the stale ones before deploying.`,
    };
  }
  const existing = [...identities.values()][0]!;
  if (existing.mode !== query.mode) {
    return {
      kind: "conflict", reason: "mode", stacks: classified,
      message: `${query.deployment} is a ${existing.mode} deployment in ${where} (${names(classified)}). Deploying ${query.mode} over it would change or remove those stacks. To keep it, deploy under another name (CDK_APP_NAME, or -c cdkAppName). To replace it, tear it down first from a ${existing.mode}-mode configuration, so the teardown selects its own stacks, and check the list of stacks before you confirm.`,
    };
  }

  if (classified.some((stack) => stack.health === "in-progress" || stack.health === "review")) {
    return { kind: "in-progress", stacks: classified, deployable: false };
  }
  const failed = classified.filter((stack) => stack.health === "failed" || stack.health === "failed-create" || stack.health === "paused");
  if (failed.length) return { kind: "failed", stacks: classified, deployable: failed.every((stack) => stack.health !== "failed") };
  if (classified.some((stack) => stack.health === "rolled-back")) return { kind: "rolled-back", stacks: classified };
  return { kind: "ready", stacks: classified };
}
