import type { InfrastructureInventory } from "../../scripts/infrastructure-types";
export type { InfrastructureInventory, InfrastructureResource } from "../../scripts/infrastructure-types";
import type { Mode } from "./model";

export interface InfrastructureState {
  mode: Mode;
  status: "empty" | "running" | "ready" | "failed";
  stale: boolean;
  generatedAt?: string;
  sourceRevision?: string;
  startedAt?: string;
  inputs?: { file: string; modeSelection: string; profile: string };
  error?: string;
  inventory?: InfrastructureInventory;
}
