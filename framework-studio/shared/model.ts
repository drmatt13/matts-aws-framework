/**
 * What the studio knows about an application, as the browser receives it.
 *
 * Types only, and free of `@repo/framework` imports: the browser bundle never
 * evaluates a config. Every value here was projected by the server from the
 * framework's own normalization, and nothing here is a second declaration of
 * anything — identities are the framework's (`lambda:sign-in`, catalog paths),
 * and source-derived CDK relationships carry their evidence separately. Local
 * services use Compose identities; the declared schema is read from authored PSL.
 *
 * Sanitized by construction: resource *references* appear (a catalog path and
 * an attribute), resource *values* never do. Literal environment strings appear
 * because they are already written in the repository's source.
 */

import type { DeclaredSchema, LocalDatabase } from "./database";

export type Mode = "dev" | "prod";
export type DeploySetting = "both" | "cloud-only" | "local-only" | "none";
export type TargetKind = "lambda" | "service" | "task" | "workflow" | "agent";
export type TargetRole =
  | "http"
  | "webSocket"
  | "webSocketAuthorizer"
  | "event"
  | "tool"
  | "agent"
  | "service"
  | "task"
  | "workflow";

/** Declaration metadata, separate from topology and deployed construct identity. */
export interface TagFacts {
  readonly authored: Readonly<Record<string, string>>;
  readonly effective: Readonly<Record<string, string>>;
  /** The lower ownership layer, retained even when every key is overridden. */
  readonly inherited?: { readonly entity: string; readonly values: Readonly<Record<string, string>> };
  readonly provenance: Readonly<Record<string, { readonly entity: string; readonly kind: "declared" | "inherited" }>>;
  /** Capability belongs to the producer; referencing a resource never tags it. */
  readonly aws: { readonly kind: "owned" | "linked" | "external" | "logical"; readonly note: string };
}

/** A place in a repository file. `file` is repository-relative with forward slashes. */
export interface SourceLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly start: number;
  readonly end: number;
}

// ---------------------------------------------------------------------------
// Lanes: where a target runs, as the framework answers it
// ---------------------------------------------------------------------------

/** Why a target has the deploy setting it has. */
export type DeployOrigin =
  /** The entry writes `deploy`. */
  | "declared"
  /** The entry writes nothing; the framework's default is "both". */
  | "default"
  /** A tool: the union of the lanes of the agents that list it. */
  | "derived"
  /** An event: AWS invokes it, so there is no toggle and every graph holds it. */
  | "aws-invoked";

export interface Lanes {
  readonly deploy: DeploySetting;
  readonly when?: { readonly resource: string; readonly equals: string; readonly dev: "holds" | "fails" | "unset"; readonly prod: "holds" | "fails" | "unset" };
  readonly origin: DeployOrigin;
  /** For a derived tool lane: the agents it was derived from. */
  readonly derivedFrom?: readonly string[];
  /** Runs under Compose (`isTargetEnabled(..., "local")`). */
  readonly local: boolean;
  /** The author wants it in AWS (`isTargetEnabled(..., "cloud")`). Intent, not outcome. */
  readonly cloud: boolean;
  /** A development deployment builds it (`isTargetDeployed(..., "dev")`). */
  readonly dev: boolean;
  /** A production deployment builds it. */
  readonly prod: boolean;
  /** One line explaining a dev/prod answer that is not just the deploy token. */
  readonly note?: string;
}

// ---------------------------------------------------------------------------
// Network placement (production graph; the local lane mirrors it)
// ---------------------------------------------------------------------------

export type Placement =
  | {
      readonly kind: "outside";
      /** Why it is outside: the Lambda default, an agent's Runtime. */
      readonly reason: string;
    }
  | {
      readonly kind: "vpc";
      readonly networkId: string;
      readonly subnet: "public" | "private" | "isolated";
      readonly reason: string;
      readonly egress: { readonly ipv4: boolean; readonly ipv6: boolean };
      /** A Lambda calls dual-stack AWS endpoints where IPv6 leaves its subnet. */
      readonly dualStack?: boolean;
    }
  | {
      /** A Step Functions state machine: AWS runs it, in no subnet of this network. */
      readonly kind: "managed";
      readonly reason: string;
    };

