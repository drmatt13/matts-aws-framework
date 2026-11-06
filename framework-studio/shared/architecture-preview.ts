import type { Mode } from "./model";

/** Advisory declaration comparison; never deployed-state or authorization evidence. */
export interface ArchitectureChange {
  readonly entity: "target" | "route" | "resource" | "relationship" | "workflow" | "network" | "database" | "defaults" | "tags";
  readonly id: string;
  readonly kind: "add" | "remove" | "modify";
  readonly fields: readonly string[];
  readonly implications: readonly string[];
}
export interface ArchitectureModePreview {
  readonly mode: Mode;
  readonly status: "ready" | "partial" | "unavailable";
  readonly changes: readonly ArchitectureChange[];
  readonly diagnostics: readonly string[];
}
export interface ArchitecturePreview {
  readonly version: 1;
  readonly proposalDigest: string;
  readonly baselineDigest: string;
  readonly candidateDigest: string;
  readonly toolchainDigest?: string;
  readonly dependencyDigest?: string;
  readonly status: "ready" | "partial" | "unavailable";
  readonly modes: readonly ArchitectureModePreview[];
  readonly limitations: readonly string[];
  readonly reason?: string;
}
