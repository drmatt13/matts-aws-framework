import type { AwsProblem, StatusView } from "../../shared/deploy";
import type { DeploymentScope } from "./context";

export type DeploymentPresenceState = "deployed" | "absent" | "pending" | "unknown" | "attention";

/** Deployment existence, not application health or source validity. */
export function deploymentPresence(input: {
  readonly scope: DeploymentScope;
  readonly target?: { readonly name: string; readonly mode: "dev" | "prod"; readonly account?: string; readonly region?: string };
  readonly availability: string;
  readonly status?: StatusView;
  readonly problem?: AwsProblem;
  readonly retained: boolean;
  readonly fetching: boolean;
}): { readonly state: DeploymentPresenceState; readonly description: string } {
  const { scope, target, status } = input;
  const prefix = `${scope.mode === "dev" ? "Development" : "Production"} deployment: `;
  const result = (state: DeploymentPresenceState, description: string) => ({ state, description: prefix + description });
  if (!scope.profile) return result("unknown", "choose an AWS profile.");
  if (input.availability === "unavailable-profile") return result("unknown", "the associated AWS profile is unavailable.");
  if (input.problem) return result("attention", `status unavailable. ${input.problem.message}`);
  if (!target) return result("unknown", "no destination is declared.");
  if (!status) return result(input.availability === "available" ? "pending" : "unknown", "checking AWS.");
  if (status.deployment !== target.name || status.context.profile !== scope.profile
    || target.account && status.context.account !== target.account
    || target.region && status.context.region !== target.region) return result("attention", "the selected AWS destination is not confirmed.");
  const detail = status.detail;
  const observed = input.retained ? "Last observed " : "";
  const refreshing = input.retained || input.fetching ? " Refreshing AWS evidence." : "";
  const destination = `${target.name} in ${status.context.account} · ${status.context.region}`;
  if (detail?.state.kind === "absent" || !detail && status.targets.some(entry => entry.name === target.name && entry.mode === scope.mode && entry.status === "absent"))
    return result("absent", `${observed}${destination} is not deployed.${refreshing}`);
  if (detail?.state.kind === "ready" && detail.name === target.name && detail.mode === scope.mode
    && detail.account === status.context.account && detail.region === status.context.region && detail.stacks.length > 0
    && detail.stacks.every(stack => stack.health === "complete" && stack.evidence !== "none"
      && stack.identity?.deployment === target.name && stack.identity.mode === scope.mode))
    return result("deployed", `${observed}${destination} is deployed.${refreshing}`);
  return result("attention", detail ? `${destination}: ${detail.state.kind.replaceAll("-", " ")}.${refreshing}` : "deployment status is not confirmed.");
}