export interface NetworkModel {
  readonly id: string;
  readonly name?: string;
  readonly constructId: string;
  readonly cidr: string;
  readonly zones: number;
  readonly egressOnlyInternetGateway: boolean;
  readonly natGateway: boolean;
  readonly gatewayEndpoints: readonly string[];
  readonly interfaceEndpoints: readonly string[];
  /** A production deployment builds the VPC only once something is placed in it. */
  readonly builtInProd: boolean;
  /** What a production deployment pays for NAT and interface endpoints a month, approximately. */
  readonly monthlyCost: { readonly natGateway: number; readonly interfaceEndpoints: number };
  readonly subnets: readonly {
    readonly name: "public" | "private" | "isolated";
    readonly egress: { readonly ipv4: boolean; readonly ipv6: boolean };
  }[];
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export type Compute =
  | {
      readonly kind: "lambda";
      readonly implementation: "typescript" | "python" | "container";
      readonly packaging: "zip" | "container";
      readonly runtime?: string;
      readonly handler?: string;
      readonly bundling?: { readonly minify: boolean; readonly sourceMap: boolean };
      readonly architecture: string;
      readonly memorySize: number;
      readonly timeoutSeconds: number;
      readonly logRetentionDays: number;
      readonly subnet: "none" | "private" | "isolated";
      readonly localReplay?: true;
    }
  | {
      readonly kind: "container";
      readonly cpu: number;
      readonly memoryMiB: number;
      readonly subnet: "public" | "private";
      readonly architecture: string;
      readonly desiredCount?: number;
      readonly publicLoadBalancer?: boolean;
      readonly port?: number;
      readonly healthCheckPath?: string;
    }
  | {
      readonly kind: "workflow";
      readonly type: "standard" | "express";
      readonly timeoutSeconds: number;
      readonly steps: number;
    }
  | {
      readonly kind: "agent";
      readonly auth: boolean;
      readonly route?: string;
      readonly tools: readonly string[];
    };

/** One environment entry as the workload receives it. */
export type EnvironmentValue =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "reference"; readonly resource: string; readonly display: string };

export interface ModelTarget {
  /** Permission sources without a drawable catalog endpoint (schedules, custom integrations). */
  readonly permissionSources?: readonly { readonly relation: "trigger" | "completesCallback" | "integration"; readonly peer: string; readonly label: string; readonly incoming?: boolean; readonly context?: import("./permissions").PermissionContext }[];
  readonly authorizations?: readonly { readonly connection?: string; readonly authorization: import("./permissions").ConnectionAuthorization }[];
  /** Source artifacts only; never evidence that a process or AWS resource runs. */
  readonly implementation?: { readonly ready: boolean; readonly problems: readonly string[] };
  /** `lambda:sign-in`: the framework's canonical reference, and this model's id. */
  readonly ref: string;
  readonly kind: TargetKind;
  readonly id: string;
  readonly role: TargetRole;
  readonly section?: string;
  /** What a person calls it: its route for a routed target, otherwise its id. */
  readonly title: string;
  readonly directory?: string;
  /** Logical declaration places, e.g. `http["/graphql"]`, in declaration order. */
  readonly origins: readonly string[];
  readonly constructId: string;
  /** The entry pins `cloud.constructId`; changing it would replace the deployed resource. */
  readonly constructIdPinned: boolean;
  readonly lanes: Lanes;
  readonly compute: Compute;
  readonly placement: Placement;
  readonly auth?: boolean;
  readonly userPool?: boolean;
  readonly environment: readonly { readonly name: string; readonly value: EnvironmentValue; readonly via?: "userPool" }[];
  readonly secrets: readonly { readonly name: string; readonly resource: string; readonly display: string }[];
  readonly access: readonly { readonly actions: readonly string[]; readonly resources: readonly string[] }[];
  readonly requirements: number;
  readonly requirementRules?: readonly import("./resources").RequirementRule[];
  readonly outputs: readonly string[];
}

// ---------------------------------------------------------------------------
// Routes: the public names that reach a target
// ---------------------------------------------------------------------------

export interface ModelRoute {
  /** `route:http:/graphql`, `route:service:/example-service/*`, `route:ws:$connect`, `route:agent:/chat/example`. */
  readonly id: string;
  readonly kind: "http" | "service" | "webSocket" | "agent";
  readonly path: string;
  /** What the browser calls: under /api for HTTP and services, as declared for agents. */
  readonly browserPath?: string;
  readonly methods?: "*" | readonly string[];
  readonly auth: boolean;
  readonly target: string;
  readonly authorizer?: string;
  readonly origin: string;
}

// ---------------------------------------------------------------------------
// Resource catalog
// ---------------------------------------------------------------------------

export type ResourceKind =
  /** Studio's CDK input-file metadata or client environment mappings. */
  | "envFile"
  /** `resource.stack<T>()`: the stack class is the declaration. */
  | "stack"
  /** A public field of a stack. */
  | "member"
  /** `resource.cdk<T>()`. */
  | "construct"
  /** `resource.fromEnv("NAME")`: a line authored in cdk-app/.env. */
  | "input"
  /** `resource.secret("NAME")`. */
  | "secret"
  /** A plain object grouping inputs, e.g. `langgraph`. */
  | "group";

