import {
  classifyDeployment,
  deploymentCandidates,
  identityFromOutputs,
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

/** Deploy flags that bypass CloudFormation's safety or unreviewed approval, as they were written. */
export function unsafeProductionFlags(args: readonly string[]): string[] {
  const found: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "-R" || arg === "-y") { found.push(arg); continue; }
    if (arg === "-c" || arg === "--context") { index++; continue; }
    if (!arg.startsWith("--")) continue;
    const [key, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (key === "no-rollback") { found.push(arg); continue; }
    if (key === "require-approval") {
      const value = inline ?? args[++index];
      if (value === "never") found.push(inline === undefined ? `${arg} ${value}` : arg);
      continue;
    }
    if (!ENABLING.has(key) && key !== "rollback") continue;
    let value = inline;
    let written = arg;
    const next = args[index + 1];
    if (value === undefined && (next === "true" || next === "false")) { value = next; written = `${arg} ${next}`; index++; }
    const enabled = value !== "false";
    if (key === "rollback" ? !enabled : enabled) found.push(written);
  }
  return found;
}

const listed = (stacks: readonly { name: string; status: string }[]) => stacks.map((stack) => `${stack.name} (${stack.status})`).join(", ");

export function assertDeploymentAllowed(identity: DeploymentIdentity, args: readonly string[], readers: GuardReaders): DeploymentState {
  if (identity.mode === "prod") {
    const flags = unsafeProductionFlags(args);
    if (flags.length) {
      throw new Error(`Production deployments refuse ${flags.join(", ")}. Hotswap, express and no-rollback deployments skip CloudFormation's safety, and --yes or --require-approval never approve security changes nobody reviewed. Remove ${flags.length === 1 ? "it" : "them"} and deploy again.`);
    }
  }
  let stacks: ObservedStack[];
  try {
    stacks = readers.readStacks();
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
      throw new Error(`${identity.deployment} needs recovery before it can be deployed: ${listed(state.stacks.filter((stack) => stack.health === "failed"))}. Resolve it in CloudFormation (continue an UPDATE_ROLLBACK_FAILED rollback, or retry a DELETE_FAILED delete), then deploy again. Nothing was changed.`);
    case "in-progress":
      throw new Error(`${identity.deployment} has a CloudFormation operation in progress: ${listed(state.stacks.filter((stack) => stack.health === "in-progress" || stack.health === "review"))}. Wait for it to finish, or resolve the pending change set, then deploy again. Nothing was changed.`);
    case "conflict":
      throw new Error(`${state.message} Nothing was changed.`);
  }
}
