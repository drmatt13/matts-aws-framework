import type { Mode, Snapshot } from "../../shared/model";
import type { JobView } from "../../shared/operations";
import type {
  WorkspaceFragments,
  WorkspaceKind,
  SightlineWorkspace,
} from "./workspace";

export type SightlineValue =
  | string
  | number
  | boolean
  | null
  | readonly SightlineValue[]
  | SightlineRecord;
export interface SightlineRecord {
  readonly [key: string]: SightlineValue | undefined;
}
export interface SightlineOmission {
  readonly path: string;
  readonly reason: "privacy" | "relevance" | "budget";
  readonly count?: number;
}
export type SightlineAvailability =
  "not-loaded" | "loading" | "error" | "available" | "not-applicable";

/** A narrow browser adapter input, never an entire query or AWS response. */
export interface SightlineDeploymentInput {
  readonly availability:
    | "missing-profile"
    | "catalog-error"
    | "loading-profiles"
    | "unavailable-profile"
    | "available";
  readonly target?: {
    readonly name: string;
    readonly mode: Mode;
    readonly region?: string;
  };
  readonly observed: {
    readonly availability: SightlineAvailability;
    readonly observedAt?: string;
    readonly updatedAt?: string;
    readonly freshUntil?: string;
    readonly stale?: boolean;
    readonly state?: string;
    readonly stackCount?: number;
    readonly problemKind?: string;
  };
}

export interface SightlineInputs {
  readonly capturedAt: string;
  readonly pathname: string;
  readonly snapshot: Snapshot;
  readonly mode: Mode;
  readonly selected?: string;
  readonly source: {
    readonly latestRevision: string;
    readonly evaluating: boolean;
    readonly dirty: boolean;
    readonly conflicted: boolean;
    readonly connected: boolean;
  };
  readonly aliases: Readonly<Record<string, string>>;
  readonly workspace: WorkspaceFragments;
  readonly deployments: Readonly<Record<Mode, SightlineDeploymentInput>>;
  readonly activity: {
    readonly jobs?: readonly JobView[];
    readonly availability: Exclude<SightlineAvailability, "not-applicable">;
    readonly updatedAt?: string;
  };
}

export interface SightlineFocus extends SightlineRecord {
  readonly status:
    "found" | "not-found" | "other-mode-only" | "stale-model" | "renamed";
  readonly kind:
    | "gateway"
    | "target"
    | "route"
    | "resource"
    | "local-service"
    | "island"
    | "defaults"
    | "network"
    | "connection"
    | "schema"
    | "unknown";
  readonly id: string;
  readonly name: string;
  readonly stale: boolean;
  readonly renamedFrom: readonly string[];
  readonly declared?: SightlineRecord;
}

/** Versioned, read-only projection. It is not delivered to the agent. */
export interface Sightline {
  readonly schemaVersion: 1;
  readonly capturedAt: string;
  readonly location: {
    readonly pathname: string;
    readonly workspace: WorkspaceKind;
    readonly subsection: string | null;
  };
  readonly source: {
    readonly mode: Mode;
    readonly revision: string;
    readonly latestRevision: string;
    readonly modelStatus: "ok" | "error";
    readonly stale: boolean;
    readonly evaluating: boolean;
    readonly connected: boolean;
    readonly draft: { readonly dirty: boolean; readonly conflicted: boolean };
  };
  readonly focus: SightlineFocus | null;
  readonly workspace: SightlineWorkspace;
  readonly deployments: Readonly<Record<Mode, SightlineRecord>>;
  readonly activity: SightlineRecord;
  readonly issues: readonly SightlineRecord[];
  readonly omitted: readonly SightlineOmission[];
}