export interface ModelResource {
  /** Catalog paths or `framework-stack:<Class>` for selected export-only stacks. */
  readonly id: string;
  readonly path: readonly string[];
  readonly kind: ResourceKind;
  readonly parent?: string;
  /**
   * The graph being built does not hold this resource: a catalog entry declared `undefined` (e.g.
   * `PROD_DEPLOYMENT ? … : undefined`), or a resource that belongs to the other environment, such as the other
   * environment's file. This one flag drives every view: its node's presence, its Dev/Prod badge and hover pills,
   * and the strength of its connections. A producer of any new resource scoped to an environment sets it per graph.
   */
  readonly absent: boolean;
  readonly fromEnv?: string;
  readonly default?: string;
  readonly required?: boolean;
  readonly inputRequirement?: import("./deployment-inputs").InputRequirement;
  /** Outcomes of declared client comparisons in this mode; never resolved input values. */
  readonly inputComparisons?: Readonly<Record<string, "holds" | "fails" | "unset">>;
  readonly values?: readonly string[];
  readonly note?: string;
  /** For a stack member: the field's declared type, read from the stack class. */
  readonly typeText?: string;
  /** For a stack member: where it came from. A member read by a workload but not found in source is still listed. */
  readonly memberSource?: "class" | "usage" | "both";
  /** For a stack: the class it reads. */
  readonly stackClass?: string;
  /** Source evidence only; this never queries CloudFormation deployment status. */
  readonly stackUsage?: { readonly status: "referenced" | "unreferenced" | "unknown"; readonly sites: readonly SourceLocation[] };
  /** The configured database/owner, or a public root-environment export stack. */
  readonly frameworkManaged?: "database" | "outputs";
  /** Public CfnOutput names and their root .env mappings, never resolved values. */
  readonly stackOutputs?: readonly { readonly name: string; readonly envName: string; readonly symbol: string; readonly source: SourceLocation }[];
  /** Framework stack projected from source rather than declared in the resource catalog. */
  readonly frameworkStack?: boolean;
  /** Literal subnet selection read from the stack member's constructor. */
  readonly networkPlacement?: "public" | "private" | "isolated";
  readonly networkId?: string;
  readonly deploymentFile?: import("./deployment-inputs").DeploymentInputFile;
  /** Client variable references and transformations, never resolved values. */
  readonly clientEnvironment?: import("./client-environment").ClientEnvironmentFile;
  /** Assignment metadata for this catalog declaration; never dotenv values. */
  readonly inputSources?: readonly { readonly file: string; readonly entry: import("./deployment-inputs").DeploymentInputEntry }[];
}

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

export type Relation =
  /** An input controls whether a workload is deployed: input -> workload. */
  | "deployWhen"
  /** A stack owns a resource shown independently on the map. */
  | "contains"
  /** A route reaches its target. */
  | "routes"
  /** A WebSocket authorizer guards `$connect`. */
  | "authorizes"
  /** An environment entry reads a catalog value. */
  | "env"
  /** A local deployment input file supplies an authored parameter or secret name. */
  | "supplies"
  /** A client variable maps an input file or a public stack output. */
  | "maps"
  /** A container is handed a secret at startup. */
  | "secret"
  /** A native CDK grant method on a catalog construct. */
  | "grant"
  /** `database: true`: IAM login, network placement and the connection URL. */
  | "database"
  /** An opted-in event captures invocations through the development replay stack. */
  | "localReplay"
  /** A native or declared event source invokes an event Lambda. */
  | "trigger"
  | "runsTask"
  | "startsWorkflow"
  | "invokesAgent"
  /** An agent's Gateway holds a tool. */
  | "usesTool"
  /** A workflow step invokes a target. */
  | "step"
  /** A workflow step calls a managed service on a catalog construct. */
  | "integration"
  /** A worker completes a workflow callback. */
  | "completesCallback"
  /** Permission to send replies through the selected WebSocket API. */
  | "manageConnections"
  /** A relationship found in linked application CDK source, without executing it. */
  | "cdk";

