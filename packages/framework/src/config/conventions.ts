/**
 * Where sources conventionally live, as framework paths rooted at `cdk-app`.
 *
 * These are split out of `./index` because the contract generator needs them
 * *before* it rewrites `./generated/target-ids`, and importing `./index` that
 * early would pin the previous generation in the module cache — the run would
 * then scan a repository it is no longer describing. Nothing here imports
 * generated code, so loading it early is always safe.
 */

/**
 * Conventional home of Lambda sources, and the only tree scanned for
 * handler inventory validation. Handlers sit either directly here or one level
 * down in a grouping directory named for the config section that claims them:
 * `http_functions`, `websocket_functions`, `event_functions`.
 */
export const LAMBDA_SOURCE_ROOT = "/lambda_functions";

/** Conventional home of container service sources. */
export const SERVICE_SOURCE_ROOT = "/ecs_containers/services";

/**
 * Where event handlers are filed, and the directory an `events` entry defaults
 * into when it declares none. The generator scans this to publish the event id
 * union, so both halves agree on one string.
 */
export const EVENT_SOURCE_ROOT = `${LAMBDA_SOURCE_ROOT}/event_functions` as const;

/**
 * Conventional home of container task sources: containers that run to
 * completion rather than being maintained. Reserved beside the service root so
 * a `tasks` entry defaults into `/ecs_containers/tasks/<id>` exactly as an
 * `events` entry defaults into the event grouping directory.
 */
export const TASK_SOURCE_ROOT = "/ecs_containers/tasks";

/**
 * Where AgentCore tool handlers are filed, and the directory a `tools` entry
 * defaults into. A tool is an ordinary Lambda that a Gateway invokes, so it
 * lives beside the other Lambda groupings.
 */
export const TOOL_SOURCE_ROOT = `${LAMBDA_SOURCE_ROOT}/tool_functions` as const;

/**
 * Where an `agents` entry defaults into. The one framework path that is rooted
 * at the repository rather than at `cdk-app`: an agent is an application in its
 * own right, packaged for AgentCore Runtime rather than built by a CDK stack
 * from cdk-app sources.
 */
export const AGENT_SOURCE_ROOT = "/agentcore";
