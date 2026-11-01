import type { Mode, SourceLocation } from "./model";
import type { ApplyResponse, DiffLine } from "./api";

/** One Studio environment editor, backed by two independently authored files. */
export const CDK_ENVIRONMENT_ID = "envfile:cdk";

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
   * (cdk-app/deployment-inputs.ts), the production database's overrides, or the local development
   * tooling (cdk-app/local-inputs.ts). Absent for one nothing recognizes.
   */
  readonly owner?: FrameworkSettingOwner;
  /** One line from the declaring owner, for a variable the catalog does not declare. */
  readonly note?: string;
  /** Written here, but this file's graph never reads it: an input declared `.only()` the other graph, a database override in development, or a local tooling setting in production. */
  readonly notRead?: true;
  readonly source?: SourceLocation;
  readonly requirements?: readonly InputRequirement[];
}

/** What reads a framework setting, and so which framework-managed input group holds it. */
export type FrameworkSettingOwner = "deployment" | "database" | "local" | "authentication";

/**
 * The framework-managed input groups: the variables the framework itself reads from the CDK
 * inputs files, by reader. Projected beside the catalog's groups, never declared in it, except
 * the sign-in providers: their client secrets are catalog secrets, so the framework declares that
 * group in the catalog under a key of its own.
 */
export const FRAMEWORK_INPUT_GROUPS: Readonly<Record<FrameworkSettingOwner, {
  readonly id: string;
  readonly title: string;
  /** What reads them, for "Read by …" copy. */
  readonly reader: string;
  /** The environments whose inputs file supplies them. */
  readonly modes: readonly Mode[];
  /** How the reader combines them, where a rule beyond "required lines are required" applies. */
  readonly rule?: string;
}>> = {
  deployment: { id: "framework:deployment", title: "Deployment settings", reader: "cdk-app/deployment-inputs.ts at synthesis", modes: ["dev", "prod"] },
  database: { id: "framework:database", title: "Production database", reader: "the production database declaration at synthesis", modes: ["prod"] },
  local: { id: "framework:local", title: "Local development", reader: "Docker Compose and the local tooling", modes: ["dev"] },
  authentication: { id: "resource:signInProviders", title: "Sign-in providers", reader: "the Cognito stack at synthesis", modes: ["dev", "prod"],
    rule: "Each provider is included where its file sets all of its lines and left out where it sets none; once one is set, the rest are required there. Client secrets reach Secrets Manager through npm run deploy:resources." },
};

/** Names, presence and source locations only. Values never enter the graph. */
export interface DeploymentInputFile {
  readonly mode: Mode;
  readonly path: string;
  /** The tracked reference the file is generated from. */
  readonly template: string;
  readonly exists: boolean;
  readonly entries: readonly DeploymentInputEntry[];
  readonly problem?: string;
  /** Interactive Studio could not initialize this file; contains no authored values. */
  readonly setupProblem?: string;
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
/** One file's staged edits, against the content hash its details were read at. A review holds one or both files. */
export interface DeploymentInputFileEdits {
  readonly mode: Mode;
  readonly hash: string;
  readonly edits: readonly DeploymentInputEdit[];
}
export interface DeploymentInputPlan {
  readonly planId: string;
  readonly ok: boolean;
  readonly summaries: readonly string[];
  readonly changes: readonly { readonly file: string; readonly diff: { readonly unified: string; readonly lines: readonly DiffLine[] } }[];
}
export type DeploymentInputApply = ApplyResponse;
