import {
  EVENT_SOURCE_ROOT,
  LAMBDA_SOURCE_ROOT,
  TASK_SOURCE_ROOT,
} from "./conventions";
import { isDeploySettingEnabled } from "./deploy";
import {
  getAgentBrowserRoutes,
  getDefaultAgentDirectory,
  getDefaultToolDirectory,
  validateAgentCoreConfig,
  type AgentTargetDefinition,
  type FrameworkAgents,
  type FrameworkTools,
} from "./agentcore";
import type { DeployScope, DeploySetting } from "./deploy";
import { LAMBDA_SOURCE_DIRECTORY_BY_ID } from "../generated/target-ids";
import type {
  EventLambdaId,
  LambdaSourceDirectory,
  ServiceSourceDirectory,
  TaskSourceDirectory,
  TaskTargetId,
  WorkflowTargetId,
} from "../generated/target-ids";
import {
  formatResourceReference,
  formatResourceEnv,
  isSecretArnReference,
  isResourceReference,
  isUnresolvedTokenString,
  listResourceDeclarations,
  listCdkResourceDeclarations,
  listCdkResourceGroupDeclarations,
  resolveResourceReference,
} from "./resources";
import { isInvocationBinding } from "./resources";
import { assertRequirementsMet, describeRequirementFix } from "./requirements";
import type { CloudRequirement, ResolvedCloudRequirement } from "./requirements";
import { assertJsonArguments, isCdkResource, isGroupMember, type NativeGrantBinding } from "./cdk-resources";
import { normalizeWorkflow } from "./workflows";
import type {
  NormalizedWorkflow,
  WorkflowDefinition,
  WorkflowStepTarget,
} from "./workflows";
import type {
  AnyResourceCatalog,
  CloudAccessStatement,
  CloudMode,
  InvocationBinding,
  InvokesAgentBinding,
  CompletesCallbackBinding,
  ReadSecretBinding,
  ResourceBinding,
  RunsTaskBinding,
  StartsWorkflowBinding,
  ResourceDeclarationGroup,
  ResourceKind,
  ResourceReference,
  ResourceEnvironmentReaders,
  SecretHandle,
  ResourceResolver,
  SecretResourceReference,
  StringResourceReference,
} from "./resources";

export * from "./resources";
export * from "./requirements";
export * from "./secret-bindings";
export * from "./cdk-resources";
export * from "./resource-manifest";
export * from "./workflows";
export * from "./agentcore";
export * from "./workflow-semantics";
export * from "./workflow-asl";
// Named rather than `export *`: reading a deploy token is the framework's job,
// so `isDeploySettingEnabled` stays internal to the package.
export { DEPLOY_SETTINGS } from "./deploy";
export type { DeployScope, DeploySetting } from "./deploy";

export {
  EVENT_LAMBDA_IDS,
  AGENT_TARGET_IDS,
  type AgentTargetId,
  LAMBDA_SOURCE_DIRECTORIES,
  LAMBDA_SOURCE_DIRECTORY_BY_ID,
  LAMBDA_TARGET_IDS,
  SERVICE_SOURCE_DIRECTORIES,
  SERVICE_TARGET_IDS,
  TASK_SOURCE_DIRECTORIES,
  TASK_TARGET_IDS,
  WORKFLOW_TARGET_IDS,
  type EventLambdaId,
  type LambdaSourceDirectory,
  type LambdaTargetId,
  type ServiceSourceDirectory,
  type ServiceTargetId,
  type TaskSourceDirectory,
  type TaskTargetId,
  type WorkflowTargetId,
} from "../generated/target-ids";

