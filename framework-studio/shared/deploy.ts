/**
 * Deploy & Run, as the server and the page share it.
 *
 * Three independent states: the repository (targets, the model), AWS (what
 * discovery finds, read-only), and this machine (Docker, the local stack, the
 * processes Studio manages). Operations change one of them, as jobs.
 */

export type DeployMode = "dev" | "prod";

export interface AwsProfileInfo {
  readonly name: string;
  readonly region?: string;
  readonly kind: "sso" | "login" | "process" | "assume-role" | "static" | "unknown";
}

export interface AccountContext {
  readonly profile: string;
  readonly account: string;
  readonly region: string;
  readonly arn: string;
}

export type StackHealth = "complete" | "rolled-back" | "in-progress" | "review" | "failed-create" | "paused" | "failed";

export interface StackView {
  readonly name: string;
  readonly status: string;
  readonly health: StackHealth;
  readonly evidence: "tags" | "output" | "template" | "none";
  readonly identity?: { readonly deployment: string; readonly mode: DeployMode; readonly contract?: 1 | 2; readonly stack?: string };
}

export type DeploymentStateView =
  | { readonly kind: "absent" }
  | { readonly kind: "ready" | "rolled-back"; readonly stacks: readonly StackView[] }
  | { readonly kind: "in-progress" | "failed"; readonly stacks: readonly StackView[]; readonly deployable: boolean }
  | { readonly kind: "conflict"; readonly reason: "unmarked" | "inconsistent" | "mixed" | "mode"; readonly stacks: readonly StackView[]; readonly message: string };

export interface DiscoveredDeploymentView {
  readonly name: string;
  readonly mode: DeployMode;
  readonly account: string;
  readonly region: string;
  readonly contracts: readonly (1 | 2)[];
  readonly state: DeploymentStateView;
  readonly stacks: readonly StackView[];
  readonly lastUpdated?: string;
}

export interface TargetView {
  readonly name: string;
  readonly mode: DeployMode;
  readonly account?: string;
  readonly region?: string;
  readonly inputs?: string;
  readonly origin: "declared" | "personal" | "named";
  readonly status: "deployed" | "absent" | "conflict" | "elsewhere";
  readonly detail?: string;
}

export interface DeploymentRecordView {
  readonly deployedAt?: string;
  readonly deployedBy?: string;
  readonly via?: "cli" | "studio";
  readonly planId?: string;
  readonly revision?: { readonly commit?: string; readonly dirty?: boolean };
}

export interface DiscoveryView {
  readonly context: AccountContext;
  readonly deployments: readonly DiscoveredDeploymentView[];
  readonly unrecognized: readonly { readonly name: string; readonly status: string; readonly reason: string }[];
  readonly targets: readonly TargetView[];
  readonly records: Readonly<Record<string, DeploymentRecordView>>;
  readonly unreadable: readonly string[];
  readonly observedAt: string;
}

export interface StackEventView {
  readonly stack: string;
  readonly id: string;
  readonly time: string;
  readonly logicalId: string;
  readonly type: string;
  readonly status: string;
  readonly reason?: string;
}

export interface LocalCompatibilityView {
  readonly compatible: boolean;
  readonly problem?: string;
  readonly exported: { readonly deployment?: string; readonly manifest?: string; readonly client: boolean; readonly fresh: boolean };
}

export interface StatusView extends DiscoveryView {
  readonly deployment: string;
  readonly detail?: DiscoveredDeploymentView & {
    readonly events: readonly StackEventView[];
    readonly changeSets: readonly { readonly stack: string; readonly name: string; readonly status: string; readonly executionStatus?: string; readonly ours: boolean }[];
    readonly local?: LocalCompatibilityView;
  };
}

/** An AWS read that could not be made: credentials, permissions, the CLI. */
export interface AwsProblem {
  readonly kind: "missing-cli" | "no-credentials" | "expired" | "profile" | "denied" | "not-found" | "throttled" | "failed";
  readonly message: string;
}

export type CheckStatus = "ok" | "warn" | "fail" | "unknown";

export interface PrerequisiteView {
  readonly id: "node" | "npm" | "aws-cli" | "dependencies" | "docker" | "compose";
  readonly label: string;
  readonly status: CheckStatus;
  readonly summary: string;
  readonly detail?: string;
  readonly remedy?: OperationRequest;
}

export interface DockerView {
  readonly engine: "running" | "stopped" | "missing" | "unknown";
  readonly context?: string;
  readonly endpoint?: string;
  readonly platform?: string;
  readonly os?: string;
  readonly serverVersion?: string;
  readonly composeVersion?: string;
  /** Docker Desktop's CLI plugin is present, so Studio can start it. */
  readonly desktop: boolean;
  readonly problem?: string;
}

export interface ServiceView {
  readonly name: string;
  readonly container: string;
  readonly state: string;
  readonly health?: "healthy" | "unhealthy" | "starting";
  readonly exitCode?: number;
  readonly oneShot: boolean;
  readonly ports: string;
}

export interface ManagedProcessView {
  readonly running: boolean;
  readonly jobId?: string;
  readonly exitCode?: number | null;
  /** How it last ended, when it is not running. */
  readonly summary?: string;
}