export interface ModelEdge {
  readonly permissionContext?: import("./permissions").PermissionContext;
  readonly authorization?: import("./permissions").ConnectionAuthorization;
  readonly inputRequirement?: import("./deployment-inputs").InputRequirement;
  /** `relation:from->to#n`, so two relations between one pair stay two edges. */
  readonly id: string;
  readonly relation: Relation;
  readonly from: string;
  readonly to: string;
  /** Framework declarations/derivations, or separately identified CDK/input-file source evidence. */
  readonly provenance: "declared" | "derived" | "source";
  readonly source?: SourceLocation;
  /** Native constructor at the wiring site, resolved from CDK imports rather than a local alias or interface type. */
  readonly sourceConstruct?: string;
  readonly evidence?: readonly ConnectionEvidence[];
  /** An explicit true setting found in the authored syntax; excerpts never establish editability. */
  readonly bindingSetting?: { readonly field: "database" | "userPool"; readonly value: true; readonly source: SourceLocation };
  readonly attachment?: string;
  /** Native trigger wiring Studio can delete exactly, or why it must be edited in source. */
  readonly removal?: NativeRemoval;
  /** A short human label: the env name, the grant method, the operations. */
  readonly label: string;
  readonly detail?: string;
}

/** A syntax span in the stack file: a lambdaTriggers entry, a constructor statement or a rule target. */
export type NativeRemoval =
  | { readonly kind: "property" | "statement" | "element"; readonly start: number; readonly end: number }
  | { readonly refused: string };

