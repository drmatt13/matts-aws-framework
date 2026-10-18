import { classifyDeployment, namedDeployment, type ClassifiedStack, type DeploymentState } from "./classify";
import { stackEvidence, type DeploymentMode, type ObservedStack } from "./identity";
import type { DeploymentTarget } from "./targets";

/**
 * Which framework deployments an account and region hold, from what each stack
 * says about itself — never from the selected profile, and never from a name
 * alone. Stacks that only look like a known deployment's (its name followed by
 * a suffix) are attached to it when it exists, where classification refuses
 * them, or listed as unrecognized. Nothing here adopts anything.
 *
 * Pure: the caller lists the stacks (describe-stacks) and fetches templates for
 * the lookalikes it wants identified.
 */

export interface DiscoveryContext {
  readonly account: string;
  readonly region: string;
}

export interface DiscoveredDeployment {
  readonly name: string;
  readonly mode: DeploymentMode;
  readonly account: string;
  readonly region: string;
  /** The identity contracts its stacks carry; [1] means the next deploy upgrades it. */
  readonly contracts: readonly (1 | 2)[];
  readonly state: DeploymentState;
  readonly stacks: readonly ClassifiedStack[];
  readonly lastUpdated?: string;
}

export interface UnrecognizedStack {
  readonly name: string;
  readonly status: string;
  readonly reason: string;
}

export interface Discovery {
  readonly deployments: readonly DiscoveredDeployment[];
  readonly unrecognized: readonly UnrecognizedStack[];
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const looksLike = (stackName: string, deployment: string) => new RegExp(`^${escape(deployment)}-[A-Za-z0-9]+$`).test(stackName);

/** Stacks with no record of their own whose names follow a known deployment's pattern: candidates for a template lookup. */
export function lookalikeStacks(stacks: readonly ObservedStack[], knownNames: readonly string[]): ObservedStack[] {
  return stacks.filter((stack) => {
    if (stack.StackStatus === "DELETE_COMPLETE" || !stack.StackName) return false;
    if (stackEvidence(stack).evidence !== "none" || namedDeployment(stack)) return false;
    return knownNames.some((name) => looksLike(stack.StackName!, name));
  });
}

export function discoverDeployments(
  stacks: readonly ObservedStack[],
  context: DiscoveryContext,
  templates: ReadonlyMap<string, unknown> = new Map(),
  knownNames: readonly string[] = [],
): Discovery {
  const live = stacks.filter((stack) => stack.StackStatus !== "DELETE_COMPLETE" && stack.StackName);
  const groups = new Map<string, ObservedStack[]>();
  const add = (name: string, stack: ObservedStack) => groups.set(name, [...(groups.get(name) ?? []), stack]);
  const unattached: ObservedStack[] = [];
  for (const stack of live) {
    const found = stackEvidence(stack, templates.get(stack.StackName!));
    const named = found.identity?.deployment ?? namedDeployment(stack);
    if (named) add(named, stack);
    else unattached.push(stack);
  }
  const unrecognized: UnrecognizedStack[] = [];
  for (const stack of unattached) {
    const owner = [...groups.keys(), ...knownNames].sort((a, b) => b.length - a.length).find((name) => looksLike(stack.StackName!, name));
    if (!owner) continue;
    if (groups.has(owner)) add(owner, stack);
    else unrecognized.push({ name: stack.StackName!, status: stack.StackStatus ?? "UNKNOWN", reason: `Named like ${owner}'s stacks, but carries no framework deployment identity. Not adopted.` });
  }

  const deployments: DiscoveredDeployment[] = [];
  for (const [name, members] of groups) {
    const identities = members.map((stack) => stackEvidence(stack, templates.get(stack.StackName!)).identity).filter((identity) => identity !== undefined);
    if (!identities.length) {
      for (const stack of members) unrecognized.push({ name: stack.StackName!, status: stack.StackStatus ?? "UNKNOWN", reason: `Claims to belong to ${name}, but its deployment records do not agree. Not adopted.` });
      continue;
    }
    const counts = new Map<string, number>();
    for (const identity of identities) counts.set(identity.mode, (counts.get(identity.mode) ?? 0) + 1);
    const mode = [...counts].sort((a, b) => b[1] - a[1])[0]![0] as DeploymentMode;
    const state = classifyDeployment(members, { deployment: name, mode, ...context }, templates);
    const stacksOf = "stacks" in state ? state.stacks : [];
    const times = members.map((stack) => stack.LastUpdatedTime ?? stack.CreationTime).filter((time): time is string => !!time).sort();
    deployments.push({
      name, mode, ...context,
      contracts: [...new Set(identities.map((identity) => identity.contract ?? 1))].sort(),
      state, stacks: stacksOf,
      ...(times.length ? { lastUpdated: times[times.length - 1] } : {}),
    });
  }
  deployments.sort((a, b) => a.name.localeCompare(b.name));
  unrecognized.sort((a, b) => a.name.localeCompare(b.name));
  return { deployments, unrecognized };
}

export interface MatchedTarget extends DeploymentTarget {
  /** deployed: here, in its mode. absent: nothing here. conflict: here, in another mode. elsewhere: pinned to another account or region. */
  readonly status: "deployed" | "absent" | "conflict" | "elsewhere";
  readonly detail?: string;
}

export function matchTargets(targets: readonly DeploymentTarget[], discovery: Discovery, context: DiscoveryContext): MatchedTarget[] {
  return targets.map((target) => {
    if ((target.account && target.account !== context.account) || (target.region && target.region !== context.region)) {
      return { ...target, status: "elsewhere", detail: `Pinned to ${target.account ?? context.account}/${target.region ?? context.region}; the selected profile is ${context.account}/${context.region}.` };
    }
    const deployed = discovery.deployments.find((deployment) => deployment.name === target.name);
    if (!deployed) return { ...target, status: "absent" };
    if (deployed.mode !== target.mode) {
      return { ...target, status: "conflict", detail: `${target.name} is deployed as ${deployed.mode} here, but the repository declares it ${target.mode}.` };
    }
    return { ...target, status: "deployed" };
  });
}
