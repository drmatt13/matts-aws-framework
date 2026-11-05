import type { DeployMode, DeployOverview } from "../../shared/deploy";

/** Declaration mode chooses semantics; a named target chooses the destination. */
export function resolveDeploymentTarget(mode: DeployMode, overview: Pick<DeployOverview, "targets" | "preferences"> | undefined) {
  return overview?.targets.find(target => target.mode === mode && target.name === overview.preferences.deployment)
    ?? overview?.targets.find(target => target.mode === mode);
}

export interface DeploymentScope {
  readonly repository: string;
  readonly sourceRevision: string;
  readonly mode: DeployMode;
  readonly profile?: string;
  readonly generation: string;
  readonly deployment?: string;
  readonly account?: string;
  /** Undefined delegates region resolution to the host's AWS connection policy. */
  readonly region?: string;
}

export interface DeploymentDestination {
  readonly profile?: string | null;
  readonly deployment?: string | null;
  readonly account?: string;
  readonly region?: string;
}

/** Source edits do not move observed AWS resources; every actor/destination field still does. */
export function sameDeploymentObservation(left: DeploymentScope | undefined, right: DeploymentScope): boolean {
  return Boolean(left && left.repository === right.repository && left.mode === right.mode
    && left.profile === right.profile && left.generation === right.generation
    && left.deployment === right.deployment && left.account === right.account && left.region === right.region);
}

export function matchesDeployment(scope: DeploymentScope, destination: DeploymentDestination, observedAccount?: string, observedRegion?: string) {
  return (!destination.profile || scope.profile === destination.profile)
    && (!destination.deployment || !scope.deployment || scope.deployment === destination.deployment)
    && (!destination.account || !(observedAccount ?? scope.account) || (observedAccount ?? scope.account) === destination.account)
    && (!destination.region || !(observedRegion ?? scope.region) || (observedRegion ?? scope.region) === destination.region);
}