export interface LocalRunView {
  readonly project: string;
  readonly docker: DockerView;
  readonly services: readonly ServiceView[];
  readonly watch: ManagedProcessView;
  readonly client: ManagedProcessView;
  /** What the exported files on this machine point at. */
  readonly exported: { readonly deployment?: string; readonly account?: string; readonly region?: string; readonly client: boolean };
  /** none: nothing running. studio: started here. outside: containers Studio did not start. */
  readonly startedBy: "none" | "studio" | "outside";
  readonly profile?: string;
  readonly appUrl?: string;
  readonly restartNeeded: readonly string[];
}

export type OperationKind =
  | "deploy-plan" | "deploy-apply" | "deploy-discard"
  | "destroy-plan" | "destroy"
  | "export"
  | "local-start" | "local-stop" | "local-restart" | "local-attach-watch"
  | "deps-install" | "docker-start" | "aws-login" | "drift";

export interface OperationRequest {
  readonly kind: OperationKind;
  readonly params: Readonly<Record<string, string | boolean | undefined>>;
}

export type JobStatus = "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

export interface JobView {
  readonly id: string;
  readonly kind: OperationKind | "local-watch" | "local-client";
  readonly title: string;
  readonly params: Readonly<Record<string, string | boolean | undefined>>;
  readonly status: JobStatus;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly exitCode?: number | null;
  /** A one-line outcome: the last meaningful line, or the failure. */
  readonly summary?: string;
  /** A plan this job wrote or applied. */
  readonly planId?: string;
  /** The deployment a cloud job acts on, for following its stacks. */
  readonly deployment?: string;
  readonly lastSeq: number;
  readonly steps?: readonly { readonly label: string; readonly status: "pending" | "running" | "done" | "failed" | "skipped" }[];
}

export interface JobLogLine {
  readonly seq: number;
  readonly at: string;
  readonly stream: "out" | "err" | "info";
  readonly text: string;
}

export interface ResourceChangeView {
  readonly logicalId: string;
  readonly type: string;
  readonly action: "add" | "modify" | "remove";
  readonly replacement: "True" | "False" | "Conditional" | "Unknown";
  readonly deletionPolicy?: string;
  readonly stateful: boolean;
  readonly details?: readonly string[];
}

export interface PlanView {
  /** Studio's name for the plan: its directory under .cache/framework-studio/plans. */
  readonly key: string;
  readonly planId: string;
  readonly expired: boolean;
  readonly profile?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: "ready" | "no-changes" | "needs-secrets";
  readonly review: "template" | "change-set";
  readonly identity: { readonly deployment: string; readonly mode: DeployMode; readonly account: string; readonly region: string };
  readonly guard: string;
  readonly stacks: readonly {
    readonly name: string;
    readonly fingerprint: { readonly exists: boolean; readonly status?: string; readonly updated?: string };
    readonly changes: readonly ResourceChangeView[];
    readonly exportsInUse: readonly { readonly exportName: string; readonly change: string; readonly importers: readonly string[] }[];
    readonly noChanges: boolean;
    readonly deferred?: string;
    readonly changeSet?: { readonly name: string; readonly status?: string; readonly executionStatus?: string };
  }[];
  readonly secrets: readonly { readonly name: string; readonly variable: string; readonly action: "create" | "update" | "unchanged" }[];
  readonly dockerImages: readonly { readonly stack: string; readonly asset: string }[];
  readonly iamBroadening: boolean;
  readonly confirmation: { readonly level: "none" | "click" | "name"; readonly reasons: readonly string[] };
  readonly uncertainties: readonly string[];
  readonly result?: { readonly status: "succeeded" | "partial" | "unverified"; readonly deferred: readonly string[]; readonly verification: { readonly verified: boolean; readonly stacks: readonly { readonly name: string; readonly problem?: string }[] } };
}

export interface TeardownPlanView {
  readonly deployment: string;
  readonly mode: DeployMode;
  readonly account: string;
  readonly region: string;
  readonly stacks: readonly { readonly name: string; readonly status: string; readonly terminationProtection: boolean; readonly importedBy: readonly string[] }[];
  readonly leftInPlace: readonly { readonly name: string; readonly reason: string }[];
  readonly remains: readonly { readonly stack: string; readonly logicalId: string; readonly type: string; readonly policy: string }[];
  readonly secrets: readonly string[];
  readonly record: boolean;
}

export interface DriftView {
  readonly deployment: string;
  readonly checkedAt: string;
  readonly note: string;
  readonly stacks: readonly { readonly stack: string; readonly status: string; readonly detection: string; readonly resources: readonly { readonly logicalId: string; readonly type: string; readonly status: string }[] }[];
}

export interface DeployPreferences {
  /** The profile last used for each deployment (by name), and the last one chosen. */
  readonly profiles: Readonly<Record<string, string>>;
  readonly profile?: string;
  readonly deployment?: string;
}

/** What the page needs in one read: everything that is not an AWS observation. */
export interface DeployOverview {
  readonly targets: readonly Omit<TargetView, "status" | "detail">[];
  readonly prerequisites: readonly PrerequisiteView[];
  readonly local: LocalRunView;
  readonly jobs: readonly JobView[];
  readonly preferences: DeployPreferences;
  readonly profiles: readonly AwsProfileInfo[];
}

export interface PlanSummaryView {
  readonly key: string;
  readonly deployment: string;
  readonly mode: DeployMode;
  readonly status: PlanView["status"];
  readonly createdAt: string;
  readonly expired: boolean;
  readonly applied?: "succeeded" | "partial" | "unverified";
  /** After a partial apply: the stacks to plan now that what they import exists. */
  readonly deferred?: readonly string[];
}
