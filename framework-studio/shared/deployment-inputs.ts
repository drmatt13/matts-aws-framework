import type { Mode, SourceLocation } from "./model";
import type { ApplyResponse, DiffLine } from "./api";

/** Requirement resolution metadata only. Never contains an authored value. */
export interface InputRequirement {
  readonly resource: string;
  readonly name: string;
  readonly mode: Mode;
  readonly file: string;
  readonly required: boolean;
  readonly status: "configured" | "default" | "missing" | "optional" | "unknown";
  readonly reasons: readonly string[];
}

export interface DeploymentInputEntry {
  readonly name: string;
  readonly status: "configured" | "empty" | "missing";
  readonly sensitive: boolean;
  readonly defaulted: boolean;
  readonly targets: readonly string[];
  readonly source?: SourceLocation;
  readonly requirements?: readonly InputRequirement[];
}

/** Names, presence and source locations only. Values never enter the graph. */
export interface DeploymentInputFile {
  readonly mode: Mode;
  readonly path: string;
  readonly example: string;
  readonly exists: boolean;
  readonly synthesisSource: string;
  readonly entries: readonly DeploymentInputEntry[];
  readonly problem?: string;
}

/** Selected-file inspector data only. Never include this in a graph or query cache. */
export interface DeploymentInputDetails {
  readonly file: string;
  readonly hash: string;
  readonly entries: readonly { readonly name: string; readonly value: string; readonly sensitive: boolean }[];
}
export interface DeploymentInputEdit {
  readonly name: string;
  readonly value: string;
  readonly create?: true;
}
export interface DeploymentInputPlan {
  readonly planId: string;
  readonly ok: boolean;
  readonly summaries: readonly string[];
  readonly changes: readonly { readonly file: string; readonly diff: { readonly unified: string; readonly lines: readonly DiffLine[] } }[];
}
export type DeploymentInputApply = ApplyResponse;