export const HTTP_METHODS = [
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

// ---------------------------------------------------------------------------
// Canonical target identity
//
// A route is what the outside world calls; a target is what the framework
// builds, registers and invokes. They are deliberately separate: renaming a
// public route must not rename a Lambda, invalidate a persisted replay
// envelope, or change which directory a runner loads.
// ---------------------------------------------------------------------------

export type LambdaTarget = `lambda:${string}`;
export type ServiceTarget = `service:${string}`;
export type TaskTarget = `task:${string}`;
export type WorkflowTarget = `workflow:${string}`;
export type AgentTarget = `agent:${string}`;
export type TargetReference =
  | LambdaTarget
  | ServiceTarget
  | TaskTarget
  | WorkflowTarget
  | AgentTarget;

export type TargetKind = "lambda" | "service" | "task" | "workflow" | "agent";

/**
 * Kinds built from a source directory.
 *
 * A workflow is authored entirely in the config — its graph is the declaration
 * and its steps are other targets — so it is the one kind with nothing on disk
 * to resolve, build, or sweep for an adjacent contract.
 */
export type SourcedTargetKind = "lambda" | "service" | "task" | "agent";

export interface ParsedTargetReference {
  readonly kind: TargetKind;
  readonly id: string;
  readonly reference: TargetReference;
}

/** How a target is reached, which is also what makes two declarations of one id a conflict. */
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

// ---------------------------------------------------------------------------
// Source locations
//
// A framework path is rooted at `cdk-app`, written with a leading slash and
// forward slashes on every platform. `/lambda_functions/http_functions/sign-in` is a framework
// path, *not* an operating-system absolute path: nothing here ever touches a
// filesystem. Resolving one against the real repository — and proving it stays
// inside `cdk-app` — is the Node-only boundary's job in `@repo/framework/config/source`,
// which is what keeps this module browser-safe.
// ---------------------------------------------------------------------------

/**
 * A source directory relative to `cdk-app`, with a leading slash.
 * @example "/lambda_functions/http_functions/sign-in"
 * @example "/ecs_containers/services/example-service"
 */
export type FrameworkDirectory = `/${string}`;

export {
  EVENT_SOURCE_ROOT,
  LAMBDA_SOURCE_ROOT,
  SERVICE_SOURCE_ROOT,
  TASK_SOURCE_ROOT,
} from "./conventions";

/**
 * Known directories autocomplete; any other valid framework path is still
 * accepted, so a directory added in the same edit as its config entry does not
 * have to wait for a successful generation first.
 */
export type SuggestedLambdaDirectory =
  | LambdaSourceDirectory
  | (FrameworkDirectory & {});
export type SuggestedServiceDirectory =
  | ServiceSourceDirectory
  | (FrameworkDirectory & {});
export type SuggestedTaskDirectory =
  | TaskSourceDirectory
  | (FrameworkDirectory & {});

/**
 * Declared event ids autocomplete; any other id is still accepted, so a handler
 * added in the same edit as the stack that triggers it does not have to wait for
 * a successful generation first. An id nothing built is reported when it is
 * looked up, naming the ids that exist.
 */
export type SuggestedEventId = EventLambdaId | (string & {});

/**
 * Declared task and workflow ids autocomplete where an invocation binding or a
 * workflow step names one; any other id is still accepted, so a target added in
 * the same edit as its caller does not have to wait for a generation first.
 * Normalization is authoritative either way — an id nothing declares is an
 * error naming the ids that exist.
 */
export type SuggestedTaskId = TaskTargetId | (string & {});
export type SuggestedWorkflowId = WorkflowTargetId | (string & {});

/** Where a `tasks` entry that declares no `directory` looks for its container. */
function getDefaultTaskDirectory(id: string): FrameworkDirectory {
  return `${TASK_SOURCE_ROOT}/${id}`;
}

/**
 * Where an `events` entry that declares no `directory` looks for its handler.
 *
 * The generated map is consulted first, so a handler filed anywhere under the
 * event grouping directory is found by its id alone. The convention path is the
 * fallback, which is what lets a directory added in the same edit as its entry
 * resolve before the next generation runs — `resolveFrameworkDirectory` still
 * proves it exists. Only entries under the event group are accepted, so a bare
 * event id can never quietly resolve to an HTTP handler's directory.
 */
function getDefaultEventDirectory(id: string): FrameworkDirectory {
  const filed = (
    LAMBDA_SOURCE_DIRECTORY_BY_ID as Readonly<Record<string, string | undefined>>
  )[id];
  return filed?.startsWith(`${EVENT_SOURCE_ROOT}/`)
    ? (filed as FrameworkDirectory)
    : `${EVENT_SOURCE_ROOT}/${id}`;
}

const TARGET_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TARGET_PATTERN =
  /^(lambda|service|task|workflow|agent):([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const DIRECTORY_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Validates and canonicalizes an authored directory without touching disk.
 *
 * Malformed locations are rejected rather than reinterpreted: a path quietly
 * rewritten here is a path that resolves differently in CDK, the local runner
 * and the container builder.
 */
export function normalizeFrameworkDirectory(
  directory: unknown,
  origin: string,
): FrameworkDirectory {
  if (typeof directory !== "string" || directory.length === 0) {
    throw new Error(
      `${origin} must declare a "directory" such as "${LAMBDA_SOURCE_ROOT}/sign-in", relative to cdk-app.`,
    );
  }
  if (directory.includes("\\")) {
    throw new Error(
      `${origin} directory "${directory}" uses backslashes. Framework paths always use forward slashes so Windows and Linux agree.`,
    );
  }
  if (/^[A-Za-z]:/.test(directory) || directory.startsWith("//")) {
    throw new Error(
      `${origin} directory "${directory}" looks like a drive or UNC path. Use a framework path rooted at cdk-app, such as "${LAMBDA_SOURCE_ROOT}/sign-in".`,
    );
  }
  if (!directory.startsWith("/")) {
    throw new Error(
      `${origin} directory "${directory}" must start with "/", which means the root of cdk-app — not the root of the filesystem.`,
    );
  }
  if (directory !== directory.trim() || /\s/.test(directory)) {
    throw new Error(`${origin} directory "${directory}" must not contain whitespace.`);
  }
  if (directory.endsWith("/")) {
    throw new Error(`${origin} directory "${directory}" must not end with a slash.`);
  }

  for (const segment of directory.slice(1).split("/")) {
    if (segment.length === 0) {
      throw new Error(
        `${origin} directory "${directory}" contains an empty path segment.`,
      );
    }
    if (segment === "." || segment === "..") {
      throw new Error(
        `${origin} directory "${directory}" contains a "${segment}" segment. Declare the location directly instead of traversing.`,
      );
    }
    if (!DIRECTORY_SEGMENT_PATTERN.test(segment)) {
      throw new Error(
        `${origin} directory "${directory}" has an unsupported path segment "${segment}".`,
      );
    }
  }

  return directory as FrameworkDirectory;
}

/** The default target id for a directory: its final segment. */
export function getDirectoryTargetId(directory: FrameworkDirectory): string {
  const segments = directory.slice(1).split("/");
  return segments[segments.length - 1] ?? "";
}

// ---------------------------------------------------------------------------
// Lambda build + deploy configuration
// ---------------------------------------------------------------------------

export const LAMBDA_ARCHITECTURES = ["arm64", "x86_64"] as const;
export type LambdaArchitecture = (typeof LAMBDA_ARCHITECTURES)[number];

export const LAMBDA_PACKAGING = ["zip", "container"] as const;
export type LambdaPackaging = (typeof LAMBDA_PACKAGING)[number];

export const NODE_LAMBDA_RUNTIMES = ["nodejs24", "nodejs22"] as const;
export const PYTHON_LAMBDA_RUNTIMES = ["python3.13", "python3.12"] as const;
export const LAMBDA_RUNTIMES = [
  ...NODE_LAMBDA_RUNTIMES,
  ...PYTHON_LAMBDA_RUNTIMES,
] as const;
export type NodeLambdaRuntime = (typeof NODE_LAMBDA_RUNTIMES)[number];
export type PythonLambdaRuntime = (typeof PYTHON_LAMBDA_RUNTIMES)[number];
export type LambdaRuntime = (typeof LAMBDA_RUNTIMES)[number];

/** esbuild options for a zip-packaged Node Lambda. */
export interface LambdaBundlingOptions {
  /** Minify the emitted JavaScript bundle. Inherits `defaults.lambda.bundling.minify`. */
  readonly minify?: boolean;
  /** Emit a source map beside the JavaScript bundle. Inherits the framework default. */
  readonly sourceMap?: boolean;
}

/** Baseline every Lambda inherits. Per-target fields override these. */
export interface LambdaDefaults {
  /** Managed runtime used by zip-packaged Lambdas. */
  readonly runtime: LambdaRuntime;
  /** `zip` bundles source; `container` builds the target directory's Dockerfile. */
  readonly packaging: LambdaPackaging;
  /** CPU architecture used by both zip and container Lambda deployments. */
  readonly architecture: LambdaArchitecture;
  /** Default memory allocation in megabytes. */
  readonly memorySize: number;
  /** Default invocation timeout in seconds. */
  readonly timeoutSeconds: number;
  /** Default esbuild behavior for zip-packaged Node Lambdas. */
  readonly bundling: LambdaBundlingOptions;
  /**
   * Days CloudWatch keeps each function's logs: one of CloudWatch's retention
   * values (1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, …). Defaults to 30.
   */
  readonly logRetentionDays?: number;
}

/** The retention periods CloudWatch Logs accepts, in days. */
export const CLOUDWATCH_LOG_RETENTION_DAYS = [
  1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827,
  2192, 2557, 2922, 3288, 3653,
] as const;

/** Build overrides shared by http, webSocket, and events Lambdas. */
export interface LambdaTargetDefinition {
  /** Override the managed runtime. Invalid for `packaging: "container"`. */
  readonly runtime?: LambdaRuntime;
  /** Override whether this target is deployed from a zip or container image. */
  readonly packaging?: LambdaPackaging;
  /** Override the Lambda CPU architecture. */
  readonly architecture?: LambdaArchitecture;
  /** Override memory allocation in megabytes. Must be positive. */
  readonly memorySize?: number;
  /** Override the invocation timeout in seconds. Must be positive. */
  readonly timeoutSeconds?: number;
  /** Override individual esbuild defaults for a zip-packaged Node Lambda. */
  readonly bundling?: LambdaBundlingOptions;
  /** Override how many days CloudWatch keeps this function's logs. */
  readonly logRetentionDays?: number;
  /**
   * Override the runtime's conventional *exported handler* name. This never
   * names a directory — {@link LambdaSourceSpec.directory} does that.
   * @default "lambdaHandler" for Node, "lambda_function.lambda_handler" for Python
   */
  readonly handler?: string;
}

/** Where a Lambda's implementation lives, and — when the directory name is not the answer — who it is. */
export interface LambdaSourceSpec {
  /**
   * Implementation directory, rooted at `cdk-app` with a leading slash. Nested
   * locations are supported; the leading slash means the root of `cdk-app`, not
   * the root of the filesystem.
   * @example "/lambda_functions/http_functions/sign-in"
   */
  readonly directory: SuggestedLambdaDirectory;
  /**
   * Stable target id. Defaults to the directory's final segment, which is what
   * keeps registry keys, replay envelopes and environment prefixes unchanged
   * when a route is renamed. Declare it when two directories share a basename,
   * or to keep an identity while moving the source.
   */
  readonly id?: string;
}

/** An HTTP Lambda: where it lives, which methods it answers, and how it is built. */
export type HttpLambdaTargetDefinition<Catalog = AnyResourceCatalog> =
  LambdaTargetDefinition &
    TargetEnvironment<Catalog> &
    LambdaSourceSpec &
    HttpBindingSpec & {
      /** Where this function and its HTTP route are deployed. */
      readonly deploy?: DeploySetting;
      /** What this function needs in order to run in AWS. */
      readonly cloud?: HttpCloudSettings<Catalog>;
    };

/** A WebSocket Lambda, plus — on `$connect` — the authorizer guarding the handshake. */
export type WebSocketLambdaTargetDefinition<Catalog = AnyResourceCatalog> =
  LambdaTargetDefinition &
    TargetEnvironment<Catalog> &
    LambdaSourceSpec & {
      /**
       * Request authorizer for this route. Only `$connect` can carry one: API
       * Gateway authorizes the handshake, not the messages that follow.
       */
      readonly authorizer?: WebSocketAuthorizerSpec<Catalog>;
      /** Where this function and its WebSocket role are deployed. */
      readonly deploy?: DeploySetting;
      /** What this function needs in order to run in AWS. */
      readonly cloud?: WebSocketCloudSettings<Catalog>;
    };

/** A Lambda invoked through native AWS wiring, keyed by its stable target id. */
export interface EventLambdaTargetDefinition<Catalog = AnyResourceCatalog>
  extends LambdaTargetDefinition, TargetEnvironment<Catalog> {
  /**
   * Implementation directory. Defaults to where the handler named by this
   * entry's key is filed under `/lambda_functions/event_functions`, so declare
   * it only to build an event from a source kept somewhere else.
   */
  readonly directory?: SuggestedLambdaDirectory;
  /** What the function needs in AWS; its trigger remains native CDK. */
  readonly cloud?: EventCloudSettings<Catalog>;
  /** Capture AWS invocations for local replay under this target's own id. */
  readonly localReplay?: true;
}

// ---------------------------------------------------------------------------
// Local task facilities. Service startup is handwritten in docker-compose.yml.
// ---------------------------------------------------------------------------

/** Local facilities a service can ask for. Each one is an adapter, not a permission. */
export const LOCAL_SERVICE_RESOURCES = [
  "primaryDatabase",
  "awsCredentials",
] as const;
export type LocalServiceResource = (typeof LOCAL_SERVICE_RESOURCES)[number];

/**
 * Environment names the framework owns for a local service container.
 *
 * A service may not redeclare one: the value comes from the resolved port or
 * from a requested resource, and two answers to the same name is a
 * misconfiguration rather than an override.
 */
export const RESERVED_LOCAL_ENVIRONMENT_KEYS = [
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_SDK_LOAD_CONFIG",
  "PORT",
  "PRIMARY_DATABASE_URL",
] as const;

/**
 * Compose service names the framework's own local infrastructure holds.
 *
 * Checked for every declaration, enabled or not, so turning a service back on
 * can never collide with the database or a dev server after the fact.
 */
export const RESERVED_LOCAL_SERVICE_NAMES = [
  "ws-tester",
  "local-api-dev-server",
  "local-invocation-runner",
  "local-ws-dev-server",
  "pgadmin",
  "postgres",
  "prisma-migrate",
] as const;

// ---------------------------------------------------------------------------
// Cloud deployment contract
//
// What a target needs from the rest of the system in order to *run in AWS*:
// its runtime environment, the resources it reads, the permissions those reads
// require, and the identity its deployed resource keeps. Declared beside the
// target rather than in a CDK table, so adding a workload is a config entry.
//
// These are runtime values, not build inputs. CDK carries an unresolved id or
// ARN into CloudFormation as a token, so a value need not exist while an asset
// is being built — which is why none of this is copied into Docker ARG/ENV or
// esbuild `define`.
//
// This section is about *deployed* workloads. A local Lambda keeps its
// dev-server environment. A service projects its target environment into both
// the deployed task and its local container.
// ---------------------------------------------------------------------------

/** Container CPU architecture. The same two values a Lambda has. */
export type ContainerArchitecture = LambdaArchitecture;

/** A `CfnOutput` carrying one of a target's deployed values. */
export interface CloudOutputSpec {
  /** Output construct id. Stable: changing it changes the output. */
  readonly id: string;
  /** Appended to `<stackName>:` to form a cross-stack export name. */
  readonly exportName?: string;
}

/** Outputs a deployed Lambda can publish. */
export interface LambdaCloudOutputs {
  readonly arn?: CloudOutputSpec;
}

/** Outputs a deployed service can publish. */
export interface ServiceCloudOutputs {
  readonly url?: CloudOutputSpec;
}

/**
 * Outputs a deployed task definition can publish.
 *
 * Nothing is published by default, and no internal caller reads one: a binding
 * resolves through the registered handle, never by scraping an export. These
 * exist for a consumer outside this application's graph.
 */
export interface TaskCloudOutputs {
  readonly taskDefinitionArn?: CloudOutputSpec;
}

/** Outputs a deployed state machine can publish. */
export interface WorkflowCloudOutputs {
  readonly arn?: CloudOutputSpec;
}

/**
 * Environment names Lambda reserves for its own runtime. Setting one is
 * rejected by the service, so it is rejected here where the config is read.
 * @see https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html
 */
export const RESERVED_LAMBDA_ENVIRONMENT_KEYS = [
  "AWS_ACCESS_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_DEFAULT_REGION",
  "AWS_EXECUTION_ENV",
  "AWS_LAMBDA_FUNCTION_MEMORY_SIZE",
  "AWS_LAMBDA_FUNCTION_NAME",
  "AWS_LAMBDA_FUNCTION_VERSION",
  "AWS_LAMBDA_INITIALIZATION_TYPE",
  "AWS_LAMBDA_LOG_GROUP_NAME",
  "AWS_LAMBDA_LOG_STREAM_NAME",
  "AWS_LAMBDA_RUNTIME_API",
  "AWS_REGION",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SECRET_KEY",
  "AWS_SESSION_TOKEN",
  "LAMBDA_RUNTIME_DIR",
  "LAMBDA_TASK_ROOT",
  "_AWS_XRAY_DAEMON_ADDRESS",
  "_AWS_XRAY_DAEMON_PORT",
  "_HANDLER",
  "_X_AMZN_TRACE_ID",
] as const;

/**
 * Environment names the ECS factory owns for a deployed service.
 *
 * Lambda supplies its own region and has no port; a Fargate task has both, and
 * the framework sets them — the port from the one resolver local Compose
 * generation also reads, so the two environments cannot disagree.
 */
export const RESERVED_SERVICE_CLOUD_ENVIRONMENT_KEYS = [
  "AWS_REGION",
  "PORT",
] as const;

/**
 * Environment names the ECS factory owns for a deployed task.
 *
 * A task has no port to publish, so the service list's `PORT` is deliberately
 * absent: reserving it would reject a container that legitimately configures
 * one of its own.
 */
export const RESERVED_TASK_CLOUD_ENVIRONMENT_KEYS = ["AWS_REGION"] as const;

/**
 * The one input channel a launched task receives, as JSON.
 *
 * Identical for a direct `runTask`, a workflow's ECS step and a local
 * container, so a task reads its input the same way in every lane. Reserved
 * against declared environment and startup secrets, because a declaration that
 * set it would be silently replaced at launch.
 */
export const FRAMEWORK_TASK_INPUT_ENVIRONMENT = "FRAMEWORK_TASK_INPUT";

/**
 * ECS caps the *complete serialized overrides* object, not just the input, so
 * the budget is checked against the encoded overrides rather than the payload.
 * @see https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_RunTask.html
 */
export const ECS_OVERRIDES_CHARACTER_LIMIT = 8192;

/** Lambda's total environment budget, which injected descriptors count against. */
export const LAMBDA_ENVIRONMENT_BYTE_LIMIT = 4096;

/**
 * Environment prefixes the framework writes invocation descriptors under.
 *
 * A declaration may not use them: the name is derived from a target id, so an
 * authored variable sharing it would be overwritten by the projection that owns
 * it — silently in one lane and not the other.
 */
export const FRAMEWORK_DESCRIPTOR_PREFIXES = [
  "FRAMEWORK_TASK_",
  "FRAMEWORK_WORKFLOW_",
  "FRAMEWORK_AGENT_",
] as const;

/**
 * What an agent's Runtime adapter is told about itself — which agent it is and
 * where its Gateway answers. Owned by the framework like a descriptor.
 */
export const FRAMEWORK_AGENTCORE_ENVIRONMENT_PREFIX = "FRAMEWORK_AGENTCORE_";

/**
 * The descriptor document version CDK writes and the runtime helper reads.
 *
 * Declared here as well as in `@repo/framework/runtime/invocation`, because the two halves
 * are written separately: CDK and local startup produce descriptors against
 * this module, and the deployed reader parses them against its own copy.
 * `@repo/framework/runtime/invocation` does not import this module, keeping the
 * configuration machinery out of an invocation consumer's bundle. The replay
 * entry point separately reads the generated replay manifest directly.
 */
export const INVOCATION_DESCRIPTOR_VERSION = 1;

/** The environment name a target id's descriptor arrives under. */
export function descriptorEnvironmentName(
  kind: "task" | "workflow" | "agent",
  id: string,
): string {
  const prefix =
    kind === "task" ? "FRAMEWORK_TASK_" : kind === "workflow" ? "FRAMEWORK_WORKFLOW_" : "FRAMEWORK_AGENT_";
  return `${prefix}${id.replace(/-/g, "_").toUpperCase()}`;
}

/** Whether a name belongs to the framework's own invocation projection. */
export function isFrameworkOwnedEnvironmentName(name: string): boolean {
  return (
    name === FRAMEWORK_TASK_INPUT_ENVIRONMENT ||
    name.startsWith(FRAMEWORK_AGENTCORE_ENVIRONMENT_PREFIX) ||
    FRAMEWORK_DESCRIPTOR_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/** The workload environment shared by deployed and local execution. */
export interface TargetEnvironment<Catalog = AnyResourceCatalog> {
  readonly environment?: Readonly<Record<string, string | StringResourceReference<Catalog>>>;
}

export interface ServiceEnvironment<Catalog = AnyResourceCatalog> extends TargetEnvironment<Catalog> {
  /**
   * Secrets the container is started with: the ECS agent injects the value in
   * AWS, and Compose passes it straight through locally.
   *
   * The key is this container's environment name, and the value is a secret
   * from the catalog. The two are deliberately separate — the variable a
   * container reads is a fact about the container, and the variable you author
   * in cdk-app/.env is a fact about the secret — so one secret can reach two
   * containers under two names without being declared twice.
   *
   * Where the value itself comes from is the catalog's business: a
   * `resource.secret("NAME")` you author, or a secret field on a stack.
   * Neither reaches a CloudFormation template.
   */
  readonly secrets?: Readonly<Record<string, SecretResourceReference<Catalog>>>;
}

export interface ResolvedTargetEnvironment {
  readonly environment: Readonly<Record<string, string | ResourceReference>>;
  readonly secrets: Readonly<Record<string, ResourceReference>>;
}

export interface ResolvedTargetSettings extends ResolvedTargetEnvironment {
  readonly cloud: ResolvedCloudTarget;
}

/** Cloud settings every deployed target shares. */
export interface CloudTargetSettings<Catalog = AnyResourceCatalog> {
  /**
   * CloudFormation logical id of the deployed resource. Defaults to the target
   * id in PascalCase. Declared to keep an existing deployed resource — changing
   * a construct id replaces it — or to control identity deliberately.
   */
  readonly constructId?: string;
  /**
   * Operations needing configuration and permission together, such as reading a
   * secret. Each binding supplies its own environment name and the matching
   * grant on this target's role.
   */
  readonly bindings?: readonly ResourceBinding<Catalog>[];
  /** Permissions with no capability of their own, as typed IAM statements. */
  readonly access?: readonly CloudAccessStatement[];
  /**
   * Relationships this workload needs when it actually deploys.
   *
   * Declared here rather than on the catalog because a requirement belongs to
   * its consumer: an API key one service needs for one provider must not block
   * a deployment that disabled the service, or one that uses another provider.
   * Evaluated against the workloads this graph really constructs, before any of
   * them exist.
   */
  readonly requirements?: readonly CloudRequirement<Catalog>[];
}

/** Cloud settings for a Lambda behind the HTTP API. */
export interface HttpCloudSettings<Catalog = AnyResourceCatalog>
  extends CloudTargetSettings<Catalog> {
  readonly outputs?: LambdaCloudOutputs;
}

/** Cloud settings for a Lambda connected through native AWS triggers. */
export interface EventCloudSettings<Catalog = AnyResourceCatalog>
  extends CloudTargetSettings<Catalog> {
  readonly outputs?: LambdaCloudOutputs;
}

/** Cloud settings for a WebSocket Lambda or its authorizer. */
export interface WebSocketCloudSettings<Catalog = AnyResourceCatalog>
  extends CloudTargetSettings<Catalog> {
  readonly outputs?: LambdaCloudOutputs;
  /**
   * Push messages back to connected clients.
   *
   * Grants `execute-api:ManageConnections`, scoped to the API and stage this
   * route is served by. The policy is owned by the WebSocket API stack: the
   * API already depends on this handler through its integration, so granting
   * from the handler's own stack would close the cycle. The management
   * endpoint itself comes from the invocation's request context, which is why
   * no API id has to be injected as environment.
   */
  readonly manageConnections?: true;
}

/** Cloud settings for a container service on Fargate. */
export interface ServiceCloudSettings<Catalog = AnyResourceCatalog>
  extends CloudTargetSettings<Catalog> {
  readonly outputs?: ServiceCloudOutputs;
  /** Task CPU units. Defaults to 256. Must pair with a supported memory size. */
  readonly cpu?: number;
  /** Task memory in MiB. Defaults to 512. */
  readonly memoryMiB?: number;
  /** Tasks to run. Defaults to 1. */
  readonly desiredCount?: number;
  /**
   * Put the service's load balancer on the internet. Defaults to false: the
   * load balancer is internal and the HTTP API reaches it over a VPC link, so
   * the route's `auth: true` is the only way in — exactly as locally. A public
   * load balancer answers anyone who has its address, which is why it cannot
   * be combined with `auth: true`.
   */
  readonly publicLoadBalancer?: boolean;
  /** Give tasks a public IP. Defaults to true. */
  readonly assignPublicIp?: boolean;
  /**
   * Image and task architecture, kept in step with each other. Inherits
   * defaults.container.architecture, falling back to x86_64.
   */
  readonly architecture?: ContainerArchitecture;
  /** Named Dockerfile stage to build. Defaults to the final stage. */
  readonly buildTarget?: string;
}

/**
 * Cloud settings for a container that runs to completion on Fargate.
 *
 * Deliberately the service vocabulary minus everything that describes a
 * maintained process: no port, health path, desired count or load balancer. A
 * v1 task is one essential Linux container, one invocation per launch, running
 * its Dockerfile's command.
 */
export interface TaskCloudSettings<Catalog = AnyResourceCatalog>
  extends CloudTargetSettings<Catalog> {
  readonly outputs?: TaskCloudOutputs;
  /** Task CPU units. Defaults to 256. Must pair with a supported memory size. */
  readonly cpu?: number;
  /** Task memory in MiB. Defaults to 512. */
  readonly memoryMiB?: number;
  /**
   * Image and task architecture. Inherits defaults.container.architecture,
   * falling back to x86_64. Pins the local build and ECS runtime platform
   * to the same explicit architecture, independent of the build host.
   */
  readonly architecture?: ContainerArchitecture;
  /** Named Dockerfile stage to build. Defaults to the final stage. */
  readonly buildTarget?: string;
}

/** Cloud settings for a Step Functions state machine. */
export interface WorkflowCloudSettings {
  readonly constructId?: string;
  readonly outputs?: WorkflowCloudOutputs;
}

/** Supported Fargate CPU units, each with the memory sizes it allows. */
const FARGATE_CPU_MEMORY: ReadonlyMap<
  number,
  { readonly min: number; readonly max: number; readonly step: number }
> = new Map([
  [256, { min: 512, max: 2048, step: 512 }],
  [512, { min: 1024, max: 4096, step: 1024 }],
  [1024, { min: 2048, max: 8192, step: 1024 }],
  [2048, { min: 4096, max: 16384, step: 1024 }],
  [4096, { min: 8192, max: 30720, step: 1024 }],
  [8192, { min: 16384, max: 61440, step: 4096 }],
  [16384, { min: 32768, max: 122880, step: 8192 }],
]);

/** A resolved task's cloud settings, with every default folded in. */
export interface ResolvedTaskCloudSettings {
  readonly cpu: number;
  readonly memoryMiB: number;
  /** Always concrete: local build platform and ECS runtime platform agree. */
  readonly architecture: ContainerArchitecture;
  readonly buildTarget?: string;
}

/** A resolved service's cloud settings, with every default folded in. */
export interface ResolvedServiceCloudSettings {
  readonly cpu: number;
  readonly memoryMiB: number;
  readonly desiredCount: number;
  readonly publicLoadBalancer: boolean;
  readonly assignPublicIp: boolean;
  readonly architecture: ContainerArchitecture;
  readonly buildTarget?: string;
}

/**
 * A target's cloud settings with defaults folded in and declarations
 * canonicalized, which is both what CDK builds from and what two routes
 * sharing one target have to agree about.
 */
/** One binding as normalization stores it: authored data plus derived names. */
export type ResolvedBinding =
  | ReadSecretBinding
  | NativeGrantBinding
  | (RunsTaskBinding & { readonly environment: string })
  | (StartsWorkflowBinding & { readonly environment: string })
  | (InvokesAgentBinding & { readonly environment: string })
  | CompletesCallbackBinding;

export function getAgentInvocationBindings(bindings: readonly ResolvedBinding[]): readonly (InvokesAgentBinding & { readonly environment: string })[] {
  return bindings.filter((binding): binding is InvokesAgentBinding & { readonly environment: string } => binding.capability === "invokesAgent");
}

/** The callback completions among a target's bindings, in declaration order. */
export function getCallbackBindings(
  bindings: readonly ResolvedBinding[],
): readonly CompletesCallbackBinding[] {
  return bindings.filter(
    (binding): binding is CompletesCallbackBinding =>
      binding.capability === "completesCallback",
  );
}

/** The secret reads among a target's bindings, in declaration order. */
export function getSecretBindings(
  bindings: readonly ResolvedBinding[],
): readonly ReadSecretBinding[] {
  return bindings.filter(
    (binding): binding is ReadSecretBinding => binding.capability === "readSecret",
  );
}

/** The invocation edges among a target's bindings, in declaration order. */
export function getInvocationBindings(
  bindings: readonly ResolvedBinding[],
): readonly (InvocationBinding & { readonly environment: string })[] {
  return bindings.filter(
    (binding): binding is InvocationBinding & { readonly environment: string } =>
      isInvocationBinding(binding),
  );
}

export interface ResolvedCloudTarget {
  readonly constructId: string;
  readonly bindings: readonly ResolvedBinding[];
  readonly access: readonly CloudAccessStatement[];
  /** Input relationships checked before this workload is constructed. */
  readonly requirements: readonly ResolvedCloudRequirement[];
  /** Output specs by the value they publish: `arn` for a Lambda, `url` for a service. */
  readonly outputs: Readonly<Record<string, CloudOutputSpec>>;
  readonly manageConnections: boolean;
  /** Present only for a service target. */
  readonly service?: ResolvedServiceCloudSettings;
  /** Present only for a task target. */
  readonly task?: ResolvedTaskCloudSettings;
}

const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The target id in PascalCase: the deployed identity a target gets by default. */
export function getDefaultConstructId(id: string): string {
  return id
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function assertOutputSpec(
  spec: CloudOutputSpec,
  origin: string,
  name: string,
): CloudOutputSpec {
  if (typeof spec.id !== "string" || spec.id.trim().length === 0) {
    throw new Error(`${origin} declares cloud.outputs.${name} without an "id".`);
  }
  if (
    spec.exportName !== undefined &&
    (typeof spec.exportName !== "string" || spec.exportName.trim().length === 0)
  ) {
    throw new Error(
      `${origin} declares an empty cloud.outputs.${name}.exportName. Omit it for an output with no export.`,
    );
  }
  return spec.exportName === undefined
    ? { id: spec.id }
    : { id: spec.id, exportName: spec.exportName };
}

function assertAccessStatements(
  access: readonly CloudAccessStatement[],
  origin: string,
): readonly CloudAccessStatement[] {
  return access.map((statement, index) => {
    const where = `${origin} cloud.access[${index}]`;
    for (const field of ["actions", "resources"] as const) {
      const values = statement[field];
      if (!Array.isArray(values) || values.length === 0) {
        throw new Error(`${where} must declare at least one ${field.slice(0, -1)}.`);
      }
      for (const value of values) {
        if (typeof value !== "string" || value.trim().length === 0) {
          throw new Error(`${where} declares an empty ${field.slice(0, -1)}.`);
        }
      }
    }
    return statement;
  });
}

/**
 * Checks a requirement's shape and the kind of every reference it names.
 *
 * A condition has to select a concrete string, because it is compared to a
 * literal; a consequence may be either kind, because a missing API key handle
 * and a missing model id are the same kind of misconfiguration.
 */
function assertRequirements(
  requirements: readonly CloudRequirement[],
  origin: string,
): readonly ResolvedCloudRequirement[] {
  return requirements.map((requirement, index) => {
    const where = `${origin} cloud.requirements[${index}]`;
    if (requirement === null || typeof requirement !== "object") {
      throw new Error(`${where} is not a requirement declaration.`);
    }
    if (!Array.isArray(requirement.require) || requirement.require.length === 0) {
      throw new Error(`${where} must require at least one resource.`);
    }
    const require = requirement.require.map((reference) => {
      if (!isResourceReference(reference)) {
        throw new Error(
          `${where} requires something other than a declared resource. Name a resource from the catalog.`,
        );
      }
      return reference as ResourceReference;
    });

    if (
      requirement.message !== undefined &&
      (typeof requirement.message !== "string" ||
        requirement.message.trim().length === 0)
    ) {
      throw new Error(`${where} declares an empty "message".`);
    }

    if (requirement.when === undefined) {
      return {
        require,
        ...(requirement.message === undefined ? {} : { message: requirement.message }),
      };
    }

    const selector = requirement.when.resource;
    if (!isResourceReference(selector) || selector.kind !== "string") {
      throw new Error(
        `${where} conditions on something other than a declared string resource. A secret is a handle, not a value to compare.`,
      );
    }
    if (
      typeof requirement.when.equals !== "string" ||
      requirement.when.equals.trim().length === 0
    ) {
      throw new Error(`${where} declares an empty "when.equals".`);
    }

    return {
      when: {
        resource: selector as ResourceReference<"string">,
        equals: requirement.when.equals,
      },
      require,
      ...(requirement.message === undefined ? {} : { message: requirement.message }),
    };
  });
}

/** The one Fargate sizing rule, so a task and a service cannot disagree. */
function assertFargateSize(
  settings: { readonly cpu?: number; readonly memoryMiB?: number },
  origin: string,
): { readonly cpu: number; readonly memoryMiB: number } {
  const cpu = settings.cpu ?? 256;
  const memoryMiB = settings.memoryMiB ?? 512;
  const supported = FARGATE_CPU_MEMORY.get(cpu);
  if (!supported) {
    throw new Error(
      `${origin} declares cloud.cpu ${cpu}. Fargate supports ${[...FARGATE_CPU_MEMORY.keys()].join(", ")}.`,
    );
  }
  if (
    memoryMiB < supported.min ||
    memoryMiB > supported.max ||
    (memoryMiB - supported.min) % supported.step !== 0
  ) {
    throw new Error(
      `${origin} declares cloud.memoryMiB ${memoryMiB}, which Fargate does not pair with cloud.cpu ${cpu}. Expected ${supported.min} to ${supported.max} MiB in steps of ${supported.step}.`,
    );
  }
  return { cpu, memoryMiB };
}

function assertContainerBuildSettings(
  settings: {
    readonly architecture?: ContainerArchitecture;
    readonly buildTarget?: string;
  },
  origin: string,
): void {
  if (
    settings.architecture !== undefined &&
    !LAMBDA_ARCHITECTURES.includes(settings.architecture)
  ) {
    throw new Error(
      `${origin} declares cloud.architecture "${settings.architecture}". Expected ${LAMBDA_ARCHITECTURES.join(" or ")}.`,
    );
  }
  if (settings.buildTarget !== undefined && settings.buildTarget.trim().length === 0) {
    throw new Error(`${origin} declares an empty cloud.buildTarget.`);
  }
}

/**
 * A task's sizing and build settings, with every default folded in.
 *
 * Tasks and services inherit an explicit defaults.container.architecture,
 * falling back to x86_64. An image is built once and scheduled somewhere else,
 * so the build host must never choose its runtime architecture.
 */
function assertTaskCloudSettings(
  settings: TaskCloudSettings,
  origin: string,
  containerDefault?: ContainerArchitecture,
): ResolvedTaskCloudSettings {
  for (const field of ["desiredCount", "publicLoadBalancer", "assignPublicIp"] as const) {
    rejectObsoleteField(
      settings,
      field,
      `${origin}.cloud`,
      "A task runs to completion and is never load balanced or maintained at a count.",
    );
  }
  const { cpu, memoryMiB } = assertFargateSize(settings, origin);
  assertContainerBuildSettings(settings, origin);
  return {
    cpu,
    memoryMiB,
    architecture: settings.architecture ?? containerDefault ?? "x86_64",
    ...(settings.buildTarget === undefined
      ? {}
      : { buildTarget: settings.buildTarget }),
  };
}

function assertServiceCloudSettings(
  settings: ServiceCloudSettings,
  origin: string,
  containerDefault?: ContainerArchitecture,
): ResolvedServiceCloudSettings {
  const { cpu, memoryMiB } = assertFargateSize(settings, origin);

  const desiredCount = settings.desiredCount ?? 1;
  if (!Number.isInteger(desiredCount) || desiredCount < 0) {
    throw new Error(
      `${origin} must declare cloud.desiredCount as a non-negative integer.`,
    );
  }

  assertContainerBuildSettings(settings, origin);

  return {
    cpu,
    memoryMiB,
    desiredCount,
    publicLoadBalancer: settings.publicLoadBalancer ?? false,
    assignPublicIp: settings.assignPublicIp ?? true,
    architecture: settings.architecture ?? containerDefault ?? "x86_64",
    ...(settings.buildTarget === undefined
      ? {}
      : { buildTarget: settings.buildTarget }),
  };
}

/**
 * The authored `cloud` section with defaults applied, or the all-defaults
 * section when none was written.
 *
 * Pure: nothing here resolves a resource
 * value or touches CDK, which is what lets the browser-safe module fold in
 * defaults and compare two declarations of one target.
 */
export function resolveTargetSettings(
  id: string,
  role: TargetRole,
  declaration: ServiceEnvironment & {
    readonly cloud?:
      | HttpCloudSettings
      | EventCloudSettings
      | WebSocketCloudSettings
      | ServiceCloudSettings
      | TaskCloudSettings
      | WorkflowCloudSettings;
  },
  origin: string,
  containerDefault?: ContainerArchitecture,
): ResolvedTargetSettings {
  const cloud = declaration.cloud ?? {};
  for (const key of ["environment", "secrets"] as const) {
    rejectObsoleteField(cloud, key, `${origin}.cloud`, `Declare "${key}" directly on the target.`);
  }

  if (cloud.constructId !== undefined && cloud.constructId.trim().length === 0) {
    throw new Error(`${origin} declares an empty cloud.constructId.`);
  }

  /** Which declaration already owns an environment name, so a clash names both. */
  const owners = new Map<string, string>();
  const claimName = (name: string, owner: string, framework = false): void => {
    if (!ENVIRONMENT_NAME_PATTERN.test(name)) {
      throw new Error(
        `${origin} declares ${owner} "${name}", which is not a valid environment name.`,
      );
    }
    // Derived names are claimed through the same map as authored ones, so a
    // collision between two projections is reported the same way as a collision
    // between two declarations - naming both owners.
    if (!framework && isFrameworkOwnedEnvironmentName(name)) {
      throw new Error(
        `${origin} declares ${owner} "${name}", which the framework writes for invocation bindings and task input. Remove it.`,
      );
    }
    const existing = owners.get(name);
    if (existing) {
      throw new Error(
        `${origin} declares environment "${name}" in both ${existing} and ${owner}. One name has one owner.`,
      );
    }
    owners.set(name, owner);
  };

  const isLambda = role !== "service" && role !== "task" && role !== "workflow" && role !== "agent";
  const isContainer = role === "service" || role === "task";
  const environment: Record<string, string | ResourceReference> = {};
  /** ARN reads found in `environment`, which become this target's grants. */
  const secretReads: { readonly name: string; readonly secret: ResourceReference }[] = [];
  for (const [name, value] of Object.entries(declaration.environment ?? {})) {
    claimName(name, "environment");
    if (
      isLambda &&
      (RESERVED_LAMBDA_ENVIRONMENT_KEYS as readonly string[]).includes(name)
    ) {
      throw new Error(
        `${origin} declares environment "${name}", which Lambda reserves for its own runtime. Remove it.`,
      );
    }
    if (role === "workflow") {
      throw new Error(
        `${origin} declares environment "${name}". A workflow has no process of its own; declare it on the target the workflow invokes.`,
      );
    }
    if (isContainer && reservedContainerEnvironment(role).includes(name)) {
      throw new Error(
        `${origin} declares environment "${name}", which the framework sets from the deploying stack or the resolved port. Remove it.`,
      );
    }
    if (isResourceReference(value)) {
      if (value.kind !== "string") {
        const secret = `resources.${value.path.join(".")}`;
        throw new Error(
          value.secretField === undefined
            ? `${origin} declares environment "${name}" as ${formatResourceReference(value)}, which is a ${value.kind} resource. A secret's value never belongs in an environment variable. Use ${secret}.arn to read the secret yourself, or declare it under "secrets" to have the value injected at startup.`
            : `${origin} declares environment "${name}" as ${formatResourceReference(value)}. A key of a secret is still the secret's contents, which never belongs in an environment variable. Move the entry to "secrets" to have that key injected at startup, or read ${secret}.arn and take the key in the workload.`,
        );
      }
      // Reading a secret's ARN is the one environment entry that also needs a
      // permission, so the grant is derived from the same line rather than
      // authored beside it: a workload told where a secret lives but unable to
      // read it is broken exactly like one granted access it cannot use.
      if (isSecretArnReference(value)) secretReads.push({ name, secret: value });
      environment[name] = value;
      continue;
    }
    if (typeof value !== "string") {
      throw new Error(
        `${origin} declares environment "${name}" as ${value === null ? "null" : typeof value}. Environment values are strings or resource references.`,
      );
    }
    environment[name] = value;
  }

  const bindings: ResolvedBinding[] = [];
  const declaredBindings = (cloud as CloudTargetSettings).bindings ?? [];
  if (role === "workflow" && declaredBindings.length > 0) {
    throw new Error(
      `${origin} declares cloud.bindings. A workflow derives its outgoing permissions from the targets its graph names; there is no second list to keep in step.`,
    );
  }
  for (const [index, binding] of declaredBindings.entries()) {
    const where = `cloud.bindings[${index}]`;
    if (binding === null || typeof binding !== "object") {
      throw new Error(
        `${origin} declares an unsupported ${where}. Use runsTask(...), startsWorkflow(...) or completesCallback(...).`,
      );
    }

    if (binding.capability === "nativeGrant") {
      if (!isCdkResource(binding.resource) || !binding.resource.path.length || !/^grant[A-Za-z]*$/.test(binding.method)) {
        throw new Error(`${origin} ${where} is not a grant on a catalog resource.`);
      }
      assertJsonArguments(binding.arguments, `${origin} ${where}`);
      bindings.push(binding);
      continue;
    }
    if (binding.capability === "invokesAgent") {
      if (typeof binding.agent !== "string" || !TARGET_ID_PATTERN.test(binding.agent)) {
        throw new Error(
          `${origin} declares ${where} against "${String(binding.agent)}", which is not a kebab-case agent id.`,
        );
      }
      if (binding.environment !== undefined) {
        throw new Error(
          `${origin} declares ${where} with an "environment". Its descriptor name is derived from the agent id; remove it.`,
        );
      }
      const environment = descriptorEnvironmentName("agent", binding.agent);
      claimName(environment, where, true);
      bindings.push({ capability: "invokesAgent", agent: binding.agent, environment });
      continue;
    }
    if (binding.capability === "runsTask" || binding.capability === "startsWorkflow") {
      const kind = binding.capability === "runsTask" ? "task" : "workflow";
      const id = binding.capability === "runsTask" ? binding.task : binding.workflow;
      if (typeof id !== "string" || !TARGET_ID_PATTERN.test(id)) {
        throw new Error(
          `${origin} declares ${where} against "${String(id)}", which is not a kebab-case ${kind} id.`,
        );
      }
      if (binding.environment !== undefined) {
        throw new Error(
          `${origin} declares ${where} with an "environment". Its descriptor name is derived from the target id; remove it.`,
        );
      }
      // Whether the destination exists, is enabled in the same lane, and does
      // not close a cycle is a whole-config question, answered once every
      // target has been claimed - see assertInvocationEdges.
      const environment = descriptorEnvironmentName(kind, id);
      claimName(environment, where, true);
      bindings.push(
        binding.capability === "runsTask"
          ? { capability: "runsTask", task: id, environment }
          : { capability: "startsWorkflow", workflow: id, environment },
      );
      continue;
    }

    if (binding.capability === "completesCallback") {
      const integration = (binding as { readonly integration?: unknown }).integration;
      if (
        typeof integration !== "string" ||
        !/^[a-zA-Z]+:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(integration)
      ) {
        throw new Error(
          `${origin} declares ${where} against "${String(integration)}", which is not an integration reference.`,
        );
      }
      if (role === "workflow") {
        throw new Error(
          `${origin} declares ${where}. A workflow sends callbacks; it does not complete them.`,
        );
      }
      // No environment name: a completion is routed by the worker's own
      // framework-issued environment and the handle in the message.
      bindings.push({ capability: "completesCallback", integration });
      continue;
    }

    // `readSecret(...)` was how a secret read used to be authored. The union
    // above no longer has a member for it, so it arrives here as an
    // unrecognized binding — named for what it was, because that is what the
    // author wrote and what they have to replace.
    const retired = binding as { readonly capability?: unknown; readonly secret?: unknown };
    if (retired.capability === "readSecret") {
      const named = isResourceReference(retired.secret)
        ? `${formatResourceReference(retired.secret)}.arn`
        : "resources.<secret>.arn";
      throw new Error(
        `${origin} declares ${where} as a secret read, which is no longer a binding. Write environment: { NAME: ${named} } instead, and the grant comes with it.`,
      );
    }
    throw new Error(
      `${origin} declares an unsupported ${where}. Use runsTask(...), startsWorkflow(...) or completesCallback(...).`,
    );
  }

  // Derived from the environment entries above, in the order they were
  // written, so a target's grants read in the order its inputs do.
  //
  // The binding names the *secret*, not the projection: what it carries is the
  // grant, and a grant is on a secret. Dropping `secretArn` turns the
  // projection back into the entry it came from — same path, same graphs, same
  // owner — so the binding resolves to a handle while the environment entry
  // beside it resolves to that handle's ARN.
  for (const read of secretReads) {
    const { secretArn: _projection, ...secret } = read.secret;
    bindings.push({
      capability: "readSecret",
      secret: { ...secret, kind: "secret" },
      environment: read.name,
    });
  }

  const secrets: Record<string, ResourceReference> = {};
  for (const [name, entry] of Object.entries(declaration.secrets ?? {})) {
    if (!ENVIRONMENT_NAME_PATTERN.test(name)) {
      throw new Error(`${origin} declares secrets "${name}", which is not a valid environment name.`);
    }
    if (!isResourceReference(entry)) {
      throw new Error(
        `${origin} declares secrets "${name}" as a literal. Name a secret from the catalog, declared with resource.secret().`,
      );
    }
    if (isSecretArnReference(entry)) {
      throw new Error(
        `${origin} declares secrets "${name}" as ${formatResourceReference(entry)}. Startup injection takes the secret itself; drop the ".arn", or move the entry to "environment" to read the ARN instead.`,
      );
    }
    if (entry.kind !== "secret") {
      throw new Error(
        `${origin} declares secrets "${name}" as ${formatResourceReference(entry)}, which is a ${entry.kind} resource. Declare it with resource.secret().`,
      );
    }
    secrets[name] = entry;
  }

  if (!isContainer && Object.keys(secrets).length > 0) {
    throw new Error(
      role === "workflow"
        ? `${origin} declares startup secrets on a workflow, which has no process to start. Declare them on the target it invokes.`
        : role === "agent"
          ? `${origin} declares secrets. AgentCore Runtime has no startup secret injection; write environment: { NAME: resources.<secret>.arn } and read the secret in the agent, which also grants the read.`
          : `${origin} declares startup secrets on a Lambda, which has no startup the ECS agent can inject into. Write environment: { NAME: resources.<secret>.arn } and read the secret in the handler.`,
    );
  }
  const service = role === "service"
    ? assertServiceCloudSettings(cloud as ServiceCloudSettings, origin, containerDefault)
    : undefined;
  const task = role === "task"
    ? assertTaskCloudSettings(cloud as TaskCloudSettings, origin, containerDefault)
    : undefined;
  for (const name of Object.keys(secrets)) {
    claimName(name, "secrets");
    if (reservedContainerEnvironment(role).includes(name)) {
      throw new Error(`${origin} declares secrets "${name}", which the framework owns.`);
    }
  }

  const manageConnections =
    (cloud as WebSocketCloudSettings).manageConnections === true;
  if (manageConnections && role !== "webSocket") {
    throw new Error(
      `${origin} declares cloud.manageConnections, which only a WebSocket message route can use. An authorizer answers the handshake and never pushes to a connection.`,
    );
  }

  const declaredOutputs = (cloud as { readonly outputs?: Record<string, unknown> })
    .outputs;
  const allowedOutputs =
    role === "service"
      ? ["url"]
      : role === "task"
        ? ["taskDefinitionArn"]
        : ["arn"];
  const outputs: Record<string, CloudOutputSpec> = {};
  for (const [name, spec] of Object.entries(declaredOutputs ?? {})) {
    if (!allowedOutputs.includes(name)) {
      throw new Error(
        `${origin} declares cloud.outputs.${name}. A ${role} target publishes ${allowedOutputs.join(", ")}.`,
      );
    }
    outputs[name] = assertOutputSpec(spec as CloudOutputSpec, origin, name);
  }

  return {
    environment,
    secrets,
    cloud: {
      constructId: cloud.constructId ?? getDefaultConstructId(id),
      // Keep declaration order for deployed IAM and bindings. Compare route
      // agreement using canonicalizeCloudTarget instead of reordering output.
      bindings,
      access: assertAccessStatements(
        (cloud as CloudTargetSettings).access ?? [],
        origin,
      ),
      requirements: assertRequirements(
        (cloud as CloudTargetSettings).requirements ?? [],
        origin,
      ),
      outputs,
      manageConnections,
      ...(service ? { service } : {}),
      ...(task ? { task } : {}),
    },
  };
}

/** The names the framework owns on a container target, by role. */
function reservedContainerEnvironment(role: TargetRole): readonly string[] {
  return role === "task"
    ? [...RESERVED_TASK_CLOUD_ENVIRONMENT_KEYS, ...RESERVED_LOCAL_ENVIRONMENT_KEYS]
    : [...RESERVED_SERVICE_CLOUD_ENVIRONMENT_KEYS, ...RESERVED_LOCAL_ENVIRONMENT_KEYS];
}

/**
 * A target's cloud settings in a form two declarations can be compared in.
 *
 * Ordering that AWS does not distinguish — the order bindings were listed in,
 * the order of actions within one statement — is normalized away, so two routes
 * writing the same requirements differently are recognized as agreeing rather
 * than reported as a conflict.
 */
function bindingSortKey(binding: ResolvedBinding): string {
  if (binding.capability === "nativeGrant") return JSON.stringify(binding);
  return binding.capability === "completesCallback"
    ? `completesCallback:${binding.integration}`
    : binding.environment;
}

export function canonicalizeCloudTarget(cloud: ResolvedCloudTarget): unknown {
  return {
    ...cloud,
    // Sorted by the name each binding is recognised by: the environment it
    // injects, or — for a binding that injects none — the integration it
    // answers for.
    bindings: [...cloud.bindings].sort((left, right) =>
      bindingSortKey(left).localeCompare(bindingSortKey(right)),
    ),
    access: cloud.access
      .map((statement) => ({
        actions: [...statement.actions].sort(),
        resources: [...statement.resources].sort(),
      }))
      .sort((left, right) =>
        left.actions.join(",").localeCompare(right.actions.join(",")),
      ),
    // Two routes asking for the same requirements in either order agree; the
    // resolved target keeps the authored order, because that is the order the
    // diagnostics come out in.
    requirements: cloud.requirements
      .map((requirement) => ({
        ...requirement,
        require: [...requirement.require].sort((left, right) =>
          left.path.join(".").localeCompare(right.path.join(".")),
        ),
      }))
      .sort((left, right) => canonicalKey(left).localeCompare(canonicalKey(right))),
  };
}

function canonicalKey(requirement: ResolvedCloudRequirement): string {
  return [
    requirement.when
      ? `${requirement.when.resource.path.join(".")}=${requirement.when.equals}`
      : "",
    requirement.require.map((reference) => reference.path.join(".")).join(","),
    requirement.message ?? "",
  ].join("|");
}

/** One binding with its referenced secret resolved to a real handle. */
export interface ResolvedCloudBinding {
  readonly capability: "readSecret";
  readonly environment: string;
  readonly secret: SecretHandle;
}

/**
 * A target's cloud declarations with every reference replaced by the value the
 * composition root supplied.
 *
 * References that are inactive in this graph drop out entirely rather than
 * resolving to an empty string, which is what keeps a prod-only database out of
 * the dev stack's environment and off its role.
 */
export interface ResolvedCloudValues {
  readonly environment: Readonly<Record<string, string>>;
  readonly bindings: readonly ResolvedCloudBinding[];
  readonly secrets: Readonly<Record<string, ResolvedStartupSecret>>;
}

/**
 * One secret a container is started with, and how much of it to hand over.
 *
 * The handle and the key are separate because they are answered by different
 * parties: the handle is what the composition root supplied or the sync
 * document recorded, and the key is what the declaration asked for. Keeping
 * them apart is what lets two entries share one imported secret construct while
 * reading different fields of it.
 */
export interface ResolvedStartupSecret {
  readonly handle: SecretHandle;
  /** JSON key inside the secret, when a `.field()` projection selected one. */
  readonly field?: string;
}

/**
 * Resolves one target's cloud declarations against the supplied resource
 * values. Called where AWS resources are constructed, never at config import.
 */
export function resolveCloudValues(
  target: NormalizedTarget,
  resolve: ResourceResolver,
  origin: string,
): ResolvedCloudValues {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(target.environment)) {
    if (typeof value === "string") {
      environment[name] = value;
      continue;
    }
    const resolved = resolveResourceReference(value, resolve, origin);
    if (resolved === undefined) continue;
    environment[name] = resolved as string;
  }

  const bindings: ResolvedCloudBinding[] = [];
  // Invocation bindings are deliberately absent: an edge resolves against the
  // handle of a target this graph builds, not against a supplied resource
  // value, so it is projected where that handle exists.
  //
  // The ARN itself is already in `environment` — its reference resolved in the
  // loop above like any other string. What is left is the grant that has to go
  // with it, which is what this binding carries.
  for (const binding of getSecretBindings(target.cloud.bindings)) {
    if (environment[binding.environment] === undefined) continue;
    const resolved = resolveResourceReference(binding.secret, resolve, origin);
    if (resolved === undefined) continue;
    bindings.push({
      capability: "readSecret",
      environment: binding.environment,
      secret: resolved as SecretHandle,
    });
  }

  // One branch, because a secret resolves the same way whoever supplied it:
  // an authored secret became an ARN parameter, and a stack's became its
  // linked construct. Absent rather than blank, so a secret this deployment
  // does not hold is a variable the container never sees — which its own
  // startup check can tell apart from one that arrived empty. Whether that
  // absence is allowed was settled by assertRequirementsMet.
  const secrets: Record<string, ResolvedStartupSecret> = {};
  for (const [name, entry] of Object.entries(target.secrets)) {
    const resolved = resolveResourceReference(entry, resolve, origin);
    if (resolved === undefined) continue;
    secrets[name] = {
      handle: resolved as SecretHandle,
      ...(entry.secretField === undefined ? {} : { field: entry.secretField }),
    };
  }

  return { environment, bindings, secrets };
}

/** A container service, mounted at the public route that keys it. */
export interface ServiceTargetDefinition<Catalog = AnyResourceCatalog>
  extends HttpBindingSpec, ServiceEnvironment<Catalog> {
  /**
   * Implementation directory, rooted at `cdk-app`.
   * @example "/ecs_containers/services/example-service"
   */
  readonly directory: SuggestedServiceDirectory;
  /** Stable target id. Defaults to the directory's final segment. */
  readonly id?: string;
  /**
   * Container port used locally and in ECS. Falls back to one unambiguous
   * Dockerfile `EXPOSE` instruction.
   */
  readonly port?: number;
  /** Relative health-check path exposed by the service, such as `/health`. */
  readonly healthCheckPath?: string;
  /** Where this service runs. For example, `"local-only"` keeps an expensive ECS service out of AWS. */
  readonly deploy?: DeploySetting;

  /**
   * How this service is deployed to ECS: sizing, networking, its runtime
   * environment, startup secrets and task-role permissions. Applies to the
   * deployed service only — docker-compose.yml is what runs
   * on a developer's machine.
   */
  readonly cloud?: ServiceCloudSettings<Catalog>;
}

/**
 * A container that runs to completion, keyed by stable target id.
 *
 * Tasks are to services what events are to http: the same inventory and the
 * same identity rules, without a route to be keyed by. An entry that needs
 * nothing special is one line - its directory defaults to
 * `/ecs_containers/tasks/<id>`, exactly as an `events` entry defaults into the
 * event grouping directory.
 */
export interface TaskLocalSpec {
  /**
   * Local facilities a run needs, resolved before the launch is accepted.
   *
   * Deliberately narrower than a service's `local` block: a task always builds
   * and runs its own Dockerfile, so there is no preset to choose, and it runs
   * to completion, so there is no readiness edge to declare.
   */
  readonly resources?: readonly LocalServiceResource[];
}

/** A task's local section with defaults folded in. Never undefined. */
export interface ResolvedTaskLocalSpec {
  readonly resources: readonly LocalServiceResource[];
}

export function resolveTaskLocalSpec(
  definition: { readonly local?: TaskLocalSpec },
  origin: string,
): ResolvedTaskLocalSpec {
  const local = definition.local ?? {};
  for (const key of ["preset", "buildTarget", "dependsOn"] as const) {
    rejectObsoleteField(
      local,
      key,
      `${origin}.local`,
      key === "buildTarget"
        ? "A task's build stage is declared under cloud, beside its sizing."
        : "A task builds and runs its own Dockerfile to completion; there is no preset or readiness edge.",
    );
  }
  const resources = local.resources ?? [];
  const seen = new Set<string>();
  for (const resource of resources) {
    if (!(LOCAL_SERVICE_RESOURCES as readonly string[]).includes(resource)) {
      throw new Error(
        `${origin} requests local resource "${resource}". Expected ${LOCAL_SERVICE_RESOURCES.join(" or ")}.`,
      );
    }
    if (seen.has(resource)) {
      throw new Error(`${origin} requests local resource "${resource}" twice.`);
    }
    seen.add(resource);
  }
  return { resources: [...resources] };
}

export interface TaskTargetDefinition<Catalog = AnyResourceCatalog>
  extends ServiceEnvironment<Catalog> {
  /**
   * How a run is provisioned on a developer's machine. Omitted entirely, the
   * container gets its declared environment and startup secrets and nothing else.
   */
  readonly local?: TaskLocalSpec;
  /**
   * Implementation directory, rooted at `cdk-app`. Defaults to
   * `/ecs_containers/tasks/<id>`; declare it to keep identity when the source
   * lives elsewhere.
   */
  readonly directory?: SuggestedTaskDirectory;
  /**
   * Where this task exists. A task is started by a developer - a route handler,
   * a test, a workflow you start - so a dev deployment builds none of them and
   * Docker Compose owns the container instead. In a prod deployment this token
   * is the whole answer.
   */
  readonly deploy?: DeploySetting;
  /** Sizing, architecture, build stage, bindings, access and requirements. */
  readonly cloud?: TaskCloudSettings<Catalog>;
}

/** A resolved task: its settings with defaults folded in. */
export interface ResolvedTaskTarget extends ResolvedTargetEnvironment {
  readonly id: string;
  readonly reference: TaskTarget;
  readonly directory: FrameworkDirectory;
  readonly cloud: ResolvedTaskCloudSettings;
  readonly local: ResolvedTaskLocalSpec;
  readonly deploy: DeploySetting;
}

interface ResolvedLambdaBase {
  readonly id: string;
  readonly reference: LambdaTarget;
  readonly directory: FrameworkDirectory;
  readonly architecture: LambdaArchitecture;
  readonly memorySize: number;
  readonly timeoutSeconds: number;
  readonly logRetentionDays: number;
  readonly localReplay?: true;
}

/**
 * A fully-resolved Lambda spec: defaults merged with the per-target override.
 *
 * Discriminated on `packaging` so a container branch cannot reach for a
 * `runtime` that lives in a Dockerfile.
 */
export type ResolvedLambdaTarget =
  | (ResolvedLambdaBase & {
      readonly packaging: "zip";
      readonly runtime: LambdaRuntime;
      readonly handler: string;
      readonly bundling: { readonly minify: boolean; readonly sourceMap: boolean };
    })
  | (ResolvedLambdaBase & { readonly packaging: "container" });

export interface ResolvedServiceTarget extends ResolvedTargetEnvironment {
  readonly id: string;
  readonly reference: ServiceTarget;
  readonly directory: FrameworkDirectory;
  readonly port?: number;
  readonly healthCheckPath?: string;

}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** What a route binding says about itself. Its public path is the object key. */
export interface HttpBindingSpec {
  /**
   * HTTP methods handled at this route. `"*"` means API Gateway `ANY` and all
   * supported methods in local development.
   */
  readonly methods: "*" | readonly [HttpMethod, ...HttpMethod[]];
  /** Attach the HTTP Cognito authorizer. Omit for a public route. */
  readonly auth?: true;
}

/**
 * API Gateway route key. The three special keys autocomplete; any custom action
 * name is allowed.
 *
 * The literal union — rather than a bare `string` — is also what keeps an authored
 * key from widening under `satisfies` in `framework.config.ts`, which the
 * {@link WebSocketRouteKey} projection depends on.
 */
export type WebSocketRouteName =
  | "$connect"
  | "$disconnect"
  | "$default"
  | (string & {});

/** WebSocket route keys API Gateway defines itself. Everything else is a message action. */
export const WEBSOCKET_RESERVED_ROUTES = [
  "$connect",
  "$disconnect",
  "$default",
] as const;

/**
 * The Lambda that authorizes a WebSocket handshake, declared on the route it
 * guards instead of standing on its own.
 *
 * An authorizer has no route of its own — it is only ever reachable through
 * `$connect` — so nesting it here is what says that, and the connect route
 * reads as the whole story of how a connection is accepted.
 *
 * This is the authorizer Lambda's only declaration, so its directory and build
 * overrides live here too, and it inherits `defaults.webSocket` like every
 * other handler in the section.
 */
export type WebSocketAuthorizerSpec<Catalog = AnyResourceCatalog> =
  LambdaTargetDefinition &
    TargetEnvironment<Catalog> &
    LambdaSourceSpec & {
      /** Where the authorizer Lambda is deployed. */
      readonly deploy?: DeploySetting;
      /** What the authorizer needs in order to run in AWS. */
      readonly cloud?: WebSocketCloudSettings<Catalog>;
    };

/** A projected route: its public path plus the target identity runtime consumers need. */
export interface HttpRouteDefinition extends HttpBindingSpec {
  /**
   * Absolute public path, exactly as authored. A terminal `/*` catch-all is
   * supported only for a service, where the public prefix is stripped before
   * proxying.
   */
  readonly path: string;
  /** Whether the route is served by a Lambda or by a container service. */
  readonly type: TargetKind;
  /** Canonical target id, which is independent of this path. */
  readonly target: string;
  /** Implementation directory of the target behind this route. */
  readonly directory: FrameworkDirectory;
  /** Where this binding was authored, for diagnostics. */
  readonly origin: string;
}

/** A projected WebSocket route: its API Gateway route key and the Lambda behind it. */
export interface WebSocketRouteDefinition {
  readonly routeKey: string;
  readonly target: LambdaTarget;
  readonly authorizer?: LambdaTarget;
  readonly origin: string;
}

/** The ways a Lambda can be invoked, and the config section for each. */
export type LambdaSection = "http" | "webSocket" | "events" | "tools";

/**
 * Defaults, cascading. A target inherits `lambda`, then its section's overrides,
 * then whatever it declares itself — so "every WebSocket handler is 3 seconds"
 * is said once, and an entry contains only what makes it different.
 */
export interface FrameworkDefaults {
  /** Baseline inherited by every framework-built Lambda. */
  readonly lambda: LambdaDefaults;
  /** Architecture for every task and service that does not declare its own. */
  readonly container?: { readonly architecture?: ContainerArchitecture };
  /** Overrides applied to every Lambda in the `http` section. */
  readonly http?: LambdaTargetDefinition;
  /** Overrides applied to every Lambda in the `webSocket` section. */
  readonly webSocket?: LambdaTargetDefinition;
  /** Overrides applied to every Lambda in the `events` section. */
  readonly events?: LambdaTargetDefinition;
  /** Overrides applied to every Lambda in the `tools` section. */
  readonly tools?: LambdaTargetDefinition;
}

// ---------------------------------------------------------------------------
// Authoring types
//
// These are what framework.config.ts is written against. `http` and `services`
// are keyed by the public route, `webSocket` by the API Gateway route key, and
// `events` by target identity — a Lambda AWS invokes directly has no route to
// be keyed by.
//
// FrameworkConfig below stays structural (plain string keys) because every
// consumer — CDK stacks, dev servers, tests — reads a config rather than
// authoring one, and must keep working with synthetic fixtures.
// ---------------------------------------------------------------------------

/**
 * Lambdas reached over the HTTP API, keyed by their public path.
 *
 * The catalog view parameter is what ties an entry's resource references to the
 * provider contract its stack is constructed with: `FrameworkHttp<HttpCatalog>`
 * rejects a reference to a resource outside `HttpCatalog`, so widening one
 * widens the other rather than letting the two drift.
 */
export type FrameworkHttp<Catalog = AnyResourceCatalog> = Readonly<
  Record<FrameworkDirectory, HttpLambdaTargetDefinition<Catalog>>
>;

/** Lambdas behind the WebSocket API, keyed by API Gateway route key. */
export type FrameworkWebSocket<Catalog = AnyResourceCatalog> = Readonly<
  Record<WebSocketRouteName, WebSocketLambdaTargetDefinition<Catalog>>
>;

/** Complete event Lambda inventory, keyed by stable target id. */
export type FrameworkEvents<Catalog = AnyResourceCatalog> = Readonly<
  Record<string, EventLambdaTargetDefinition<Catalog>>
>;

/** Container services, keyed by the public path they are mounted at. */
export type FrameworkServices<Catalog = AnyResourceCatalog> = Readonly<
  Record<FrameworkDirectory, ServiceTargetDefinition<Catalog>>
>;

/** Complete container-task inventory, keyed by stable target id. */
export type FrameworkTasks<Catalog = AnyResourceCatalog> = Readonly<
  Record<string, TaskTargetDefinition<Catalog>>
>;

/**
 * Workflow graphs, keyed by stable target id.
 *
 * No catalog view parameter: a workflow references other targets rather than
 * resources, and has no process environment or startup secrets to bind.
 */
export type FrameworkWorkflows = Readonly<Record<string, WorkflowDefinition>>;

/**
 * The whole application, grouped by how each target is invoked.
 *
 * A routed target has to be here — a Lambda reaches the HTTP or WebSocket API
 * only because this file says so. Every event and service is explicit too.
 * `npm run framework:generate` checks both missing declarations and missing sources.
 */
export interface FrameworkConfig {
  /**
   * The application's resource catalog: what its workloads need from the rest
   * of the system, declared once. Optional so a synthetic fixture that
   * references nothing does not have to write it.
   */
  readonly resources?: ResourceDeclarationGroup;
  /** Cascading defaults inherited by every Lambda. */
  readonly defaults: FrameworkDefaults;
  /** Lambdas reached over the HTTP API, keyed by their public path. */
  readonly http: Readonly<Record<string, HttpLambdaTargetDefinition>>;
  /** Lambdas behind the WebSocket API, keyed by API Gateway route key. */
  readonly webSocket: Readonly<Record<string, WebSocketLambdaTargetDefinition>>;
  /** Lambdas AWS invokes directly, keyed by stable target id. */
  readonly events: Readonly<Record<string, EventLambdaTargetDefinition>>;
  /** Container services, keyed by the public path they are mounted at. */
  readonly services: Readonly<Record<string, ServiceTargetDefinition>>;
  /**
   * Containers that run to completion, keyed by stable target id. Optional so
   * the many synthetic fixtures that predate this section keep working.
   */
  readonly tasks?: Readonly<Record<string, TaskTargetDefinition>>;
  /** Orchestration of declared events and tasks, keyed by stable target id. */
  readonly workflows?: Readonly<Record<string, WorkflowDefinition>>;
  /** Lambdas an agent calls through its Gateway, keyed by stable target id. */
  readonly tools?: FrameworkTools;
  /** AgentCore Runtime agents, keyed by stable target id. */
  readonly agents?: FrameworkAgents;
}

// ---------------------------------------------------------------------------
// Composition
//
// A section may be authored as one map or as the list of modules composed into
// it, so an application can file each architecture in its own file and add
// another without touching the ones already there. The array shape exists only
// here, at the authoring boundary: `defineFrameworkConfig` merges it away, and
// every consumer downstream still reads the plain `FrameworkConfig` above.
//
// Merging is what makes the array safe where an object spread is not. A spread
// resolves `{ ...a, ...b }` to one object before anything can look at it, so a
// key declared twice is already gone; the modules arrive here separately, so a
// collision is an error that can name both of them.
// ---------------------------------------------------------------------------

/** One section, or the modules composed into it. */
export type SectionInput<Section> = Section | readonly Section[];

/** What `defineFrameworkConfig` accepts: {@link FrameworkConfig} with composable sections. */
export interface FrameworkConfigInput {
  readonly resources?: ResourceDeclarationGroup;
  readonly defaults: FrameworkDefaults;
  readonly http: SectionInput<Readonly<Record<string, HttpLambdaTargetDefinition>>>;
  readonly webSocket: SectionInput<
    Readonly<Record<string, WebSocketLambdaTargetDefinition>>
  >;
  readonly events: SectionInput<Readonly<Record<string, EventLambdaTargetDefinition>>>;
  readonly services: SectionInput<Readonly<Record<string, ServiceTargetDefinition>>>;
  readonly tasks?: SectionInput<Readonly<Record<string, TaskTargetDefinition>>>;
  readonly workflows?: SectionInput<Readonly<Record<string, WorkflowDefinition>>>;
  readonly tools?: SectionInput<FrameworkTools>;
  readonly agents?: SectionInput<FrameworkAgents>;
}

type UnionToIntersection<Union> = (
  Union extends unknown ? (value: Union) => void : never
) extends (value: infer Intersection) => void
  ? Intersection
  : never;

/**
 * A composed section as the one map it becomes.
 *
 * An intersection rather than a union: `keyof (A & B)` is every key both
 * modules declare, and `(A & B)["/graphql"]` still resolves to the module that
 * declares it, so the literal route keys the projections below are built from
 * survive composition.
 *
 * The empty object seeds the intersection, because an empty section is a real
 * thing to write and `UnionToIntersection<never>` is `unknown` — which is not a
 * section at all, and would collapse the whole config type.
 */
type Flatten<Section> = Section extends readonly (infer Module)[]
  ? UnionToIntersection<Module | Record<never, never>>
  : Section;

type FlattenedConfig<Input> = {
  readonly [Key in keyof Input]: Key extends
    | "http"
    | "webSocket"
    | "events"
    | "services"
    | "tasks"
    | "workflows"
    | "tools"
    | "agents"
    ? Flatten<Input[Key]>
    : Input[Key];
};

/** A directory's final path segment, which is a target's default id. */
type LastSegment<Path extends string> = Path extends `${string}/${infer Rest}`
  ? LastSegment<Rest>
  : Path;

/** The id a declaration resolves to: its own `id`, else its directory's basename. */
type DeclaredTargetId<Spec> = Spec extends { readonly id: infer Id extends string }
  ? Id
  : Spec extends { readonly directory: infer Directory extends string }
    ? LastSegment<Directory>
    : never;

/** The authored sections merged without inventing additional workloads. */
export type ComposedFrameworkConfig<Input> = Input extends FrameworkConfigInput
  ? FlattenedConfig<Input>
  : never;

/**
 * One authored section as the map every consumer reads, rejecting a key two
 * modules both declare.
 *
 * The key is kept rather than overwritten because either choice is wrong: the
 * config is the only statement of what a route is, so two answers to that is a
 * question for whoever wrote them, not something to resolve by declaration
 * order.
 */
function mergeSection<Entry>(
  section: string,
  value: SectionInput<Readonly<Record<string, Entry>>>,
): Readonly<Record<string, Entry>> {
  if (!Array.isArray(value)) return value as Readonly<Record<string, Entry>>;
  const parts = value as readonly Readonly<Record<string, Entry>>[];
  const merged: Record<string, Entry> = {};
  const declaredAt = new Map<string, number>();
  parts.forEach((part, index) => {
    for (const [key, entry] of Object.entries(part)) {
      const first = declaredAt.get(key);
      if (first !== undefined) {
        throw new Error(
          `${section} declares "${key}" twice: ${section}[${first}] and ${section}[${index}] both define it. A key may be declared by one module only.`,
        );
      }
      declaredAt.set(key, index);
      merged[key] = entry;
    }
  });
  return merged;
}

/**
 * Defines the application framework config with contextual IntelliSense while
 * preserving literal route keys, methods, directories, and WebSocket route keys
 * for generated TypeScript contracts.
 *
 * Composition merges declarations only; source discovery never adds workloads.
 */
export function defineFrameworkConfig<const Input extends FrameworkConfigInput>(
  input: Input,
): ComposedFrameworkConfig<Input> {
  if ("gateways" in input) {
    throw new Error(
      "gateways is no longer a section. An agent's Gateway is derived from its tools list: move each Gateway's tools onto the agents that used it, as agents.<id>.tools.",
    );
  }
  const config: FrameworkConfig = {
    ...input,
    http: mergeSection("http", input.http),
    webSocket: mergeSection("webSocket", input.webSocket),
    events: mergeSection("events", input.events),
    services: mergeSection("services", input.services),
    tasks: mergeSection("tasks", input.tasks ?? {}),
    workflows: mergeSection("workflows", input.workflows ?? {}),
    tools: mergeSection("tools", input.tools ?? {}),
    agents: mergeSection("agents", input.agents ?? {}),
  };

  // Preserve eager validation of identities and shared directory ownership.
  normalizeFrameworkConfig(config);
  return config as ComposedFrameworkConfig<Input>;
}

/**
 * Replay id -> canonical Lambda target, derived from targets whose
 * `localReplay` flag is enabled. The replay id is the target id itself.
 */
export type EventReplayManifest = Readonly<Record<string, LambdaTarget>>;

export type EventReplayId<Config extends FrameworkConfig> = {
  [Key in keyof Config["events"]]: Config["events"][Key] extends {
    readonly localReplay: true;
  }
    ? Key
    : never;
}[keyof Config["events"]] & string;

// ---------------------------------------------------------------------------
// Type-level route projections (browser-safe, consumed by @repo/api-contract)
// ---------------------------------------------------------------------------

type StripCatchAll<Path extends string> = Path extends "/*"
  ? "/"
  : Path extends `${infer Mount}/*`
    ? Mount
    : Path;

/** Every public path the config declares, whatever its deploy scope. */
export type HttpRouteKey<Config extends FrameworkConfig> =
  | (keyof Config["http"] & string)
  | (keyof Config["services"] & string);

type IsAuthenticatedRoute<
  Config extends FrameworkConfig,
  Key extends HttpRouteKey<Config>,
> = Key extends keyof Config["http"]
  ? Config["http"][Key] extends { readonly auth: true }
    ? true
    : false
  : Key extends keyof Config["services"]
    ? Config["services"][Key] extends { readonly auth: true }
      ? true
      : false
    : false;

/**
 * Route key -> the URL a client actually calls. A catch-all mount resolves to
 * its public prefix, so `API_ROUTE["/example-service/*"]` is `"/example-service"`.
 */
export type HttpRoutePaths<Config extends FrameworkConfig> = {
  readonly [Key in HttpRouteKey<Config>]: StripCatchAll<Key>;
};

export type AuthenticatedHttpPath<Config extends FrameworkConfig> = {
  [Key in HttpRouteKey<Config>]: IsAuthenticatedRoute<Config, Key> extends true
    ? StripCatchAll<Key>
    : never;
}[HttpRouteKey<Config>];

export type PublicHttpPath<Config extends FrameworkConfig> = {
  [Key in HttpRouteKey<Config>]: IsAuthenticatedRoute<Config, Key> extends true
    ? never
    : StripCatchAll<Key>;
}[HttpRouteKey<Config>];

/** The target id of the Lambda authorizing `$connect`, if the config names one. */
export type WebSocketAuthorizerId<Config extends FrameworkConfig> = {
  [Key in keyof Config["webSocket"]]: Config["webSocket"][Key] extends {
    readonly authorizer: infer Authorizer;
  }
    ? DeclaredTargetId<Authorizer>
    : never;
}[keyof Config["webSocket"]];

export type WebSocketRouteKey<Config extends FrameworkConfig> =
  keyof Config["webSocket"] & string;

export function parseTargetReference(
  reference: TargetReference,
): ParsedTargetReference {
  const match = TARGET_PATTERN.exec(reference);
  if (!match || !match[1] || !match[2]) {
    throw new Error(
      `Invalid framework target "${reference}". Expected lambda:<kebab-case-id> or service:<kebab-case-id>.`,
    );
  }

  return {
    kind: match[1] as TargetKind,
    id: match[2],
    reference,
  };
}

/** Builds the canonical target string from the two authored fields. */
export function toTargetReference(kind: TargetKind, id: string): TargetReference {
  if (!TARGET_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid framework target id "${id}". Expected a kebab-case id such as "sign-in".`,
    );
  }
  return `${kind}:${id}` as TargetReference;
}

export function isNodeLambdaRuntime(
  runtime: LambdaRuntime,
): runtime is NodeLambdaRuntime {
  return (NODE_LAMBDA_RUNTIMES as readonly string[]).includes(runtime);
}

export function isPythonLambdaRuntime(
  runtime: LambdaRuntime,
): runtime is PythonLambdaRuntime {
  return (PYTHON_LAMBDA_RUNTIMES as readonly string[]).includes(runtime);
}

function defaultHandlerFor(runtime: LambdaRuntime): string {
  return isNodeLambdaRuntime(runtime)
    ? "lambdaHandler"
    : "lambda_function.lambda_handler";
}

// ---------------------------------------------------------------------------
// Target resolution — the single place defaults and overrides are merged
// ---------------------------------------------------------------------------

type ResolvableLambdaDefinition = LambdaTargetDefinition & TargetEnvironment & {
  readonly localReplay?: true;
  readonly deploy?: DeploySetting;
  readonly cloud?: HttpCloudSettings | EventCloudSettings | WebSocketCloudSettings;
};

/**
 * Merge the three layers — `defaults.lambda`, the section's defaults, then the
 * target's own overrides — into the spec CDK and the local runner both build from.
 */
export function resolveLambdaTargetDefinition(
  config: FrameworkConfig,
  id: string,
  directory: FrameworkDirectory,
  definition: ResolvableLambdaDefinition,
  section?: LambdaSection,
): ResolvedLambdaTarget {
  const defaults = config.defaults.lambda;
  const sectionDefaults = section ? config.defaults[section] : undefined;
  const pick = <Key extends keyof LambdaTargetDefinition>(
    key: Key,
  ): LambdaTargetDefinition[Key] | undefined =>
    definition[key] ?? sectionDefaults?.[key];

  const base: ResolvedLambdaBase = {
    id,
    reference: toTargetReference("lambda", id) as LambdaTarget,
    directory,
    architecture: pick("architecture") ?? defaults.architecture,
    memorySize: pick("memorySize") ?? defaults.memorySize,
    timeoutSeconds: pick("timeoutSeconds") ?? defaults.timeoutSeconds,
    logRetentionDays: pick("logRetentionDays") ?? defaults.logRetentionDays ?? 30,
    ...(definition.localReplay ? { localReplay: true as const } : {}),
  };
  if (!(CLOUDWATCH_LOG_RETENTION_DAYS as readonly number[]).includes(base.logRetentionDays)) {
    throw new Error(
      `lambda:${id} keeps logs for ${base.logRetentionDays} days, which CloudWatch does not offer. Use one of ${CLOUDWATCH_LOG_RETENTION_DAYS.join(", ")}.`,
    );
  }

  if ((pick("packaging") ?? defaults.packaging) === "container") {
    return { ...base, packaging: "container" };
  }

  const runtime = pick("runtime") ?? defaults.runtime;
  const sectionBundling = sectionDefaults?.bundling;
  return {
    ...base,
    packaging: "zip",
    runtime,
    handler: pick("handler") ?? defaultHandlerFor(runtime),
    bundling: {
      minify:
        definition.bundling?.minify ??
        sectionBundling?.minify ??
        defaults.bundling.minify ??
        true,
      sourceMap:
        definition.bundling?.sourceMap ??
        sectionBundling?.sourceMap ??
        defaults.bundling.sourceMap ??
        true,
    },
  };
}

// ---------------------------------------------------------------------------
// Normalization
//
// Authored data becomes a target index plus HTTP and WebSocket bindings exactly
// once, here. Everything downstream reads those instead of re-parsing section
// keys or rebuilding directories, which is what keeps CDK, both dev servers and
// the generator from drifting apart.
// ---------------------------------------------------------------------------

/** What every normalized target has, whatever it is built from. */
export interface NormalizedTargetBase extends ResolvedTargetSettings {
  readonly kind: TargetKind;
  readonly id: string;
  readonly reference: TargetReference;
  readonly role: TargetRole;
  readonly section?: LambdaSection;
  readonly deploy: DeploySetting;
  /**
   * The `cloud` section with defaults folded in. Never undefined: a target that
   * declares nothing still has a construct identity and an empty environment,
   * which is what lets CDK build every target through one pass.
   */
  readonly cloud: ResolvedCloudTarget;
  /** Config locations that declared this target, in declaration order. */
  readonly origins: readonly string[];
}

/** A target built from a directory in this repository. */
export interface SourcedTarget extends NormalizedTargetBase {
  readonly kind: SourcedTargetKind;
  readonly directory: FrameworkDirectory;
}

/**
 * A workflow: the one target with no source.
 *
 * Discriminated rather than given a dummy directory, so the filesystem, build
 * and adjacent-contract sweeps keep a type-level reason to skip it instead of
 * a special case each has to remember.
 */
export interface WorkflowNormalizedTarget extends NormalizedTargetBase {
  readonly kind: "workflow";
  readonly directory?: undefined;
  readonly workflow: NormalizedWorkflow;
}

/** One deployable thing, however many routes point at it. */
export type NormalizedTarget = SourcedTarget | WorkflowNormalizedTarget;

export function isSourcedTarget(target: NormalizedTarget): target is SourcedTarget {
  return target.kind !== "workflow";
}

export interface NormalizedFrameworkConfig {
  readonly targets: ReadonlyMap<TargetReference, NormalizedTarget>;
  readonly http: readonly HttpRouteDefinition[];
  readonly webSocket: readonly WebSocketRouteDefinition[];
}

interface MutableExtras {
  readonly origins: string[];
  readonly definition: ResolvableLambdaDefinition;
  readonly serviceDefinition?: ServiceTargetDefinition;
  readonly taskDefinition?: TaskTargetDefinition;
  readonly agentDefinition?: AgentTargetDefinition;
  readonly resolvedSpec: string;
}

type MutableSourcedTarget = SourcedTarget & MutableExtras;
type MutableWorkflowTarget = WorkflowNormalizedTarget & MutableExtras;
type MutableTarget = MutableSourcedTarget | MutableWorkflowTarget;

interface InternalNormalizedConfig extends NormalizedFrameworkConfig {
  readonly targets: ReadonlyMap<TargetReference, MutableTarget>;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
}

function rejectObsoleteField(
  definition: object,
  field: string,
  origin: string,
  replacement: string,
): void {
  if (field in definition) {
    throw new Error(`${origin} declares "${field}". ${replacement}`);
  }
}

function validateLambdaBuildDefinition(
  config: FrameworkConfig,
  origin: string,
  definition: LambdaTargetDefinition,
): void {
  const packaging = definition.packaging ?? config.defaults.lambda.packaging;
  if (!LAMBDA_PACKAGING.includes(packaging)) {
    throw new Error(
      `${origin} has unsupported packaging "${packaging}". Expected ${LAMBDA_PACKAGING.join(" or ")}.`,
    );
  }

  if (
    definition.architecture &&
    !LAMBDA_ARCHITECTURES.includes(definition.architecture)
  ) {
    throw new Error(
      `${origin} has unsupported architecture "${definition.architecture}". Expected ${LAMBDA_ARCHITECTURES.join(" or ")}.`,
    );
  }

  if (definition.runtime && !LAMBDA_RUNTIMES.includes(definition.runtime)) {
    throw new Error(
      `${origin} has unsupported runtime "${definition.runtime}". Expected one of ${LAMBDA_RUNTIMES.join(", ")}.`,
    );
  }

  if (packaging === "container") {
    if (definition.runtime) {
      throw new Error(
        `${origin} is packaged as a container, so its runtime comes from its Dockerfile. Remove "runtime".`,
      );
    }
    if (definition.bundling) {
      throw new Error(
        `${origin} is packaged as a container, so it is not bundled by esbuild. Remove "bundling".`,
      );
    }
    if (definition.handler) {
      throw new Error(
        `${origin} is packaged as a container, so its handler comes from its Dockerfile CMD. Remove "handler".`,
      );
    }
  } else {
    const runtime = definition.runtime ?? config.defaults.lambda.runtime;
    if (definition.bundling && !isNodeLambdaRuntime(runtime)) {
      throw new Error(
        `${origin} runs on ${runtime}, which is not bundled by esbuild. Remove "bundling".`,
      );
    }
  }

  if (definition.memorySize !== undefined && definition.memorySize <= 0) {
    throw new Error(`${origin} must declare a positive memorySize.`);
  }
  if (definition.timeoutSeconds !== undefined && definition.timeoutSeconds <= 0) {
    throw new Error(`${origin} must declare a positive timeoutSeconds.`);
  }
}

const ROUTE_SEGMENT_PATTERN = /^[A-Za-z0-9._~!$&'()+,;=@-]+$/;

/**
 * The supported route grammar: literal absolute paths, plus a terminal `/*`
 * mount for services. Parameter syntax is rejected outright rather than
 * forwarded unvalidated, because the overlap check below cannot yet reason
 * about it — supporting it means adding matching, projection and conflict
 * detection together.
 */
function assertHttpRouteKey(
  routeKey: string,
  origin: string,
  options: { readonly allowCatchAll: boolean },
): void {
  if (typeof routeKey !== "string" || routeKey.length === 0) {
    throw new Error(
      `${origin} must be keyed by an absolute public path such as "/orders".`,
    );
  }
  if (!routeKey.startsWith("/")) {
    throw new Error(
      `${origin} must start with "/". Route keys are absolute public paths.`,
    );
  }
  if (routeKey.includes("?") || routeKey.includes("#")) {
    throw new Error(`${origin} must be an absolute path without a query or fragment.`);
  }
  if (/\s/.test(routeKey)) {
    throw new Error(`${origin} must not contain whitespace.`);
  }
  if (routeKey.includes("//")) {
    throw new Error(`${origin} contains a duplicate slash.`);
  }
  if (/%(2f|5c)/i.test(routeKey)) {
    throw new Error(
      `${origin} contains an encoded path separator. Declare the decoded path.`,
    );
  }
  if (routeKey.includes("{") || routeKey.includes("}")) {
    throw new Error(
      `${origin} uses API Gateway parameter syntax. Path parameters are not supported yet — declare a literal path.`,
    );
  }
  if (routeKey.includes(":")) {
    throw new Error(
      `${origin} uses Express parameter syntax. Path parameters are not supported yet — declare a literal path.`,
    );
  }

  const catchAll = routeKey === "/*" || routeKey.endsWith("/*");
  if (routeKey.includes("*") && !catchAll) {
    throw new Error(`${origin} may use a wildcard only as a terminal /*.`);
  }
  if (catchAll && !options.allowCatchAll) {
    throw new Error(`${origin} may use /* only for a service target.`);
  }

  const literal = catchAll ? routeKey.slice(0, -2) : routeKey;
  if (literal === "" || literal === "/") return; // The root, or the root mount "/*".
  if (literal.endsWith("/")) {
    throw new Error(`${origin} must not end with a trailing slash.`);
  }

  for (const segment of literal.slice(1).split("/")) {
    if (segment === "." || segment === "..") {
      throw new Error(`${origin} contains a "${segment}" segment.`);
    }
    if (!ROUTE_SEGMENT_PATTERN.test(segment)) {
      throw new Error(`${origin} has an unsupported path segment "${segment}".`);
    }
  }
}

function assertWebSocketRouteKey(routeKey: string, origin: string): void {
  if (typeof routeKey !== "string" || routeKey.trim().length === 0) {
    throw new Error(`${origin} must be keyed by an API Gateway route key.`);
  }
  if (/\s/.test(routeKey)) {
    throw new Error(`${origin} must not contain whitespace.`);
  }
  if (
    routeKey.startsWith("$") &&
    !(WEBSOCKET_RESERVED_ROUTES as readonly string[]).includes(routeKey)
  ) {
    throw new Error(
      `${origin} is not a WebSocket route key API Gateway defines. Use ${WEBSOCKET_RESERVED_ROUTES.join(", ")}, or a message action without a leading "$".`,
    );
  }
}

function normalizeMethods(
  methods: unknown,
  origin: string,
): "*" | readonly [HttpMethod, ...HttpMethod[]] {
  if (methods === "*") return "*";
  if (!Array.isArray(methods)) {
    throw new Error(
      `${origin} must declare "methods" as "*" or a list of HTTP methods.`,
    );
  }
  if (methods.length === 0) {
    throw new Error(`${origin} must declare at least one method.`);
  }
  const seen = new Set<HttpMethod>();
  for (const method of methods) {
    if (!HTTP_METHODS.includes(method as HttpMethod)) {
      throw new Error(`${origin} has unsupported method "${String(method)}".`);
    }
    if (seen.has(method as HttpMethod)) {
      throw new Error(`${origin} declares method "${String(method)}" more than once.`);
    }
    seen.add(method as HttpMethod);
  }
  return methods as unknown as readonly [HttpMethod, ...HttpMethod[]];
}

function routeMethods(route: HttpRouteDefinition): readonly HttpMethod[] {
  return route.methods === "*" ? HTTP_METHODS : route.methods;
}

interface ParsedRoutePath {
  readonly catchAll: boolean;
  readonly segments: readonly string[];
}

function parseRoutePath(path: string): ParsedRoutePath {
  const catchAll = path === "/*" || path.endsWith("/*");
  const literal = catchAll ? path.slice(0, -2) : path;
  const segments =
    literal === "" || literal === "/" ? [] : literal.slice(1).split("/");
  return { catchAll, segments };
}

function isSegmentPrefix(
  prefix: readonly string[],
  candidate: readonly string[],
): boolean {
  return (
    prefix.length <= candidate.length &&
    prefix.every((segment, index) => segment === candidate[index])
  );
}

/**
 * Whether two declarations can ever accept the same request path.
 *
 * A mount owns its root and every descendant, so `/example-service/*` covers
 * `/example-service` and `/example-service/greet` but not `/example-services`. Comparison is by
 * segment rather than by string prefix, so the root mount `/*` — whose prefix is
 * empty — is handled instead of degenerating into a test for `//`.
 */
function pathsOverlap(left: string, right: string): boolean {
  const first = parseRoutePath(left);
  const second = parseRoutePath(right);

  if (!first.catchAll && !second.catchAll) {
    return (
      first.segments.length === second.segments.length &&
      isSegmentPrefix(first.segments, second.segments)
    );
  }
  if (first.catchAll && second.catchAll) {
    return (
      isSegmentPrefix(first.segments, second.segments) ||
      isSegmentPrefix(second.segments, first.segments)
    );
  }
  const mount = first.catchAll ? first : second;
  const exact = first.catchAll ? second : first;
  return isSegmentPrefix(mount.segments, exact.segments);
}

/** An example request both declarations claim, so the error says what to try. */
function exampleConflictingRequest(
  left: HttpRouteDefinition,
  right: HttpRouteDefinition,
): string {
  const method =
    routeMethods(left).find((candidate) => routeMethods(right).includes(candidate)) ??
    "GET";
  const first = parseRoutePath(left.path);
  const second = parseRoutePath(right.path);
  const segments =
    first.segments.length >= second.segments.length ? first.segments : second.segments;
  return `${method} ${segments.length === 0 ? "/" : `/${segments.join("/")}`}`;
}

function normalize(config: FrameworkConfig): InternalNormalizedConfig {
  const targets = new Map<TargetReference, MutableTarget>();
  const directoryOwners = new Map<string, MutableTarget>();
  const http: HttpRouteDefinition[] = [];
  const webSocket: WebSocketRouteDefinition[] = [];

  const claim = (
    kind: TargetKind,
    source: { readonly directory?: unknown; readonly id?: unknown },
    role: TargetRole,
    section: LambdaSection | undefined,
    definition: ResolvableLambdaDefinition,
    serviceDefinition: ServiceTargetDefinition | undefined,
    origin: string,
    extra: {
      readonly taskDefinition?: TaskTargetDefinition;
      readonly agentDefinition?: AgentTargetDefinition;
      readonly workflow?: NormalizedWorkflow;
      readonly deploy?: DeploySetting;
    } = {},
  ): MutableTarget => {
    // A workflow is authored entirely in the config, so it has no directory to
    // normalize, claim or compare - the one asymmetry the union above exists for.
    const directory =
      kind === "workflow"
        ? undefined
        : normalizeFrameworkDirectory(source.directory, origin);
    if (source.id !== undefined && typeof source.id !== "string") {
      throw new Error(`${origin} must declare "id" as a string.`);
    }
    const id = source.id ?? getDirectoryTargetId(directory as FrameworkDirectory);
    if (!TARGET_ID_PATTERN.test(id)) {
      throw new Error(
        `${origin} resolves to target id "${id}", which is not a kebab-case id such as "sign-in". Declare an explicit "id".`,
      );
    }
    // A service becomes a container named after its id, so a collision with the
    // framework's own local infrastructure is rejected at declaration —
    // including a declaration currently disabled, which could be enabled later.
    if (
      kind === "service" &&
      (RESERVED_LOCAL_SERVICE_NAMES as readonly string[]).includes(id)
    ) {
      throw new Error(
        `${origin} resolves to service id "${id}", which names one of the framework's own local containers. Declare a different "id".`,
      );
    }
    const reference = toTargetReference(kind, id);
    if (kind === "lambda") {
      // Checked before the comparisons below, so a self-contradictory entry is
      // reported as one rather than as a disagreement with its sibling.
      validateLambdaBuildDefinition(config, origin, definition);
    }
    const deploy =
      extra.deploy ?? definition.deploy ?? serviceDefinition?.deploy ?? "both";
    // Cloud settings are part of one deployed workload, so two routes reaching
    // it may not ask for different environments, grants or sizing. Resolved
    // (and canonically ordered) before comparison, like the build settings.
    const settings = resolveTargetSettings(
      id,
      role,
      kind === "service"
        ? serviceDefinition ?? {}
        : kind === "task"
          ? extra.taskDefinition ?? {}
          : kind === "agent"
            ? extra.agentDefinition ?? {}
          : definition,
      origin,
      config.defaults.container?.architecture,
    );
    const { cloud, environment, secrets } = settings;
    // Defaults are folded in before comparing, so two routes that reach one
    // target through different-looking entries are still recognized as agreeing.
    const resolvedSpec =
      kind === "workflow"
        ? stableStringify({ cloud: canonicalizeCloudTarget(cloud), workflow: extra.workflow })
        : kind === "task"
        ? stableStringify({
            cloud: canonicalizeCloudTarget(cloud),
            environment,
            secrets,
            local: extra.taskDefinition
              ? resolveTaskLocalSpec(extra.taskDefinition, origin)
              : undefined,
          })
        : kind === "lambda"
        ? stableStringify({
            build: resolveLambdaTargetDefinition(
              config,
              id,
              directory as FrameworkDirectory,
              definition,
              section,
            ),
            cloud: canonicalizeCloudTarget(cloud),
            environment,
            secrets,
          })
        : stableStringify({
            cloud: canonicalizeCloudTarget(cloud),
            environment,
            secrets,
            port: serviceDefinition?.port,
            healthCheckPath: serviceDefinition?.healthCheckPath,
          });

    const existing = targets.get(reference);
    if (existing) {
      if (existing.role !== role) {
        throw new Error(
          `Target "${reference}" is declared as ${existing.role} in ${existing.origins[0]} and as ${role} in ${origin}. A target belongs to exactly one invocation surface; share an application module instead of one Lambda identity.`,
        );
      }
      if (existing.directory !== directory) {
        throw new Error(
          `Target "${reference}" resolves to "${existing.directory}" in ${existing.origins[0]} and to "${directory}" in ${origin}. Give one of them an explicit "id".`,
        );
      }
      if (existing.resolvedSpec !== resolvedSpec) {
        throw new Error(
          `Target "${reference}" is declared with different build or cloud settings in ${existing.origins[0]} and ${origin}. Routes may share a target only when their resolved settings agree.`,
        );
      }
      if (existing.deploy !== deploy) {
        throw new Error(
          `Target "${reference}" is declared with deploy "${existing.deploy}" in ${existing.origins[0]} and "${deploy}" in ${origin}. Routes may share a target only when their deploy settings agree.`,
        );
      }
      existing.origins.push(origin);
      return existing;
    }

    const directoryOwner =
      directory === undefined ? undefined : directoryOwners.get(directory);
    if (directoryOwner) {
      throw new Error(
        `Directory "${directory}" is claimed by target "${directoryOwner.reference}" in ${directoryOwner.origins[0]} and by "${reference}" in ${origin}. One directory builds one target.`,
      );
    }

    const target = {
      kind,
      id,
      reference,
      ...(directory === undefined ? {} : { directory }),
      role,
      ...(section ? { section } : {}),
      deploy,
      ...settings,
      origins: [origin],
      definition,
      ...(serviceDefinition ? { serviceDefinition } : {}),
      ...(extra.taskDefinition ? { taskDefinition: extra.taskDefinition } : {}),
      ...(extra.agentDefinition ? { agentDefinition: extra.agentDefinition } : {}),
      ...(extra.workflow ? { workflow: extra.workflow } : {}),
      resolvedSpec,
    } as MutableTarget;
    targets.set(reference, target);
    if (directory !== undefined) directoryOwners.set(directory, target);
    return target;
  };

  /**
   * The same claim, narrowed to a kind that has a directory.
   *
   * The guard is unreachable by construction - `workflow` is the only kind
   * without a source - and stays rather than becoming a cast, so a fourth kind
   * added later reports the omission instead of producing a target whose
   * directory is quietly `undefined`.
   */
  const claimSourced = (
    ...args: Parameters<typeof claim>
  ): MutableSourcedTarget => {
    const target = claim(...args);
    if (target.kind === "workflow") {
      throw new Error(
        `${args[6]} claims a ${target.kind} target through the source-backed path.`,
      );
    }
    return target;
  };

  for (const [routeKey, definition] of Object.entries(config.http)) {
    const origin = `http["${routeKey}"]`;
    assertHttpRouteKey(routeKey, origin, { allowCatchAll: false });
    rejectObsoleteField(
      definition,
      "path",
      origin,
      "The object key is the public path now; remove the field.",
    );
    // Keep the diagnostic descriptive even when JavaScript or a cast bypasses
    // the section-specific TypeScript contracts.
    if ((definition as { readonly localReplay?: true }).localReplay) {
      throw new Error(
        `${origin} declares localReplay, but it also declares an http route. Only Lambdas that AWS invokes directly — no http or webSocket route — can capture for local replay.`,
      );
    }
    const target = claimSourced(
      "lambda",
      definition,
      "http",
      "http",
      definition,
      undefined,
      origin,
    );
    http.push({
      path: routeKey,
      methods: normalizeMethods(definition.methods, origin),
      ...(definition.auth === true ? { auth: true as const } : {}),
      type: "lambda",
      target: target.id,
      directory: target.directory,
      origin,
    });
  }

  for (const [routeKey, definition] of Object.entries(config.webSocket)) {
    const origin = `webSocket["${routeKey}"]`;
    assertWebSocketRouteKey(routeKey, origin);
    rejectObsoleteField(
      definition,
      "route",
      origin,
      "The object key is the API Gateway route key now; remove the field.",
    );
    if ((definition as { readonly localReplay?: true }).localReplay) {
      throw new Error(
        `${origin} declares localReplay, but it also declares a webSocket route. Only Lambdas that AWS invokes directly — no http or webSocket route — can capture for local replay.`,
      );
    }
    const target = claim(
      "lambda",
      definition,
      "webSocket",
      "webSocket",
      definition,
      undefined,
      origin,
    );

    let authorizer: MutableTarget | undefined;
    if (definition.authorizer) {
      if (routeKey !== "$connect") {
        throw new Error(
          `${origin} declares an authorizer. API Gateway authorizes the connection handshake, so an authorizer belongs on the "$connect" route.`,
        );
      }
      const authorizerOrigin = `${origin}.authorizer`;
      rejectObsoleteField(
        definition.authorizer,
        "handler",
        authorizerOrigin,
        'Name the implementation with "directory"; "handler" is the exported function name.',
      );
      authorizer = claim(
        "lambda",
        definition.authorizer,
        "webSocketAuthorizer",
        "webSocket",
        definition.authorizer,
        undefined,
        authorizerOrigin,
      );
    }

    webSocket.push({
      routeKey,
      target: target.reference as LambdaTarget,
      ...(authorizer ? { authorizer: authorizer.reference as LambdaTarget } : {}),
      origin,
    });
  }

  for (const [id, definition] of Object.entries(config.events)) {
    const origin = `events["${id}"]`;
    if ("id" in definition) {
      throw new Error(
        `${origin} declares "id". The object key is already this target's id.`,
      );
    }
    if ((definition as { readonly deploy?: DeploySetting }).deploy !== undefined) {
      throw new Error(
        `${origin} declares deploy settings, but its invocation wiring is owned by CDK. Remove "deploy" and control its lifecycle in the owning stack.`,
      );
    }
    claim(
      "lambda",
      { directory: definition.directory ?? getDefaultEventDirectory(id), id },
      "event",
      "events",
      definition,
      undefined,
      origin,
    );
  }

  // Keyed by target id, like events and tasks: a Gateway invokes a tool and a
  // Runtime hosts an agent, so neither has a route to be keyed by.
  for (const [id, definition] of Object.entries(config.tools ?? {})) {
    const origin = `tools["${id}"]`;
    if ("id" in definition) {
      throw new Error(`${origin} declares "id". The object key is already this target's id.`);
    }
    claim(
      "lambda",
      { directory: definition.directory ?? getDefaultToolDirectory(id), id },
      "tool",
      "tools",
      definition,
      undefined,
      origin,
    );
  }

  for (const [id, definition] of Object.entries(config.agents ?? {})) {
    const origin = `agents["${id}"]`;
    if (definition.route !== undefined) {
      assertHttpRouteKey(definition.route, `${origin}.route`, { allowCatchAll: false });
    }
    if ("id" in definition) {
      throw new Error(`${origin} declares "id". The object key is already this target's id.`);
    }
    claim(
      "agent",
      { directory: definition.directory ?? getDefaultAgentDirectory(id), id },
      "agent",
      undefined,
      {},
      undefined,
      origin,
      { agentDefinition: definition, deploy: definition.deploy ?? "both" },
    );
  }

  validateAgentCoreConfig(config);

  for (const [routeKey, definition] of Object.entries(config.services)) {
    const origin = `services["${routeKey}"]`;
    assertHttpRouteKey(routeKey, origin, { allowCatchAll: true });
    rejectObsoleteField(
      definition,
      "http",
      origin,
      'The object key is the public path; declare "methods" and "auth" directly on the entry.',
    );
    if (
      definition.port !== undefined &&
      (!Number.isInteger(definition.port) ||
        definition.port < 1 ||
        definition.port > 65535)
    ) {
      throw new Error(`${origin} must declare a port between 1 and 65535.`);
    }
    if (
      definition.healthCheckPath !== undefined &&
      !definition.healthCheckPath.startsWith("/")
    ) {
      throw new Error(
        `${origin} must declare healthCheckPath as an absolute path such as "/health".`,
      );
    }
    // Fails here rather than at generation, so an invalid local section is
    // reported against the entry that wrote it.
    rejectObsoleteField(definition, "local", origin, "Local service startup belongs in docker-compose.yml.");
    // Locally the dev server checks the token before proxying; in AWS only API
    // Gateway does, so a load balancer reachable around it would make
    // `auth: true` true in one lane and false in the other.
    if (
      definition.auth === true &&
      (definition.cloud as ServiceCloudSettings | undefined)?.publicLoadBalancer === true
    ) {
      throw new Error(
        `${origin} declares auth: true with cloud.publicLoadBalancer: true. A public load balancer is reachable without the HTTP API's authorizer, so auth: true would hold locally and not in AWS. Remove publicLoadBalancer (a service's load balancer is private by default, reached through a VPC link), or remove auth: true and verify tokens inside the service.`,
      );
    }
    const target = claimSourced(
      "service",
      definition,
      "service",
      undefined,
      {},
      definition,
      origin,
    );
    http.push({
      path: routeKey,
      methods: normalizeMethods(definition.methods, origin),
      ...(definition.auth === true ? { auth: true as const } : {}),
      type: "service",
      target: target.id,
      directory: target.directory,
      origin,
    });
  }

  for (const [id, definition] of Object.entries(config.tasks ?? {})) {
    const origin = `tasks["${id}"]`;
    if (definition === null || typeof definition !== "object") {
      throw new Error(`${origin} is not a task declaration.`);
    }
    if ("id" in definition) {
      throw new Error(
        `${origin} declares "id". The object key is already this target's id.`,
      );
    }
    for (const field of ["methods", "auth", "port", "healthCheckPath"] as const) {
      rejectObsoleteField(
        definition,
        field,
        origin,
        "A task runs to completion and is never routed; declare it under services if it serves requests.",
      );
    }
    // Fails here rather than at generation, so an invalid local section is
    // reported against the entry that wrote it.
    resolveTaskLocalSpec(definition, origin);
    claim(
      "task",
      { directory: definition.directory ?? getDefaultTaskDirectory(id), id },
      "task",
      undefined,
      {},
      undefined,
      origin,
      { taskDefinition: definition, deploy: definition.deploy ?? "both" },
    );
  }

  for (const [id, definition] of Object.entries(config.workflows ?? {})) {
    const origin = `workflows["${id}"]`;
    if (definition === null || typeof definition !== "object") {
      throw new Error(`${origin} is not a workflow declaration.`);
    }
    for (const field of ["id", "directory", "environment", "secrets"] as const) {
      rejectObsoleteField(
        definition,
        field,
        origin,
        field === "id"
          ? "The object key is already this target's id."
          : "A workflow lives in the config and has no source or process of its own.",
      );
    }
    if (!TARGET_ID_PATTERN.test(id)) {
      throw new Error(
        `${origin} is keyed by "${id}", which is not a kebab-case id such as "nightly-rollup".`,
      );
    }
    const workflow = normalizeWorkflow(id, definition, origin);
    claim(
      "workflow",
      { id },
      "workflow",
      undefined,
      {},
      undefined,
      origin,
      { workflow, deploy: definition.deploy ?? "both" },
    );
  }

  // Every declaration is compared, including one disabled in a scope, so
  // flipping a deploy toggle can never activate a collision that was hiding.
  for (const [index, left] of http.entries()) {
    for (const right of http.slice(index + 1)) {
      const methodOverlap = routeMethods(left).some((method) =>
        routeMethods(right).includes(method),
      );
      if (methodOverlap && pathsOverlap(left.path, right.path)) {
        throw new Error(
          `HTTP routes ${left.origin} (${left.type}:${left.target}) and ${right.origin} (${right.type}:${right.target}) both accept ${exampleConflictingRequest(left, right)}. One request belongs to one route.`,
        );
      }
    }
  }

  // Agent browser paths are full URLs on the application origin. HTTP/service
  // keys live under /api. CloudFront selects an origin by path, not by method,
  // so an agent cannot share a browser path even with a GET-only HTTP route.
  // Compare all declarations, including disabled lanes, before any side effects.
  const agentRoutes = getAgentBrowserRoutes(config);
  for (const [index, agent] of agentRoutes.entries()) {
    const origin = `agents["${agent.id}"].route`;
    for (const other of agentRoutes.slice(index + 1)) {
      if (agent.path === other.path) {
        throw new Error(`Browser route collision: ${origin} (agent:${agent.id}) and agents["${other.id}"].route (agent:${other.id}) both claim ${agent.path}. Choose a distinct route.`);
      }
    }
    for (const route of http) {
      const browserPath = route.path === "/" ? "/api" : `/api${route.path}`;
      if (pathsOverlap(agent.path, browserPath)) {
        throw new Error(`Browser route collision: ${origin} (agent:${agent.id}, ${agent.path}) and ${route.origin} (${route.type}:${route.target}, ${browserPath}) overlap at ${agent.path}. CloudFront routes by path regardless of HTTP method; choose a distinct route.`);
      }
    }
  }

  assertDistinctConstructIds(targets);
  assertOrchestrationIdentities(targets);
  assertReferencesAreDeclared(config, targets);
  assertInvocationEdges(config, targets);

  return { targets, http, webSocket };
}

/**
 * The construct id AgentCore's resources live under, in the stack it shares
 * with the workflows. A workflow's state machine is built at that stack's top
 * level under its own construct id, so a workflow may not resolve to this one.
 */
export const AGENTCORE_CONSTRUCT_ID = "AgentCore";

/**
 * Workflows, agents and tools deploy in one stack, so what each puts at that
 * stack's top level has to be distinct across all three kinds: a workflow's
 * construct id against AgentCore's, and every output id against every other.
 * Two such collisions would otherwise surface as a CDK error naming a construct
 * the author never wrote.
 */
function assertOrchestrationIdentities(targets: ReadonlyMap<TargetReference, MutableTarget>): void {
  const outputs = new Map<string, MutableTarget>();
  for (const target of targets.values()) {
    const orchestrated = target.kind === "workflow" || target.kind === "agent" || target.role === "tool";
    if (!orchestrated) continue;
    if (target.kind === "workflow" && target.cloud.constructId === AGENTCORE_CONSTRUCT_ID) {
      throw new Error(
        `${target.origins[0] ?? target.reference} resolves to construct id "${AGENTCORE_CONSTRUCT_ID}", which the framework's AgentCore resources use in the stack workflows share with them. Rename the workflow.`,
      );
    }
    for (const spec of Object.values(target.cloud.outputs)) {
      const existing = outputs.get(spec.id);
      if (existing) {
        throw new Error(
          `Targets "${existing.reference}" and "${target.reference}" both declare the output id "${spec.id}", and workflows, agents and tools publish their outputs from one stack. Rename one of them.`,
        );
      }
      outputs.set(spec.id, target);
    }
  }
}

/**
 * Two targets may not resolve to one construct id.
 *
 * PascalCase is not injective over kebab-case ids — `a-1` and `a1` both become
 * `A1` — so the derived default can collide. Reported rather than silently
 * suffixed: a generated suffix would depend on declaration order, and a
 * CloudFormation logical id that moves replaces a deployed resource.
 */
function assertDistinctConstructIds(
  targets: ReadonlyMap<TargetReference, MutableTarget>,
): void {
  const owners = new Map<string, MutableTarget>();
  for (const target of targets.values()) {
    // Compared per kind: a Lambda and a service never share a stack, and their
    // ids are already namespaced by the target reference.
    const key = `${target.kind}:${target.cloud.constructId}`;
    const existing = owners.get(key);
    if (existing) {
      throw new Error(
        `Targets "${existing.reference}" and "${target.reference}" both resolve to construct id "${target.cloud.constructId}". Declare an explicit cloud.constructId on one of them.`,
      );
    }
    owners.set(key, target);
  }
}

/**
 * Every reference a target uses has to name a declaration in this config's
 * catalog, with the kind it was declared as.
 *
 * TypeScript already rejects a reference outside a section's catalog view. This
 * is the runtime half of the same rule, for the JavaScript and cast-shaped ways
 * around it — and for a reference that survived a catalog entry being deleted.
 */
function assertReferencesAreDeclared(
  config: FrameworkConfig,
  targets: ReadonlyMap<TargetReference, MutableTarget>,
): void {
  const declared = new Map<string, ResourceReference | import("./cdk-resources").CdkResourceSpec>();
  for (const reference of [...listResourceDeclarations(config.resources ?? {}), ...listCdkResourceDeclarations(config.resources ?? {})]) {
    declared.set(reference.path.join("."), reference);
  }
  // A stack's group has no members until one is asked for, so a reference into
  // one is recognized by its path rather than by lookup. The stack's own type
  // is what decided the member exists; this only says the group was declared.
  const groups = listCdkResourceGroupDeclarations(config.resources ?? {});
  const declaredNatively = (path: readonly string[]): boolean =>
    isCdkResource(declared.get(path.join("."))) || groups.some((group) => isGroupMember(group, path));

  const check = (
    reference: ResourceReference,
    kind: ResourceKind,
    origin: string,
    where: string,
  ): void => {
    const key = reference.path.join(".");
    const match = declared.get(key);
    if (!match) {
      // A stack member is whatever its field holds, and all three are legal
      // here: a construct read through a string attribute, a string the stack
      // computed, or a secret read through `.arn`, `.value` or `.field()`. The
      // stack's own type already decided which the field is; there is nothing
      // left for this to check beyond the group being declared at all.
      if (declaredNatively(reference.path)) return;
      throw new Error(
        `${origin} ${where} references ${formatResourceReference(reference)}, which is not declared in this config's "resources" catalog.`,
      );
    }
    if (isCdkResource(match)) {
      if (kind !== "string" || !reference.attribute) throw new Error(`${origin} must reference a native string attribute of resources.${key}.`);
      return;
    }
    if (match.kind !== kind) {
      throw new Error(
        `${origin} ${where} uses ${formatResourceReference(reference)} as a ${kind} resource, but the catalog declares it as ${match.kind}.`,
      );
    }
  };

  for (const target of targets.values()) {
    const origin = target.origins[0] ?? target.reference;
    for (const binding of target.cloud.bindings) {
      if (binding.capability !== "nativeGrant") continue;
      if (!declaredNatively(binding.resource.path)) throw new Error(`${origin} grant ${binding.method} references a native resource absent from this catalog.`);
    }
    for (const [name, value] of Object.entries(target.environment)) {
      // A `.arn` projection shares its secret's path, so it is checked against
      // the kind the catalog actually declares: reading `x.arn` when `x` was
      // replaced by a string resource is exactly what this catches.
      if (isResourceReference(value)) {
        check(
          value,
          isSecretArnReference(value) ? "secret" : "string",
          origin,
          `environment "${name}"`,
        );
      }
    }
    for (const binding of getSecretBindings(target.cloud.bindings)) {
      check(binding.secret, "secret", origin, `cloud.bindings "${binding.environment}"`);
    }
    for (const [name, entry] of Object.entries(target.secrets)) {
      check(entry, "secret", origin, `secrets "${name}"`);
    }
    for (const [index, requirement] of target.cloud.requirements.entries()) {
      const where = `cloud.requirements[${index}]`;
      if (requirement.when) {
        check(requirement.when.resource, "string", origin, `${where} "when"`);
      }
      // Either kind is allowed here, so the catalog's own kind is what this
      // has to match: a reference that outlived its declaration being replaced
      // by one of the other kind is exactly what this catches.
      for (const reference of requirement.require) {
        check(reference, reference.kind, origin, `${where} "require"`);
      }
    }
  }
}

/**
 * Every invocation edge this config declares, checked as a graph.
 *
 * An edge is a binding (`runsTask`, `startsWorkflow`) or a workflow step. All
 * of them are checked here, after every target has been claimed, so declaration
 * order does not matter: a task declared below its caller is the same edge as
 * one declared above it.
 *
 * Three separate questions, deliberately not conflated. Does the destination
 * exist, with the kind the edge assumed? Is it enabled in the same execution
 * lane the caller runs in - because a caller with no destination in the lane it
 * actually runs in is a runtime failure, not a toggle? And do the edges form a
 * cycle, which no execution order can satisfy?
 *
 * `cloud.requirements` answers none of these: it validates resource *inputs*,
 * and says nothing about target availability or invocation permission.
 */
function assertInvocationEdges(
  config: FrameworkConfig,
  targets: ReadonlyMap<TargetReference, MutableTarget>,
): void {
  const describe = (target: MutableTarget): string =>
    target.origins[0] ?? target.reference;

  /** Which descriptor name each target id claims, so a collision names both. */
  const descriptorOwners = new Map<string, TargetReference>();
  for (const target of targets.values()) {
    if (target.kind !== "task" && target.kind !== "workflow" && target.kind !== "agent") continue;
    const name = descriptorEnvironmentName(target.kind, target.id);
    const existing = descriptorOwners.get(name);
    if (existing) {
      throw new Error(
        `Targets "${existing}" and "${target.reference}" both normalize to the invocation environment name "${name}". Rename one of them.`,
      );
    }
    descriptorOwners.set(name, target.reference);
  }

  /** caller reference -> destinations, for the cycle pass below. */
  const edges = new Map<TargetReference, TargetReference[]>();
  const addEdge = (from: TargetReference, to: TargetReference): void => {
    const existing = edges.get(from);
    if (existing) existing.push(to);
    else edges.set(from, [to]);
  };

  const requireDestination = (
    caller: MutableTarget,
    reference: TargetReference,
    where: string,
  ): MutableTarget => {
    const destination = targets.get(reference);
    if (!destination) {
      const { kind } = parseTargetReference(reference);
      const available = [...targets.values()]
        .filter((candidate) => candidate.kind === kind)
        .map((candidate) => candidate.id);
      throw new Error(
        `${describe(caller)} ${where} names "${reference}", which is not declared. Declared ${kind} ids: ${available.length > 0 ? available.join(", ") : "none"}.`,
      );
    }
    for (const scope of ["cloud", "local"] as const) {
      const callerEnabled = isDeploySettingEnabled(caller.deploy, scope);
      const destinationEnabled = isDeploySettingEnabled(destination.deploy, scope);
      if (callerEnabled && !destinationEnabled) {
        throw new Error(
          `${describe(caller)} ${where} names "${reference}", which deploy "${destination.deploy}" removes from the ${scope} lane the caller still runs in. An active edge needs a destination in the same lane.`,
        );
      }
    }
    addEdge(caller.reference, reference);
    return destination;
  };

  for (const caller of targets.values()) {
    // An agent's tool list is its Gateway: each entry is an edge the agent's
    // role is granted, so it is held to the rules of every other edge.
    if (caller.kind === "agent") {
      for (const toolId of caller.agentDefinition?.tools ?? []) {
        const where = `tools("${toolId}")`;
        const destination = requireDestination(caller, `lambda:${toolId}`, where);
        if (destination.role !== "tool") {
          throw new Error(
            `${describe(caller)} ${where} names an ${destination.role} Lambda. An agent calls Lambdas declared under tools; declare a tool there that shares the application module.`,
          );
        }
      }
    }
    for (const binding of getAgentInvocationBindings(caller.cloud.bindings)) {
      const where = `cloud.bindings invokesAgent("${binding.agent}")`;
      if (!STARTER_ROLES.includes(caller.role)) {
        throw new Error(
          `${describe(caller)} ${where} invokes an agent from a ${caller.role} target. In v1 agent callers are routed Lambdas, services, tools and other agents.`,
        );
      }
      const destination = requireDestination(caller, `agent:${binding.agent}`, where);
      if (destination.kind !== "agent") {
        throw new Error(`${describe(caller)} ${where} names "${destination.reference}", which is declared as a ${destination.kind}.`);
      }
      // An agent with users accepts only a user's token, so its caller has to
      // hold one: an authenticated route, or another agent with users.
      if (destination.agentDefinition?.auth === true && !hasSignedInUser(caller)) {
        throw new Error(
          `${describe(caller)} ${where} calls an agent with auth: true from a caller with no signed-in user. Call it from an auth: true route or agent and pass its session, or remove auth from the agent.`,
        );
      }
    }
    for (const binding of getInvocationBindings(caller.cloud.bindings)) {
      const reference = (
        binding.capability === "runsTask"
          ? `task:${binding.task}`
          : `workflow:${binding.workflow}`
      ) as TargetReference;
      const where = `cloud.bindings ${binding.capability}("${parseTargetReference(reference).id}")`;
      if (binding.capability === "startsWorkflow" && !STARTER_ROLES.includes(caller.role)) {
        throw new Error(
          `${describe(caller)} ${where} starts a workflow from a ${caller.role} target. In v1 runtime starters are routed Lambdas and services; an event or task starting a workflow is deferred, because the early event ownership would otherwise permit cross-stack cycles.`,
        );
      }
      const destination = requireDestination(caller, reference, where);
      if (destination.kind !== (binding.capability === "runsTask" ? "task" : "workflow")) {
        throw new Error(
          `${describe(caller)} ${where} names "${reference}", which is declared as a ${destination.kind}.`,
        );
      }
    }

    if (caller.kind !== "workflow" || !caller.workflow) continue;
    for (const reference of caller.workflow.targets) {
      // Named for the step that produced it, so the message points at the line
      // the author wrote rather than at a reference they never spelled.
      const verb =
        reference.startsWith("lambda:")
          ? "invokeLambda"
          : reference.startsWith("task:")
            ? "runTask"
            : reference.startsWith("agent:")
              ? "invokeAgent"
              : "runWorkflow";
      const id = reference.slice(reference.indexOf(":") + 1);
      const where = `${verb}("${id}")`;
      const destination = requireDestination(caller, reference as TargetReference, where);
      if (destination.kind === "lambda" && destination.role !== "event") {
        throw new Error(
          `${describe(caller)} ${where} names a ${destination.role} Lambda. A workflow step invokes a Lambda declared under events; declare it there, or share an application module.`,
        );
      }
      if (
        destination.kind !== "lambda" &&
        destination.kind !== "task" &&
        destination.kind !== "workflow" &&
        destination.kind !== "agent"
      ) {
        throw new Error(
          `${describe(caller)} ${where} names a ${destination.kind}. A workflow step runs a declared event Lambda, container task, workflow or agent.`,
        );
      }
      // The step calls the Runtime with the workflow's role, and an agent with
      // users accepts only a user's token — which a workflow never holds.
      if (destination.kind === "agent" && destination.agentDefinition?.auth === true) {
        throw new Error(
          `${describe(caller)} ${where} calls an agent with auth: true, which accepts only a signed-in user's token, and a workflow has none. Give the workflow an agent without auth, or call this one from an authenticated route.`,
        );
      }
      if (destination.kind === "workflow" && destination.id === caller.id) {
        throw new Error(
          `${describe(caller)} ${where} runs itself. A workflow cannot be its own step; the cycle would have no bound.`,
        );
      }
    }
  }

  // Reported as a path rather than as "a cycle exists": the fix is to break one
  // named edge, so the diagnostic has to say which edges are in the loop.
  const settled = new Set<TargetReference>();
  const visit = (reference: TargetReference, stack: readonly TargetReference[]): void => {
    if (settled.has(reference)) return;
    if (stack.includes(reference)) {
      throw new Error(
        `Invocation edges form a cycle: ${[...stack.slice(stack.indexOf(reference)), reference].join(" -> ")}. Orchestration has to be acyclic.`,
      );
    }
    for (const destination of edges.get(reference) ?? []) {
      visit(destination, [...stack, reference]);
    }
    settled.add(reference);
  };
  for (const reference of targets.keys()) visit(reference, []);
}

/** Whether every invocation of a target carries a verified user it can pass on. */
function hasSignedInUser(target: MutableTarget): boolean {
  if (target.role === "agent") return target.agentDefinition?.auth === true;
  if (target.role === "service") return target.serviceDefinition?.auth === true;
  return (
    (target.role === "http" || target.role === "tool") &&
    (target.definition as { readonly auth?: true }).auth === true
  );
}

/** Roles allowed to call `startWorkflow` at runtime in v1. */
const STARTER_ROLES: readonly TargetRole[] = [
  "tool",
  "agent",
  "http",
  "webSocket",
  "webSocketAuthorizer",
  "service",
];


/**
 * The authored config as one target index plus its route bindings.
 *
 * Every projection below goes through this, and it is recomputed each time
 * rather than memoized: a config is small, and a cache keyed on the object
 * would go stale the moment a test or a stack varied one field in place.
 */
export function normalizeFrameworkConfig(
  config: FrameworkConfig,
): NormalizedFrameworkConfig {
  return normalize(config);
}

export function resolveLambdaTarget(
  config: FrameworkConfig,
  id: string,
): ResolvedLambdaTarget {
  const target = normalize(config).targets.get(`lambda:${id}`);
  if (!target || target.kind !== "lambda") {
    throw new Error(
      `Lambda target "${id}" is not declared under http, webSocket, or events in the framework config.`,
    );
  }
  return resolveLambdaTargetDefinition(
    config,
    target.id,
    target.directory,
    target.definition,
    target.section,
  );
}

export function resolveServiceTarget(
  config: FrameworkConfig,
  id: string,
): ResolvedServiceTarget {
  const target = normalize(config).targets.get(`service:${id}`);
  if (!target || target.kind !== "service") {
    throw new Error(
      `Service target "${id}" is not declared under services in the framework config.`,
    );
  }
  const definition = target.serviceDefinition;
  return {
    id: target.id,
    reference: target.reference as ServiceTarget,
    directory: target.directory,
    environment: target.environment,
    secrets: target.secrets,
    ...(definition?.port === undefined ? {} : { port: definition.port }),
    ...(definition?.healthCheckPath === undefined
      ? {}
      : { healthCheckPath: definition.healthCheckPath }),

  };
}

/**
 * One resolved task, with sizing, architecture and build stage folded in.
 *
 * The architecture is concrete here rather than optional, so the local image
 * build and the ECS runtime platform read the same answer instead of each
 * falling back to its own host default.
 */
export function resolveTaskTarget(
  config: FrameworkConfig,
  id: string,
): ResolvedTaskTarget {
  const target = normalize(config).targets.get(`task:${id}`);
  if (!target || target.kind !== "task") {
    throw new Error(
      `Task target "${id}" is not declared under tasks in the framework config.`,
    );
  }
  return {
    id: target.id,
    reference: target.reference as TaskTarget,
    directory: target.directory,
    environment: target.environment,
    secrets: target.secrets,
    cloud:
      target.cloud.task ??
      ({ cpu: 256, memoryMiB: 512, architecture: config.defaults.container?.architecture ?? "x86_64" } as ResolvedTaskCloudSettings),
    local: resolveTaskLocalSpec(
      target.taskDefinition ?? {},
      target.origins[0] ?? target.reference,
    ),
    deploy: target.deploy,
  };
}

/** Every task the config names, resolved, in declaration order. */
export function getTaskTargets(config: FrameworkConfig): readonly ResolvedTaskTarget[] {
  return getTaskTargetIds(config).map((id) => resolveTaskTarget(config, id));
}

/** One workflow's normalized graph: what both execution lanes read. */
export function resolveWorkflow(
  config: FrameworkConfig,
  id: string,
): NormalizedWorkflow {
  const target = normalize(config).targets.get(`workflow:${id}`);
  if (!target || target.kind !== "workflow") {
    throw new Error(
      `Workflow target "${id}" is not declared under workflows in the framework config.`,
    );
  }
  return target.workflow;
}

/** Every workflow the config names, normalized, in declaration order. */
export function getWorkflows(config: FrameworkConfig): readonly NormalizedWorkflow[] {
  return getWorkflowTargetIds(config).map((id) => resolveWorkflow(config, id));
}

/** Every service the config names, resolved, in declaration order. */
export function getServiceTargets(
  config: FrameworkConfig,
): readonly ResolvedServiceTarget[] {
  return getServiceTargetIds(config).map((id) => resolveServiceTarget(config, id));
}

/** Every target the config names, routed or not, in declaration order. */
export function getFrameworkTargets(
  config: FrameworkConfig,
): readonly NormalizedTarget[] {
  return [...normalizeFrameworkConfig(config).targets.values()];
}

/**
 * The targets a CDK stack builds: those with one of its roles that this
 * deployment holds, in declaration order.
 *
 * Two questions, answered together. `deploy` is where the author wants a
 * target; `mode` is what the deployment is willing to hold. They compose by
 * intersection, so the dev graph is always a subset of the prod graph built
 * from the same config — turning `PROD_DEPLOYMENT` off removes resources, and
 * never adds or changes one.
 *
 * Selection is from the unique target collection rather than from route
 * entries, so two routes pointing at one Lambda build one Lambda.
 *
 * @see getLocalTargets — the Compose lane, which takes no mode.
 */
export function getCloudTargets(
  config: FrameworkConfig,
  roles: readonly TargetRole[],
  mode: CloudMode,
): readonly NormalizedTarget[] {
  return getFrameworkTargets(config).filter(
    (target) =>
      roles.includes(target.role) &&
      isTargetDeployed(config, target.kind, target.id, mode),
  );
}

/**
 * The targets Docker Compose runs, in declaration order.
 *
 * No mode: the local lane has one shape. A developer's laptop runs whatever the
 * config enables locally whether or not AWS is holding anything, which is why
 * this signature is shorter than {@link getCloudTargets} rather than passing a
 * mode nobody reads.
 */
export function getLocalTargets(
  config: FrameworkConfig,
  roles: readonly TargetRole[],
): readonly NormalizedTarget[] {
  return getFrameworkTargets(config).filter(
    (target) =>
      roles.includes(target.role) &&
      isTargetEnabled(config, target.kind, target.id, "local"),
  );
}

/** Every Lambda explicitly named by this config, including route authorizers. */
export function getLambdaTargetIds(config: FrameworkConfig): readonly string[] {
  return getFrameworkTargets(config)
    .filter((target) => target.kind === "lambda")
    .map((target) => target.id);
}

export function getServiceTargetIds(config: FrameworkConfig): readonly string[] {
  return getFrameworkTargets(config)
    .filter((target) => target.kind === "service")
    .map((target) => target.id);
}

export function getTaskTargetIds(config: FrameworkConfig): readonly string[] {
  return getFrameworkTargets(config)
    .filter((target) => target.kind === "task")
    .map((target) => target.id);
}

export function getWorkflowTargetIds(config: FrameworkConfig): readonly string[] {
  return getFrameworkTargets(config)
    .filter((target) => target.kind === "workflow")
    .map((target) => target.id);
}

/**
 * Every target that invokes the given one, with the binding that says so.
 *
 * Used where a grant has to be applied to callers rather than to the callee -
 * an edge is declared on the caller, and the destination never learns about it
 * on its own.
 */
export function getInvocationCallers(
  config: FrameworkConfig,
  reference: TaskTarget | WorkflowTarget,
): readonly NormalizedTarget[] {
  const { kind, id } = parseTargetReference(reference);
  return getFrameworkTargets(config).filter((target) =>
    getInvocationBindings(target.cloud.bindings).some((binding) =>
      kind === "task"
        ? binding.capability === "runsTask" && binding.task === id
        : binding.capability === "startsWorkflow" && binding.workflow === id,
    ),
  );
}

/** The step targets one workflow's graph names, deduped in first-use order. */
export function getWorkflowStepTargets(
  config: FrameworkConfig,
  id: string,
): readonly WorkflowStepTarget[] {
  return resolveWorkflow(config, id).targets;
}

/** Which invocation surface owns a Lambda, or `undefined` if it is undeclared. */
export function getLambdaSection(
  config: FrameworkConfig,
  id: string,
): LambdaSection | undefined {
  return normalize(config).targets.get(`lambda:${id}`)?.section;
}

// ---------------------------------------------------------------------------
// Deploy scope
// ---------------------------------------------------------------------------

/**
 * Roles whose caller is AWS itself.
 *
 * A Cognito trigger, an EventBridge rule or a Step Functions state has nowhere
 * else to send an invocation, so these deploy in every graph. Every other role
 * has a developer for a caller — a browser, a test, a curl — and a developer
 * can call Compose instead.
 *
 * This is the same property that stops an `events` entry from declaring
 * `deploy` at all: its invocation wiring is owned by CDK. The dev graph's one
 * carve-out is therefore derived from something the config already encodes,
 * rather than being a list somebody has to remember.
 */
const AWS_INVOKED_ROLES: ReadonlySet<TargetRole> = new Set<TargetRole>(["event"]);

/** Whether AWS itself is the caller, and therefore must hold the target. */
export function isAwsInvokedRole(role: TargetRole): boolean {
  return AWS_INVOKED_ROLES.has(role);
}

/**
 * Where the author wants a target, read from its `deploy` token alone.
 *
 * This is intent, not outcome: a `"cloud-only"` target is enabled for the cloud
 * scope even in a dev deployment that will not build it. Use
 * {@link isTargetDeployed} to ask what a particular CDK graph contains.
 */
export function isTargetEnabled(
  config: FrameworkConfig,
  kind: TargetKind,
  id: string,
  scope: DeployScope,
): boolean {
  const setting =
    normalize(config).targets.get(`${kind}:${id}` as TargetReference)?.deploy ??
    "both";
  return setting === "both" || setting === `${scope}-only`;
}

/**
 * Whether this deployment builds the target: the author's intent narrowed by
 * what the mode will hold.
 *
 * A dev deployment holds only what AWS invokes. Everything else runs under
 * Compose, so deploying it would create a resource whose only caller is
 * somewhere else.
 */
export function isTargetDeployed(
  config: FrameworkConfig,
  kind: TargetKind,
  id: string,
  mode: CloudMode,
): boolean {
  if (!isTargetEnabled(config, kind, id, "cloud")) return false;
  if (mode === "prod") return true;
  const role = normalize(config).targets.get(`${kind}:${id}` as TargetReference)?.role;
  return role !== undefined && isAwsInvokedRole(role);
}

/**
 * Every edge whose caller this deployment builds has a destination it builds too.
 *
 * A dev deployment reduces the cloud graph to what AWS invokes, so an event
 * function naming a task or a workflow is naming something this deployment does
 * not create. Caught here, against the config, rather than surfacing as a
 * missing registry handle three stacks later — the diagnostic can name the
 * declaration and the way out, which a `requireTask` failure cannot.
 *
 * A prod deployment cannot fail this. `deploy` already had to agree across the
 * cloud lane for the config to normalize, so in prod every check below restates
 * something {@link validateFrameworkConfig} has proved.
 */
export function assertCloudEdgesResolvable(
  config: FrameworkConfig,
  mode: CloudMode,
): void {
  const builds = (reference: TargetReference): boolean => {
    const { kind, id } = parseTargetReference(reference);
    return isTargetDeployed(config, kind, id, mode);
  };

  for (const caller of getFrameworkTargets(config)) {
    if (!isTargetDeployed(config, caller.kind, caller.id, mode)) continue;

    const edges: (readonly [TargetReference, string])[] = getInvocationBindings(
      caller.cloud.bindings,
    ).map((binding) =>
      binding.capability === "runsTask"
        ? ([`task:${binding.task}`, `runsTask("${binding.task}")`] as const)
        : ([
            `workflow:${binding.workflow}`,
            `startsWorkflow("${binding.workflow}")`,
          ] as const),
    );
    for (const binding of getAgentInvocationBindings(caller.cloud.bindings)) edges.push([`agent:${binding.agent}`, `invokesAgent("${binding.agent}")`]);
    if (caller.kind === "workflow") {
      for (const reference of getWorkflowStepTargets(config, caller.id)) {
        edges.push([reference as TargetReference, `states task("${reference}")`]);
      }
    }

    for (const [reference, where] of edges) {
      if (builds(reference)) continue;
      const origin = caller.origins[0] ?? caller.reference;
      throw new Error(
        `${origin} declares ${where}, which a ${mode} deployment does not build: PROD_DEPLOYMENT=false builds only what AWS invokes, and "${reference}" is invoked by you rather than by AWS. Call it from an http target, which runs under Compose alongside it, or deploy with PROD_DEPLOYMENT=true.`,
      );
    }
  }
}

export function isRouteEnabled(
  config: FrameworkConfig,
  route: HttpRouteDefinition,
  scope: DeployScope,
): boolean {
  return isTargetEnabled(config, route.type, route.target, scope);
}

/** HTTP routes that exist in the given scope, keyed by their public path. */
export function getHttpRoutes(
  config: FrameworkConfig,
  scope: DeployScope,
): readonly (readonly [string, HttpRouteDefinition])[] {
  return normalizeFrameworkConfig(config)
    .http.filter((route) => isRouteEnabled(config, route, scope))
    .map((route) => [route.path, route] as const);
}

/** Every HTTP route the config declares, whatever its scope. */
export function getAllHttpRoutes(
  config: FrameworkConfig,
): readonly HttpRouteDefinition[] {
  return normalizeFrameworkConfig(config).http;
}

// ---------------------------------------------------------------------------
// Runtime route projections
// ---------------------------------------------------------------------------

export function getPublicRoutePath<Path extends string>(
  path: Path,
): StripCatchAll<Path> {
  return (path.endsWith("/*")
    ? path.slice(0, -2) || "/"
    : path) as StripCatchAll<Path>;
}

export function getHttpRoutePaths<const Config extends FrameworkConfig>(
  config: Config,
): HttpRoutePaths<Config> {
  return Object.fromEntries(
    getAllHttpRoutes(config).map((route) => [
      route.path,
      getPublicRoutePath(route.path),
    ]),
  ) as HttpRoutePaths<Config>;
}

export function getAuthenticatedHttpPaths<const Config extends FrameworkConfig>(
  config: Config,
): readonly AuthenticatedHttpPath<Config>[] {
  return getAllHttpRoutes(config)
    .filter((route) => route.auth === true)
    .map((route) =>
      getPublicRoutePath(route.path),
    ) as AuthenticatedHttpPath<Config>[];
}

export function getPublicHttpPaths<const Config extends FrameworkConfig>(
  config: Config,
): readonly PublicHttpPath<Config>[] {
  return getAllHttpRoutes(config)
    .filter((route) => route.auth !== true)
    .map((route) => getPublicRoutePath(route.path)) as PublicHttpPath<Config>[];
}

/**
 * Every method the config can actually serve in a scope, plus OPTIONS for
 * preflight.
 *
 * CORS allowances are derived rather than listed so that adding a route with a
 * new method cannot leave the preflight surface behind — and, just as
 * importantly, so that removing (or disabling) the last route using a method
 * narrows it again. Returned in HTTP_METHODS order so callers produce stable
 * output.
 */
export function getDeclaredHttpMethods(
  config: FrameworkConfig,
  scope: DeployScope,
): readonly HttpMethod[] {
  const declared = new Set<HttpMethod>(["OPTIONS"]);
  for (const [, route] of getHttpRoutes(config, scope)) {
    for (const method of routeMethods(route)) {
      declared.add(method);
    }
  }
  return HTTP_METHODS.filter((method) => declared.has(method));
}

/** Whether a route serves the given method, treating `"*"` as every method. */
export function routeAllowsMethod(
  route: HttpRouteDefinition,
  method: string,
): boolean {
  return (
    route.methods === "*" ||
    route.methods.includes(method.toUpperCase() as HttpMethod)
  );
}

// ---------------------------------------------------------------------------
// Event replay (derived from `localReplay` on Lambda declarations)
// ---------------------------------------------------------------------------

export function getEventReplayManifest<const Config extends FrameworkConfig>(
  config: Config,
): Readonly<Record<EventReplayId<Config>, LambdaTarget>> {
  const manifest: Record<string, LambdaTarget> = {};
  for (const target of getFrameworkTargets(config)) {
    if (target.role !== "event") continue;
    if (config.events[target.id]?.localReplay) {
      manifest[target.id] = target.reference as LambdaTarget;
    }
  }
  return manifest as Readonly<Record<EventReplayId<Config>, LambdaTarget>>;
}

export function getEventReplayTarget(
  manifest: EventReplayManifest,
  replayId: string,
): LambdaTarget | undefined {
  return manifest[replayId];
}

/** WebSocket route key -> canonical Lambda target, derived from its API section. */
export function getWebSocketRoutes<const Config extends FrameworkConfig>(
  config: Config,
): Readonly<
  Record<string, LambdaTarget> & Record<WebSocketRouteKey<Config>, LambdaTarget>
> {
  const routes: Record<string, LambdaTarget> = {};
  for (const binding of normalizeFrameworkConfig(config).webSocket) {
    routes[binding.routeKey] = binding.target;
  }
  return routes as Readonly<
    Record<string, LambdaTarget> & Record<WebSocketRouteKey<Config>, LambdaTarget>
  >;
}

/** The canonical Lambda target that authorizes `$connect`, if one is declared. */
export function getWebSocketAuthorizer(
  config: FrameworkConfig,
): LambdaTarget | undefined {
  for (const binding of normalizeFrameworkConfig(config).webSocket) {
    if (binding.authorizer) return binding.authorizer;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Validation
//
// Normalization already rejects everything structurally wrong — that is what
// makes the projections above safe to call. This adds the whole-config and
// advisory checks, and is the call every entry point makes before it builds
// something: generation, CDK synth, and both local dev servers.
// ---------------------------------------------------------------------------

export function validateFrameworkConfig(config: FrameworkConfig): void {
  const defaults = config.defaults.lambda;
  if (!LAMBDA_RUNTIMES.includes(defaults.runtime)) {
    throw new Error(`defaults.lambda.runtime "${defaults.runtime}" is not supported.`);
  }
  if (!LAMBDA_PACKAGING.includes(defaults.packaging)) {
    throw new Error(
      `defaults.lambda.packaging "${defaults.packaging}" is not supported.`,
    );
  }
  if (!LAMBDA_ARCHITECTURES.includes(defaults.architecture)) {
    throw new Error(
      `defaults.lambda.architecture "${defaults.architecture}" is not supported.`,
    );
  }
  const containerArchitecture = config.defaults.container?.architecture;
  if (containerArchitecture !== undefined && !LAMBDA_ARCHITECTURES.includes(containerArchitecture)) {
    throw new Error(
      `defaults.container.architecture "${containerArchitecture}" is not supported.`,
    );
  }

  for (const route of getAllHttpRoutes(config)) {
    // Dead config is worth surfacing, but toggling has to stay fast, so this
    // never blocks a synth or a local boot.
    if (
      !isTargetEnabled(config, route.type, route.target, "cloud") &&
      !isTargetEnabled(config, route.type, route.target, "local")
    ) {
      console.warn(
        `HTTP route "${route.path}" targets ${route.type} "${route.target}", which is disabled in both cloud and local. The route is unreachable everywhere.`,
      );
    }
  }
}