/** Source references only; excerpts are sanitized TypeScript, never evaluated values. */
export interface ConnectionEvidence {
  readonly role: "declared" | "derived" | "field" | "assigned" | "linked" | "catalog" | "wired";
  readonly location: SourceLocation;
  readonly excerpt?: string;
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

export interface ModelWorkflow {
  readonly ref: string;
  readonly id: string;
  readonly type: "standard" | "express";
  readonly timeoutSeconds: number;
  /** Node id to generated state name: what runner and Step Functions histories say. */
  readonly names: Readonly<Record<string, string>>;
  readonly targets: readonly string[];
  readonly integrations: readonly {
    readonly key: string;
    readonly resource?: string;
    readonly operations: readonly string[];
    readonly awaitsCallback: boolean;
  }[];
  /** The IR, serialized: node kinds, children, and symbolic references as data. */
  readonly root: unknown;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface Diagnostic {
  readonly severity: "error" | "warning";
  /** Where the framework raised it: loading, validation, or the cloud-edge check for a mode. */
  readonly stage: "load" | "validate" | "cloud-edges";
  readonly message: string;
  /** The entity the message names, when it names one by its logical origin. */
  readonly entity?: string;
}

// ---------------------------------------------------------------------------
// One mode's model, and the snapshot that holds both
// ---------------------------------------------------------------------------

export interface ModeModel {
  /** Canonical entity IDs, including database declarations and VPC islands. No resolved inputs. */
  readonly tagging?: Readonly<Record<string, TagFacts>>;
  /** Framework-projected token previews, including role-specific development placement. */
  readonly deployChoices?: Readonly<Record<TargetRole, Readonly<Record<string, { readonly local: boolean; readonly cloud: boolean; readonly dev: boolean; readonly prod: boolean }>>>>;
  readonly gateways?: readonly import("./gateways").ModelGateway[];
  readonly triggers?: readonly import("./triggers").TriggerBinding[];
  readonly triggerAdapters?: readonly import("./triggers").TriggerAdapterMetadata[];
  /** The framework's CDK-derived supported names, independent of regional availability. */
  readonly interfaceEndpointServices?: readonly string[];
  /** Each event's declared onFailure destination. */
  readonly failureDestinations?: readonly import("./triggers").FailureDestination[];
  /** Shared framework defaults, separate from workload declarations. */
  readonly defaults?: readonly ModelDefaults[];
  readonly localServices?: readonly LocalDatabase[];
  readonly mode: Mode;
  readonly status: "ok" | "error";
  /**
   * The configuration does not load right now, and this is the last model that
   * did: shown so the view does not vanish mid-edit, never edited against.
   * Its diagnostics are the current ones.
   */
  readonly stale?: true;
  readonly targets: readonly ModelTarget[];
  readonly routes: readonly ModelRoute[];
  readonly resources: readonly ModelResource[];
  readonly edges: readonly ModelEdge[];
  readonly workflows: readonly ModelWorkflow[];
  readonly networks?: readonly NetworkModel[];
  readonly managedDatabase?: import("./managed-database").ManagedDatabaseModel;
  readonly databaseNetworkId?: string;
  /** Target ref to its editable fields, as resolved in this mode. */
  readonly fields: Readonly<Record<string, readonly FieldFact[]>>;
  readonly diagnostics: readonly Diagnostic[];
  /** How long evaluation took, for the status bar and for honesty about refresh latency. */
  readonly evaluatedInMs: number;
}

// ---------------------------------------------------------------------------
// Source: where each entity was written, and what the studio may change in it
// ---------------------------------------------------------------------------

/**
 * What the studio may do with one property of one declaration.
 *
 * Decided from the source, never from the evaluated value alone: a literal is
 * editable, an absent key may be inserted where its parent is an object
 * literal, and anything an expression produces is shown and left alone.
 */
export type Editability =
  | { readonly kind: "condition"; readonly text: string }
  | { readonly kind: "literal"; readonly text: string }
  | { readonly kind: "absent" }
  | { readonly kind: "computed"; readonly text: string }
  | { readonly kind: "spread"; readonly text: string }
  | { readonly kind: "unsupported"; readonly reason: string };

export interface EntitySource {
  /** `framework.config.ts`-relative logical origin, e.g. `http["/graphql"]`. */
  readonly origin: string;
  /** The key as written. */
  readonly key: SourceLocation;
  /** The declaration's value: its object literal, or the call producing it. */
  readonly value: SourceLocation;
}

export type FieldDomain =
  | { readonly kind: "enum"; readonly values: readonly (string | number | boolean)[] }
  | { readonly kind: "number"; readonly min: number; readonly max: number; readonly unit: string };

/**
 * One editable field of one target, as the framework resolved it.
 *
 * Evaluated facts only. Whether the source lets the studio change it is the
 * source index's answer ({@link SourceIndex.editability}); the inspector needs both.
 */
export interface FieldFact {
  /** Field registry id, e.g. `deploy`, `lambda.subnet`. */
  readonly field: string;
  readonly label: string;
  /** Property path inside the declaration, e.g. `["cloud", "subnet"]`. */
  readonly path: readonly string[];
  readonly domain: FieldDomain;
  /** The value the framework resolved, after defaults. */
  readonly effective: string | number | boolean;
  /** Where the effective value came from, in words. */
  readonly provenance: string;
  /** The value the evaluated declaration holds at `path`, before defaults; undefined when absent. */
  readonly authored?: string | number | boolean | null;
  /** What removing the property would resolve to, when removal is offered. */
  readonly inherited?: { readonly value: string | number | boolean; readonly from: string };
  /** Why the field is shown but cannot be changed by the studio. */
  readonly blocked?: string;
  /** Current workloads inheriting or overriding a shared default. */
  readonly usage?: { readonly inherited: number; readonly overridden: number };
}

export interface ModelDefaults {
  readonly ref: string;
  readonly title: string;
  readonly group: string;
  readonly origin: "defaults";
  readonly targets: readonly string[];
}

export interface SourceIndex {
  readonly triggerCapabilities?: readonly import("./triggers").TriggerCapability[];
  readonly capabilityFiles?: Readonly<Record<string, string>>;
  /** Studio-only scan output; never consumed by framework configuration or CDK. */
  readonly cdkLinks: CdkLinkIndex;
  /** Entity id (target ref, route id, resource id) to where it was written. */
  readonly entities: Readonly<Record<string, EntitySource>>;
  /** Target ref, then field id, to what the source allows for that field. */
  readonly editability: Readonly<Record<string, Readonly<Record<string, Editability>>>>;
  /** Catalog path (`cognito`) to where `linkResources`/`linkResource` binds it in application CDK. */
  readonly links: Readonly<Record<string, readonly SourceLocation[]>>;
  /** Resource id to what its declaration says beyond its value. */
  readonly catalog: Readonly<
    Record<string, { readonly condition?: string; readonly stackClass?: string; readonly stackLocation?: SourceLocation }>
  >;
  /** Problems the index met, reported rather than thrown. */
  readonly problems: readonly string[];
}

export interface CdkLinkIndex {
  readonly version: 2;
  /** Only source hashes and relationships, never construct values or source text. */
  readonly files: Readonly<Record<string, string>>;
  readonly edges: readonly ModelEdge[];
  readonly notes: readonly string[];
  readonly manualWiring: readonly { readonly resource: string; readonly source: SourceLocation; readonly reason: string }[];
}

export interface Snapshot {
  readonly descriptions: { readonly values: Readonly<Record<string, string>>; readonly problem?: string };
  readonly schema: DeclaredSchema;
  readonly databaseProblems: readonly string[];
  /** Changes whenever any watched file or input changes. */
  readonly revision: string;
  readonly generatedAt: string;
  readonly repositoryRoot: string;
  readonly models: { readonly dev: ModeModel; readonly prod: ModeModel };
  readonly source: SourceIndex;
  /** sha256 of each studio-editable file, which a plan is checked against before a write. */
  readonly files: Readonly<Record<string, string>>;
}
