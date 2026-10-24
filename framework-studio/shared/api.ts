import type { Diagnostic, FieldFact, Lanes, Mode, Placement, Snapshot } from "./model";

/**
 * The studio's HTTP contract: what the browser sends, what the server answers.
 * Types only, shared by both halves so neither re-declares the other's shapes.
 */

export type LiteralValue = string | number | boolean;

export interface EditIntent {
  readonly target: string;
  readonly field: string;
  /** The new value; omitted with `inherit`. */
  readonly value?: LiteralValue;
  /** Remove the property, so the cascade decides. */
  readonly inherit?: true;
}

export type DeployValue = import("./model").DeploySetting | "inherit" | { readonly when: { readonly resource: string; readonly equals: string } };

export type DraftEdit =
  | { readonly kind: "deploy"; readonly target: string; readonly value: DeployValue }
  | import("./identity-policy").IdentityPolicyEdit
  | { readonly kind: "implementation"; readonly target: string }
  | { readonly kind: "connection"; readonly target: string; readonly connection: "database" | "userPool" | "runsTask" | "startsWorkflow" | "invokesAgent" | "tool" | "resource" | "grant"; readonly destination?: string; readonly enabled: boolean; readonly variable?: string; readonly grant?: "grantRead" | "grantWrite" | "grantReadWrite" | "grantSendMessages" | "grantConsumeMessages"; readonly scope?: string }
  | { readonly kind: "removeWorkload"; readonly target: string }
  | { readonly kind: "tags"; readonly entity: string; readonly tags: Readonly<Record<string, string>> }
  | import("./managed-database").DatabasePlacementEdit
  | { readonly kind: "removeNetwork"; readonly network: string }
  | { readonly kind: "database"; readonly database: string; readonly settings: import("@repo/framework/config/database").DatabaseSettingsInput }
  | ({ readonly kind: "placement" } & import("./networks").PlacementEdit)
  | { readonly kind: "network"; readonly network: string; readonly settings: import("./networks").NetworkSettings }
  | { readonly kind: "create"; readonly request: import("./creation").CreationRequest }
  | { readonly kind: "clientEnvironment"; readonly mappings: import("./client-environment").ClientEnvironmentMappings }
  | { readonly kind: "triggers"; readonly event: string; readonly bindings: readonly import("./triggers").TriggerBinding[] }
  /** Delete one recognized native trigger (a source edge id) from its CDK stack file. */
  | { readonly kind: "nativeTrigger"; readonly edge: string }
  /** Set an event's onFailure destination, or remove it with null. */
  | { readonly kind: "onFailure"; readonly event: string; readonly value: import("./triggers").FailureDestinationSettings | null }
  | { readonly kind: "description"; readonly entity: string; readonly value: string }
  | { readonly kind: "field"; readonly intent: EditIntent }
  | { readonly kind: "route"; readonly route: string; readonly value: string };

export interface BatchPlanResponse {
  readonly planId: string;
  readonly summaries: readonly string[];
  readonly changes: readonly { readonly file: string; readonly diff: PlanResponse["diff"]; readonly operation?: "create" | "modify" | "delete" }[];
  readonly preflight: { readonly dev: PreflightResult; readonly prod: PreflightResult };
  readonly ok: boolean;
  readonly impact: readonly string[];
  /** Canonical identity to focus only after a confirmed creation. */
  readonly select?: string;
}

export interface DiffLine {
  /** First line of a separate unified-diff hunk. */
  readonly hunk?: string;
  readonly kind: "context" | "remove" | "add";
  readonly text: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}

export interface PreflightResult {
  readonly mode: Mode;
  readonly ok: boolean;
  /** The framework's own messages, verbatim. */
  readonly diagnostics: readonly Diagnostic[];
  /** The field as the framework would resolve it after the change. */
  readonly predicted?: FieldFact;
  /** Where the target would run, and be placed, after the change. */
  readonly lanes?: Lanes;
  readonly placement?: Placement;
}

export interface PlanResponse {
  /** Legacy single-edit callers must review these additional generated/source files when present. */
  readonly changes?: BatchPlanResponse["changes"];
  readonly planId: string;
  readonly target: string;
  readonly field: string;
  readonly summary: string;
  readonly file: string;
  readonly diff: { readonly unified: string; readonly lines: readonly DiffLine[] };
  readonly preflight: { readonly dev: PreflightResult; readonly prod: PreflightResult };
  /** Whether both graphs accept the change; a plan that is not ok cannot be applied. */
  readonly ok: boolean;
  /** What else happens when this is written, beyond the field. */
  readonly impact: readonly string[];
  readonly lanesBefore?: Lanes;
  readonly placementBefore?: Placement;
}

export interface ApplyResponse {
  /** `unconfirmed`: written, not as predicted, and changed by someone else since, so left alone. */
  readonly status: "applied" | "reverted" | "unconfirmed";
  readonly message: string;
  readonly revision: string;
  readonly select?: string;
}

export interface HistoryState {
  readonly undo?: string;
  readonly redo?: string;
}

export interface CommandInfo {
  readonly label: string;
  readonly description: string;
  readonly writes: boolean;
}

export interface CommandResult {
  readonly command: string;
  readonly exitCode: number | null;
  readonly output: string;
  readonly durationMs: number;
}

export interface SnapshotResponse {
  readonly sourceRecovery?: readonly import("./source-recovery").SourceRecovery[];
  readonly sourceRecoveryProblem?: string;
  readonly sourceWatch?: import("./watch").SourceWatchState;
  readonly snapshot: Snapshot;
  readonly history: HistoryState;
  readonly evaluating: boolean;
  readonly commands: Readonly<Record<string, CommandInfo>>;
  readonly busy: string | null;
}

/** Server-sent events on /api/events. */
export interface SnapshotEvent {
  readonly revision: string;
  /** Files changed by something other than the studio. */
  readonly external: readonly string[];
  readonly history: HistoryState;
}
