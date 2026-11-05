import type { DiscoveredDeploymentView, TargetView } from "../../../shared/deploy";

export interface RailRow {
  readonly name: string;
  readonly mode: "dev" | "prod";
  readonly section: "repository" | "discovered";
  readonly target?: Omit<TargetView, "status" | "detail">;
  readonly match?: TargetView;
  readonly deployment?: DiscoveredDeploymentView;
}
