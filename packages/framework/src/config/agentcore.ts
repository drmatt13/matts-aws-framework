/**
 * AgentCore agents and the tools they call, as two ordinary sections.
 *
 * A tool is a Lambda a Gateway invokes. An agent is an application AgentCore
 * Runtime hosts, and its `tools` list is the whole of its Gateway: the
 * framework builds one Gateway per agent holding exactly those targets, so an
 * agent can reach nothing it did not declare — enforced by IAM, not by a list
 * the agent is trusted to respect. There is no Gateway to declare.
 *
 * A tool's arguments, result and description live beside its handler in
 * `contract.ts`, as an HTTP payload contract does; this module only says what
 * exists, who may call it, and where it runs.
 */
import type {
  AnyResourceCatalog,
  DeploySetting,
  FrameworkConfig,
  FrameworkDirectory,
  HttpCloudSettings,
  LambdaTargetDefinition,
  SuggestedLambdaDirectory,
  TargetEnvironment,
} from "./index";
import { AGENT_SOURCE_ROOT, TOOL_SOURCE_ROOT } from "./conventions";
import { LAMBDA_SOURCE_DIRECTORY_BY_ID } from "../generated/target-ids";
import type { ToolLambdaId } from "../generated/target-ids";

/** The committed projection of every tool contract: what each Gateway target registers in AWS. */
export { AGENTCORE_AGENTS, AGENTCORE_TOOLS } from "../generated/agentcore";
export { gatewayInputSchema, type GatewaySchema, type GatewayToolEntry, type GatewayToolManifest } from "../protocol/tool-schema";

/** Tool ids autocomplete; a tool added in the same edit as its agent is still accepted. */
export type SuggestedToolId = ToolLambdaId | (string & {});

/** A Lambda an agent calls through its Gateway. */
export type ToolTargetDefinition<Catalog = AnyResourceCatalog> = LambdaTargetDefinition &
  TargetEnvironment<Catalog> & {
    /** Defaults to `/lambda_functions/tool_functions/<id>`. */
    readonly directory?: SuggestedLambdaDirectory;
    /**
     * The tool acts as the signed-in user. Its handler is written with
     * `authenticatedTool`, which verifies the user's Cognito token itself — the
     * model never sees the token and cannot supply one.
     */
    readonly auth?: true;
    /** Where this tool is enabled. */
    readonly deploy?: DeploySetting;
    readonly cloud?: HttpCloudSettings<Catalog>;
  };

/** Cloud settings for an agent's AgentCore Runtime. */
export interface AgentCloudSettings<Catalog = AnyResourceCatalog>
  extends HttpCloudSettings<Catalog> {
  /** Seconds an idle session keeps its microVM, 60 to 28800. Both lanes honour it. */
  readonly idleSeconds?: number;
  /** Seconds a session may live at all, 60 to 28800. Both lanes honour it. */
  readonly maxLifetimeSeconds?: number;
}

/** An agent: an application AgentCore Runtime hosts, and the tools it may call. */
export type AgentTargetDefinition<Catalog = AnyResourceCatalog> = TargetEnvironment<Catalog> & {
  /** Defaults to `/agentcore/<id>`, rooted at the repository. */
  readonly directory?: `${typeof AGENT_SOURCE_ROOT}/${string}`;
  /**
   * Calls use the user's Cognito session. A declared `route` exposes it to
   * the browser. AgentCore checks the token before the agent runs, and
   * the agent checks it again — as an `auth: true` route and `authenticated`
   * handler do.
   */
  readonly auth?: true;
  /** Full same-origin browser path, e.g. `/chat/support`. No prefix is added.
   * Requires auth: true. Omit it for workload-only invocation. */
  readonly route?: `/${string}`;
  /** The tools this agent may call. They are its Gateway, and nothing else is. */
  readonly tools?: readonly SuggestedToolId[];
  readonly deploy?: DeploySetting;
  readonly cloud?: AgentCloudSettings<Catalog>;
};

export type FrameworkTools<Catalog = AnyResourceCatalog> = Readonly<
  Record<string, ToolTargetDefinition<Catalog>>
>;
export type FrameworkAgents<Catalog = AnyResourceCatalog> = Readonly<
  Record<string, AgentTargetDefinition<Catalog>>
>;

/** One tool as an agent's Gateway exposes it. */
export interface AgentTool {
  readonly id: string;
  readonly auth: boolean;
  /**
   * The name on the wire. Gateway prefixes every tool with its target's name,
   * and a tool is its own target, so this is `<id>___<id>`. Agent code never
   * spells it: the runtime maps ids to wire names in both directions.
   */
  readonly wireName: string;
}

/** Explicit browser routes; workload identity and source directory stay independent. */
export function getAgentBrowserRoutes(config: FrameworkConfig): readonly { readonly id: string; readonly path: string }[] {
  return Object.entries(config.agents ?? {})
    .filter(([, agent]) => agent.auth === true && agent.route !== undefined)
    .map(([id, agent]) => ({ id, path: agent.route! }));
}

export const AGENT_LIFECYCLE_BOUNDS = { min: 60, max: 28_800 } as const;

/** AgentCore's own defaults, used locally when an agent declares none. */
export const AGENT_LIFECYCLE_DEFAULTS = { idleSeconds: 900, maxLifetimeSeconds: 28_800 } as const;

/** The verifier `authenticated` and `authenticatedTool` share reads these. */
export const COGNITO_VERIFIER_ENVIRONMENT = ["USER_POOL_ID", "USER_POOL_CLIENT_ID"] as const;

