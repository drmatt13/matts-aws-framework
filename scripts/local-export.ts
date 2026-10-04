import os from "node:os";
import path from "node:path";
import { getFrameworkTargets, isTargetEnabled, isResourceReference } from "@repo/framework/config";
import framework from "../framework.config";

/**
 * Every host port Docker Compose publishes, authored in cdk-app/.env.
 *
 * Compose interpolates these by name, and packages/framework/scripts/check-local.ts
 * asserts the two lists agree, so a service that publishes a port nobody can move
 * fails the check rather than reaching a developer whose machine already uses it.
 */
export const LOCAL_HOST_PORT_NAMES = [
  "LOCAL_API_DEV_SERVER_HOST_PORT",
  "LOCAL_WS_DEV_SERVER_HOST_PORT",
  "LOCAL_INVOCATION_RUNNER_HOST_PORT",
  "FRONTEND_WS_CONNECTION_AND_PAYLOAD_TESTER_HOST_PORT",
  "POSTGRES_HOST_PORT",
  "PGADMIN_HOST_PORT",
] as const;

/** client-app's origin when LOCAL_DEV_URL says nothing, as in cdk-app/deployment.ts. */
const LOCALHOST_DEV_URL = "http://localhost:3000";

/**
 * A URL reduced to the origin an allowlist can hold.
 *
 * getLocalBrowserOrigins() in @repo/framework/local/origins rejects a value carrying
 * a path, query or fragment, so a trailing slash authored in cdk-app/.env would
 * otherwise fail at container start rather than here.
 */
function toOrigin(value: string, name: string): string {
  try {
    return new URL(value.trim()).origin;
  } catch {
    throw new Error(`${name}="${value}" in cdk-app/.env is not a URL.`);
  }
}

