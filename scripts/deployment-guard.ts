import {
  classifyDeployment,
  deploymentCandidates,
  identityFromOutputs,
  type ClassifiedStack,
  type DeploymentIdentity,
  type DeploymentState,
  type ObservedStack,
} from "@repo/framework/deploy";

/**
 * Refuses a deployment that would change stacks it does not own.
 *
 * Runs after the account check and before any secret is written. What AWS
 * already holds under this deployment's name is the authority: a dev synth may
 * not update a prod deployment's stacks (or the reverse), a stack without an
 * identity is never adopted, and a deployment CloudFormation is still changing
 * is left alone. Reading AWS is the only side effect; a read that fails refuses.
 */

export interface GuardReaders {
  readStacks(): ObservedStack[];
  /** The deployed template, parsed or as text. Called only for stacks without an identity output. */
  readTemplate(stackName: string): unknown;
}

const ENABLING = new Set(["hotswap", "hotswap-fallback", "express", "yes"]);

/**
 * Deploy flags that bypass CloudFormation's safety or unreviewed approval, as they were written.
 * The CDK CLI's parser also accepts camelCase names and grouped short flags (`-Ry`).
 */
export function unsafeProductionFlags(args: readonly string[]): string[] {
  const found: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "-c" || arg === "--context") { index++; continue; }
    if (/^-[A-Za-z]+$/.test(arg)) {
      if (/[Ry]/.test(arg)) found.push(arg);
      continue;
    }
    if (!arg.startsWith("--")) continue;
    const [written, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    const key = written.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    if (key === "no-rollback") { found.push(arg); continue; }
    if (key === "require-approval") {
      const value = inline ?? args[++index];
      if (value === "never") found.push(inline === undefined ? `${arg} ${value}` : arg);
      continue;
    }
    if (!ENABLING.has(key) && key !== "rollback") continue;
    let value = inline;
    let shown = arg;
    const next = args[index + 1];
    if (value === undefined && (next === "true" || next === "false")) { value = next; shown = `${arg} ${next}`; index++; }
    const enabled = value !== "false";
    if (key === "rollback" ? !enabled : enabled) found.push(shown);
  }
  return found;
}

/**
 * The deploy arguments for this mode. Production always asks for approval of
 * broadening changes: the flag outranks a `requireApproval` in cdk.json or
 * ~/.cdk.json, which the argument check above cannot see.
 */
export function productionDeployArguments(identity: DeploymentIdentity, forwarded: readonly string[]): string[] {
  return identity.mode === "prod" ? [...forwarded, "--require-approval", "broadening"] : [...forwarded];
}

/** What a person can do about a stack in this status: the CDK CLI handles the rest itself. */
function remedy(stack: ClassifiedStack): string {
  switch (stack.status) {
    case "REVIEW_IN_PROGRESS":
      return "holds no resources: a change set was created for it and never executed. Execute that change set, or delete the stack in CloudFormation, which removes nothing";
    case "UPDATE_ROLLBACK_FAILED":
      return `continue its rollback with npm --workspace cdk-app exec -- cdk rollback ${stack.name}, or Continue update rollback in the CloudFormation console`;
    case "DELETE_FAILED":
      return "retry the delete in CloudFormation, retaining or first removing the resources it reports";
    default:
      return stack.health === "in-progress" ? "wait for it to finish" : "inspect it in CloudFormation";
  }
}
const listed = (stacks: readonly ClassifiedStack[]) => stacks.map((stack) => `${stack.name} (${stack.status}): ${remedy(stack)}`).join("; ");

export function assertDeploymentAllowed(
  identity: DeploymentIdentity, args: readonly string[], readers: GuardReaders,
  /** Stacks a reviewed plan created to hold its change sets: expected to be awaiting review, and nothing else. */
  plannedReviews: ReadonlySet<string> = new Set(),
): DeploymentState {
  if (identity.mode === "prod") {
    const flags = unsafeProductionFlags(args);
    if (flags.length) {
      throw new Error(`Production deployments refuse ${flags.join(", ")}. Hotswap, express and no-rollback deployments skip CloudFormation's safety, and --yes or --require-approval never approve security changes nobody reviewed. Remove ${flags.length === 1 ? "it" : "them"} and deploy again.`);
    }
  }
  let stacks: ObservedStack[];
  try {
    stacks = readers.readStacks().filter((stack) => !(stack.StackStatus === "REVIEW_IN_PROGRESS" && plannedReviews.has(stack.StackName ?? "")));
  } catch {
    throw new Error(`Unable to read deployed stacks to verify ${identity.deployment} in ${identity.account}/${identity.region}. Check the selected credentials and cloudformation:DescribeStacks access. Nothing was changed.`);
  }
  const templates = new Map<string, unknown>();
  for (const stack of deploymentCandidates(stacks, identity.deployment)) {
    let identified: boolean;
    try { identified = identityFromOutputs(stack) !== undefined; } catch { identified = true; }
    if (identified || !stack.StackName) continue;
    try { templates.set(stack.StackName, readers.readTemplate(stack.StackName)); } catch { /* No identity: refused below. */ }
  }
  const state = classifyDeployment(stacks, identity, templates);
  switch (state.kind) {
    case "absent":
    case "ready":
    case "rolled-back":
      return state;
    case "failed":
      if (state.deployable) return state;
      throw new Error(`${identity.deployment} needs recovery before it can be deployed: ${listed(state.stacks.filter((stack) => stack.health === "failed"))}. Then deploy again. Nothing was changed.`);
    case "in-progress":
      throw new Error(`${identity.deployment} has a CloudFormation operation in progress or pending: ${listed(state.stacks.filter((stack) => stack.health === "in-progress" || stack.health === "review"))}. Then deploy again. Nothing was changed.`);
    case "conflict":
      throw new Error(`${state.message} Nothing was changed.`);
  }
}