/**
 * Where a `tools` entry that declares no `directory` lives. A handler filed
 * anywhere under the tool grouping is found by its id, as an event's is.
 */
export function getDefaultToolDirectory(id: string): FrameworkDirectory {
  const filed = (LAMBDA_SOURCE_DIRECTORY_BY_ID as Readonly<Record<string, string | undefined>>)[id];
  return filed?.startsWith(`${TOOL_SOURCE_ROOT}/`)
    ? (filed as FrameworkDirectory)
    : `${TOOL_SOURCE_ROOT}/${id}`;
}

export function getDefaultAgentDirectory(id: string): FrameworkDirectory {
  return `${AGENT_SOURCE_ROOT}/${id}`;
}

/** The tools an agent's Gateway holds, in the order the agent lists them. */
export function getAgentTools(config: FrameworkConfig, agentId: string): readonly AgentTool[] {
  const agent = config.agents?.[agentId];
  if (!agent) throw new Error(`agent:${agentId} is not declared under agents.`);
  return (agent.tools ?? []).map((id) => ({
    id,
    auth: config.tools?.[id]?.auth === true,
    wireName: `${id}___${id}`,
  }));
}

/** The lifecycle both lanes apply to an agent's sessions. */
export function getAgentLifecycle(
  config: FrameworkConfig,
  agentId: string,
): { readonly idleSeconds: number; readonly maxLifetimeSeconds: number } {
  const cloud = config.agents?.[agentId]?.cloud;
  return {
    idleSeconds: cloud?.idleSeconds ?? AGENT_LIFECYCLE_DEFAULTS.idleSeconds,
    maxLifetimeSeconds: cloud?.maxLifetimeSeconds ?? AGENT_LIFECYCLE_DEFAULTS.maxLifetimeSeconds,
  };
}

function assertCognitoInputs(
  origin: string,
  environment: Readonly<Record<string, unknown>> | undefined,
): void {
  const missing = COGNITO_VERIFIER_ENVIRONMENT.filter((name) => environment?.[name] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `${origin} declares auth: true without environment ${missing.join(", ")}. Its token verifier reads them; add them as an auth: true route does, e.g. USER_POOL_ID: resources.cognito.userPool.userPoolId.`,
    );
  }
}

function assertLifecycleSeconds(origin: string, name: string, value: unknown): void {
  if (value === undefined) return;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < AGENT_LIFECYCLE_BOUNDS.min ||
    value > AGENT_LIFECYCLE_BOUNDS.max
  ) {
    throw new Error(
      `${origin} cloud.${name} must be a whole number from ${AGENT_LIFECYCLE_BOUNDS.min} to ${AGENT_LIFECYCLE_BOUNDS.max}, the range AgentCore Runtime accepts.`,
    );
  }
}

/**
 * Declaration-level rules for tools and agents. Edges — whether a listed tool
 * exists, is a tool, and runs in the agent's lanes — are checked with every
 * other invocation edge, so a cycle through an agent is found like any other.
 */
export function validateAgentCoreConfig(config: FrameworkConfig): void {
  for (const [id, tool] of Object.entries(config.tools ?? {})) {
    const origin = `tools["${id}"]`;
    const packaging = tool.packaging ?? config.defaults.tools?.packaging ?? config.defaults.lambda.packaging;
    const runtime = tool.runtime ?? config.defaults.tools?.runtime ?? config.defaults.lambda.runtime;
    if (packaging !== "zip" || !runtime.startsWith("nodejs")) {
      throw new Error(
        `${origin} must be a Node zip Lambda. Its handler is written with tool() or authenticatedTool(), which validate against its contract in both lanes.`,
      );
    }
    if (tool.auth === true) assertCognitoInputs(origin, tool.environment);
  }

  for (const [id, agent] of Object.entries(config.agents ?? {})) {
    const origin = `agents["${id}"]`;
    if (agent.route !== undefined && agent.auth !== true) {
      throw new Error(`${origin}.route requires auth: true. Browser agent routes use the signed-in user's session.`);
    }
    if ("secrets" in agent) {
      throw new Error(
        `${origin} declares secrets. AgentCore Runtime has no startup secret injection; write environment: { NAME: resources.<secret>.arn } and read the secret in the agent, which also grants the read.`,
      );
    }
    if (agent.auth === true) assertCognitoInputs(origin, agent.environment);
    if (Object.prototype.hasOwnProperty.call(agent.environment ?? {}, "PORT")) {
      throw new Error(`${origin} declares environment "PORT", which AgentCore Runtime owns. Remove it.`);
    }

    assertLifecycleSeconds(origin, "idleSeconds", agent.cloud?.idleSeconds);
    assertLifecycleSeconds(origin, "maxLifetimeSeconds", agent.cloud?.maxLifetimeSeconds);
    const lifecycle = getAgentLifecycle(config, id);
    if (lifecycle.maxLifetimeSeconds < lifecycle.idleSeconds) {
      throw new Error(
        `${origin} cloud.maxLifetimeSeconds is shorter than cloud.idleSeconds, so no session could ever go idle.`,
      );
    }

    const listed = agent.tools ?? [];
    if (new Set(listed).size !== listed.length) {
      throw new Error(`${origin} lists a tool twice. Each tool is one target on the agent's Gateway.`);
    }
    for (const toolId of listed) {
      if (config.tools?.[toolId]?.auth === true && agent.auth !== true) {
        throw new Error(
          `${origin} lists tools("${toolId}"), which declares auth: true. Only an agent with auth: true has a signed-in user to act as; add auth: true to the agent, or give the tool service authority.`,
        );
      }
    }
  }
}