/** Export only declared local reads and explicit development controls. */
export function localExportValues(
  authored: Readonly<Record<string, string>>,
  options: { profile?: string; region?: string; repositoryRoot: string },
): Map<string, string> {
  const values = new Map<string, string>();
  // Resource attributes and authored workload inputs have dedicated readers.
  // Root .env contains Compose controls, never application secret values.
  for (const target of getFrameworkTargets(framework)) {
    if (target.kind !== "service" || !isTargetEnabled(framework, target.kind, target.id, "local")) continue;
    const override = `${target.id.replace(/-/g, "_").toUpperCase()}_SERVICE_URL`;
    if (authored[override]) values.set(override, authored[override]);
  }
  if (authored.LOCAL_BROWSER_ORIGINS !== undefined) {
    throw new Error("LOCAL_BROWSER_ORIGINS in cdk-app/.env is no longer read: the local allowlist is derived from LOCAL_DEV_URL and the WebSocket tester's host port. Remove it, and set LOCAL_DEV_URL if you need a different frontend origin.");
  }

  // Host ports are authored, not defaulted: a port is a fact about this machine,
  // and a silent default is what makes a collision hard to find. Only the
  // published side is configurable — a container's own listen port and every
  // Compose-DNS address stay literal in docker-compose.yml.
  const claimedBy = new Map<string, string>();
  for (const name of LOCAL_HOST_PORT_NAMES) {
    const port = authored[name];
    if (port === undefined) {
      throw new Error(`${name} is missing from cdk-app/.env. Every published host port is authored there; copy the block from cdk-app/.env.dev.example.`);
    }
    if (!/^[1-9][0-9]*$/.test(port) || Number(port) > 65535) {
      throw new Error(`${name}=${port} in cdk-app/.env is not a port number between 1 and 65535.`);
    }
    const first = claimedBy.get(port);
    if (first) {
      throw new Error(`${name} and ${first} are both ${port}. Two Compose services cannot publish one host port.`);
    }
    claimedBy.set(port, name);
    values.set(name, port);
  }
  const hostPort = (name: string): string => values.get(name)!;

  const controls: Record<string, string> = {
    LOCAL_AWS_PROFILE: options.profile ?? "dev",
    LOCAL_AWS_REGION: options.region ?? "us-east-1",
    LOCAL_AWS_CONFIG_DIR: path.join(os.homedir(), ".aws"),
    PRISMA_LOCAL_SCHEMA_SYNC: "migrate",
    LOCAL_CONTAINER_LAMBDA_TIMEOUT_MS: "10000",
    // Warm Node handler processes in the dev servers: at most this many, each
    // stopped after this many idle seconds. LOCAL_LAMBDA_WARM=false starts
    // every invocation cold.
    LOCAL_LAMBDA_WARM: "true",
    LOCAL_LAMBDA_WARM_MAX: "6",
    LOCAL_LAMBDA_WARM_IDLE_SECONDS: "120",
    LOCAL_INVOCATION_RUNNER_PUBLIC_URL: `http://localhost:${hostPort("LOCAL_INVOCATION_RUNNER_HOST_PORT")}`,
    // The target of client-app's HTTP and explicit agent route proxies, read
    // from the repository root by client-app/vite.config.ts.
    VITE_API_GATEWAY_URL: `http://localhost:${hostPort("LOCAL_API_DEV_SERVER_HOST_PORT")}`,
  };
  for (const [name, fallback] of Object.entries(controls)) {
    values.set(name, authored[name] ?? fallback);
  }
  values.set("LOCAL_AWS_CONFIG_DIR", path.resolve(options.repositoryRoot, values.get("LOCAL_AWS_CONFIG_DIR")!).replace(/\\/g, "/"));
  if (authored.COMPOSE_PROJECT_NAME) values.set("COMPOSE_PROJECT_NAME", authored.COMPOSE_PROJECT_NAME);

  // The two origins a browser reaches these servers on: client-app, whose port
  // LOCAL_DEV_URL names for the deployed trust list too, and the WebSocket
  // tester. Deriving both is what retired LOCAL_BROWSER_ORIGINS as an authored
  // value — and it is the only thing that carries a LAN LOCAL_DEV_URL into the
  // *local* servers, which previously trusted localhost and nothing else.
  const origins = [...new Set([
    toOrigin(authored.LOCAL_DEV_URL ?? LOCALHOST_DEV_URL, "LOCAL_DEV_URL"),
    `http://localhost:${hostPort("FRONTEND_WS_CONNECTION_AND_PAYLOAD_TESTER_HOST_PORT")}`,
  ])].join(",");
  // One name, because one thing reads it: the local dev servers. The auth
  // lambdas' TRUSTED_FRONTEND_ORIGINS is derived from this by the API server,
  // not exported alongside it, so there is no second copy to drift.
  values.set("LOCAL_BROWSER_ORIGINS", origins);
  return values;
}

/** Replace owned output only. Conflicts name keys, never their values. */
export function replaceGeneratedEnvironment(existing: string, block: string, names: readonly string[]): string {
  const start = "# BEGIN GENERATED CDK OUTPUTS";
  const end = "# END GENERATED CDK OUTPUTS";
  const first = existing.indexOf(start);
  const last = existing.indexOf(end);
  if ((first < 0) !== (last < 0) || (first >= 0 && last < first) ||
      (first >= 0 && existing.indexOf(start, first + start.length) >= 0) ||
      (last >= 0 && existing.indexOf(end, last + end.length) >= 0)) {
    throw new Error("Root .env has an incomplete generated block. Repair its BEGIN/END markers before exporting.");
  }
  const before = first < 0 ? existing : existing.slice(0, first);
  const after = first < 0 ? "" : existing.slice(last + end.length).replace(/^\r?\n/, "");
  const keys = new Set(names);
  const collisions = [...(before + after).matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)]
    .map((match) => match[1]).filter((key) => keys.has(key));
  if (collisions.length) {
    throw new Error(`Root .env contains authored keys now owned by export: ${[...new Set(collisions)].join(", ")}. Move local settings into cdk-app/.env and remove these root assignments before exporting.`);
  }
  return before + (before && !before.endsWith("\n") ? "\n" : "") + block + after;
}
