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
  readonly consumers?: readonly string[];
}

/**
 * One variable as a file shows it. A file lists its own lines, the other file's lines, and every
 * catalog input its graph holds, so the two files list the same names except where the catalog
 * declares an input `.only()` the other graph.
 */
export interface DeploymentInputEntry {
  readonly name: string;
  /** This file's line: a value, a blank value, or no line at all. */
  readonly status: "configured" | "empty" | "missing";
  /** The other file's line, so an absent row can say where the name came from. */
  readonly counterpart: "configured" | "empty" | "missing";
  readonly sensitive: boolean;
  /** No value here, and the declared default for this graph stands in. */
  readonly defaulted: boolean;
  /** Catalog inputs read from this name. Empty for a variable the catalog does not declare. */
  readonly targets: readonly string[];
  /** The declared default in this file's graph. A declaration, never an authored value. */
  readonly default?: string;
  /** Declared choices, for a choice list rather than free text. */
  readonly choices?: readonly string[];
  /**
   * Who reads a variable the catalog does not declare: the application's deployment settings
   * (cdk-app/deployment-inputs.ts) or the production database's overrides. Absent for one nothing
   * recognizes.
   */
  readonly owner?: "deployment" | "database";
  /** One line from the declaring owner, for a variable the catalog does not declare. */
  readonly note?: string;
  /** Written here, but this file's graph never reads it: an input declared `.only()` the other graph, or a database override in development. */
  readonly notRead?: true;
  readonly source?: SourceLocation;
  readonly requirements?: readonly InputRequirement[];
}

/** Names, presence and source locations only. Values never enter the graph. */
export interface DeploymentInputFile {
  readonly mode: Mode;
  readonly path: string;
  /** The tracked reference the file is generated from. */
  readonly template: string;
  readonly exists: boolean;
  readonly entries: readonly DeploymentInputEntry[];
  readonly problem?: string;
}

/**
 * Selected-file inspector data only. Never include this in a graph or query cache.
 *
 * A sensitive line's value is withheld: `hidden` says the line has one, and the inspector asks for
 * that one value only when someone chooses to reveal it.
 */
export interface DeploymentInputDetails {
  readonly file: string;
  readonly hash: string;
  readonly entries: readonly { readonly name: string; readonly value: string; readonly sensitive: boolean; readonly hidden?: true }[];
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
