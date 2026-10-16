import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { IUserPool, IUserPoolClient } from "aws-cdk-lib/aws-cognito";
import {
  defineFrameworkConfig,
  defineResources,
  getFrameworkTargets,
  resource,
  resourceAttributeKey,
  type FrameworkConfig,
  type ResourceManifest,
  type TargetReference,
} from "../src/config";
import { resolveLocalWorkloadEnvironment } from "../src/local/environment";
import { invokeLocalNodeLambda } from "../src/local/lambda-process";
import { defaults } from "../../../framework-config/defaults";

const resources = defineResources({
  pool: resource.cdk<IUserPool>(),
  client: resource.cdk<IUserPoolClient>(),
  partnerPoolId: resource.fromEnv("PARTNER_POOL_ID"),
  partnerClientId: resource.fromEnv("PARTNER_CLIENT_ID"),
  apiKey: resource.secret("API_KEY"),
});
const userPool = { userPoolId: resources.pool.userPoolId, userPoolClientId: resources.client.userPoolClientId };

/** `null` is a config that names no pool. */
function config(sections: Record<string, unknown>, pool: unknown = userPool): FrameworkConfig {
  return defineFrameworkConfig({
    resources, defaults, http: [], webSocket: [], events: [], services: [],
    ...(pool === null ? {} : { userPool: pool }),
    ...sections,
  } as never);
}

function environmentOf(built: FrameworkConfig, reference: string): Readonly<Record<string, unknown>> {
  const target = getFrameworkTargets(built).find((candidate) => candidate.reference === reference);
  assert.ok(target, `${reference} is declared`);
  return target.environment;
}

/** The references a workload is handed, by name, comparable with deepEqual. */
const handed = (environment: Readonly<Record<string, unknown>>) => ({
  USER_POOL_ID: environment.USER_POOL_ID,
  USER_POOL_CLIENT_ID: environment.USER_POOL_CLIENT_ID,
});
const fromConfig = { USER_POOL_ID: userPool.userPoolId, USER_POOL_CLIENT_ID: userPool.userPoolClientId };
const directory = (group: string, id: string) => `/lambda_functions/${group}/${id}`;

test("userPool: true hands every kind of workload the config's pool, before its own entries", () => {
  const built = config({
    http: [{ "/reports": { directory: directory("http_functions", "reports"), methods: ["GET"], auth: true, userPool: true, environment: { REPORTS: "on" } } }],
    webSocket: [{
      $connect: {
        directory: directory("websocket_functions", "connect"),
        authorizer: { directory: directory("websocket_functions", "authorizer"), userPool: true },
      },
    }],
    events: [{ "user-import": { directory: directory("event_functions", "user-import"), userPool: true } }],
    services: [{ "/accounts/*": { directory: "/ecs_containers/services/accounts", methods: "*", auth: true, port: 5000, userPool: true } }],
    tasks: [{ "export-users": { directory: "/ecs_containers/tasks/export-users", userPool: true } }],
    tools: [{ "invite-user": { directory: directory("tool_functions", "invite-user"), userPool: true } }],
  });
  for (const reference of ["lambda:reports", "lambda:authorizer", "lambda:user-import", "service:accounts", "task:export-users", "lambda:invite-user"]) {
    assert.deepEqual(handed(environmentOf(built, reference)), fromConfig, reference);
  }
  assert.deepEqual(Object.keys(environmentOf(built, "lambda:reports")), ["USER_POOL_ID", "USER_POOL_CLIENT_ID", "REPORTS"]);
  // The connect route itself asked for nothing.
  assert.equal(environmentOf(built, "lambda:connect").USER_POOL_ID, undefined);
});

test("a tool or agent with auth: true is handed the pool; a route's or service's auth: true is its gateway's", () => {
  const built = config({
    http: [{ "/gated": { directory: directory("http_functions", "gated"), methods: ["GET"], auth: true } }],
    services: [{ "/gated-service/*": { directory: "/ecs_containers/services/gated-service", methods: "*", auth: true, port: 5000 } }],
    tools: [{ "lookup-case": { auth: true }, echo: {} }],
    agents: [{ "support-agent": { auth: true, tools: ["lookup-case", "echo"] } }],
  });
  assert.deepEqual(handed(environmentOf(built, "lambda:lookup-case")), fromConfig);
  assert.deepEqual(handed(environmentOf(built, "agent:support-agent")), fromConfig);
  for (const reference of ["lambda:gated", "service:gated-service", "lambda:echo"]) {
    assert.deepEqual(Object.keys(environmentOf(built, reference)), [], `${reference} is handed nothing`);
  }
});

test("a workload that names its own pool keeps it, whether or not the config names one", () => {
  const partner = { USER_POOL_ID: resources.partnerPoolId, USER_POOL_CLIENT_ID: resources.partnerClientId };
  for (const pool of [userPool, null]) {
    const built = config({
      http: [{ "/partner": { directory: directory("http_functions", "partner"), methods: ["GET"], auth: true, environment: partner } }],
      tools: [{ "lookup-case": { auth: true, environment: partner } }],
      agents: [{ "support-agent": { auth: true, tools: ["lookup-case"], environment: partner } }],
    }, pool);
    for (const reference of ["lambda:partner", "lambda:lookup-case", "agent:support-agent"]) {
      assert.deepEqual(handed(environmentOf(built, reference)), partner, reference);
    }
  }
});

test("a contradiction or a missing pool is refused with its fix", () => {
  const route = (extra: Record<string, unknown>) => ({
    http: [{ "/reports": { directory: directory("http_functions", "reports"), methods: ["GET"], ...extra } }],
  });
  assert.throws(
    () => config(route({ userPool: true, environment: { USER_POOL_ID: resources.partnerPoolId } })),
    /http\["\/reports"\] declares environment "USER_POOL_ID" beside userPool: true, which supplies it\. Remove it from environment, or drop userPool: true/,
  );
  assert.throws(
    () => config(route({ userPool: true }), null),
    /http\["\/reports"\] declares userPool: true, but the config names no userPool\. Add userPool: \{ userPoolId: resources\.cognito\.userPool\.userPoolId/,
  );
  assert.throws(() => config(route({ userPool: "yes" })), /declares userPool "yes"\. It is true or left out/);
  assert.throws(
    () => config({ tools: [{ "lookup-case": { auth: true } }] }, null),
    /tools\["lookup-case"\] declares auth: true without environment USER_POOL_ID, USER_POOL_CLIENT_ID\. Its token verifier reads them: name the application's pool once in framework\.config\.ts/,
  );
  assert.throws(
    () => config({ tools: [{ "lookup-case": { auth: true, environment: { USER_POOL_ID: resources.partnerPoolId } } }] }),
    /tools\["lookup-case"\] declares auth: true without environment USER_POOL_CLIENT_ID\. Its token verifier reads both: declare both to name a different pool, or neither/,
  );
});

test("the config's userPool takes two catalog string references and nothing else", () => {
  assert.throws(() => config({}, { ...userPool, userPoolId: "us-east-1_abc" }), /userPool\.userPoolId is a literal\. Name it from the resource catalog/);
  assert.throws(() => config({}, { userPoolId: userPool.userPoolId }), /userPool needs userPoolClientId/);
  assert.throws(() => config({}, { ...userPool, region: "us-east-1" }), /userPool declares unknown field "region"/);
  assert.throws(() => config({}, { ...userPool, userPoolClientId: resources.apiKey }), /userPool\.userPoolClientId is resources\.apiKey, which is not a string/);
  assert.throws(() => config({}, { ...userPool, userPoolClientId: resources.apiKey.arn }), /userPool\.userPoolClientId .* which is not a string/);
  assert.throws(() => config({}, "us-east-1_abc"), /userPool names the application's user pool/);
});

test("the local lane resolves the pool as it resolves any input, and only for the workloads handed it", async () => {
  const built = config({
    http: [
      { "/reports": { directory: directory("http_functions", "reports"), methods: ["GET"], auth: true, userPool: true } },
      { "/gated": { directory: directory("http_functions", "gated"), methods: ["GET"], auth: true } },
    ],
    agents: [{ "support-agent": { auth: true } }],
  });
  const manifest: ResourceManifest = {
    version: 1, mode: "dev", deployment: "example", account: "111122223333", region: "eu-west-2", integrations: {},
    attributes: {
      [resourceAttributeKey(resources.pool.userPoolId)]: "eu-west-2_Example",
      [resourceAttributeKey(resources.client.userPoolClientId)]: "example-client",
    },
  };
  // Compose hands the dev servers the pool for their own gate; a workload
  // never inherits it from them.
  const platform = { USER_POOL_ID: "eu-west-2_Launcher", USER_POOL_CLIENT_ID: "launcher-client", AWS_REGION: "eu-west-2" };
  const resolve = (reference: TargetReference) =>
    resolveLocalWorkloadEnvironment(built, reference, { repositoryRoot: ".", manifest, authored: {}, environment: platform });
  for (const reference of ["lambda:reports", "agent:support-agent"] as const) {
    const environment = await resolve(reference);
    assert.equal(environment.USER_POOL_ID, "eu-west-2_Example", reference);
    assert.equal(environment.USER_POOL_CLIENT_ID, "example-client", reference);
  }
  const gated = await resolve("lambda:gated");
  assert.equal(gated.USER_POOL_ID, undefined);
  assert.equal(gated.USER_POOL_CLIENT_ID, undefined);

  // A pool another account owns is an authored input, read from cdk-app/.env.
  const partner = config(
    { http: [{ "/reports": { directory: directory("http_functions", "reports"), methods: ["GET"], userPool: true } }] },
    { userPoolId: resources.partnerPoolId, userPoolClientId: resources.partnerClientId },
  );
  const environment = await resolveLocalWorkloadEnvironment(partner, "lambda:reports", {
    repositoryRoot: ".", manifest, environment: platform,
    authored: { PARTNER_POOL_ID: "us-west-2_Partner", PARTNER_CLIENT_ID: "partner-client" },
  });
  assert.equal(environment.USER_POOL_ID, "us-west-2_Partner");
  assert.equal(environment.USER_POOL_CLIENT_ID, "partner-client");
});

test("a partly migrated application resolves every workload as it declared it", () => {
  const explicit = { USER_POOL_ID: resources.pool.userPoolId, USER_POOL_CLIENT_ID: resources.client.userPoolClientId };
  // A shared spread that still names the pool, beside entries that moved to the flag.
  const shared = { ...explicit, ORIGINS: "https://example.com" };
  const built = config({
    http: [{
      "/legacy": { directory: directory("http_functions", "legacy"), methods: ["GET"], auth: true, environment: shared },
      "/migrated": { directory: directory("http_functions", "migrated"), methods: ["GET"], auth: true, userPool: true, environment: { ORIGINS: "https://example.com" } },
      "/partner": { directory: directory("http_functions", "partner"), methods: ["GET"], environment: { USER_POOL_ID: resources.partnerPoolId, USER_POOL_CLIENT_ID: resources.partnerClientId } },
    }],
    tools: [{ "lookup-case": { auth: true, environment: explicit } }],
    agents: [{ "support-agent": { auth: true, tools: ["lookup-case"] } }],
  });
  assert.deepEqual(environmentOf(built, "lambda:legacy"), shared);
  assert.deepEqual(environmentOf(built, "lambda:migrated"), { ...fromConfig, ORIGINS: "https://example.com" });
  assert.deepEqual(handed(environmentOf(built, "lambda:partner")), { USER_POOL_ID: resources.partnerPoolId, USER_POOL_CLIENT_ID: resources.partnerClientId });
  assert.deepEqual(environmentOf(built, "lambda:lookup-case"), explicit);
  assert.deepEqual(handed(environmentOf(built, "agent:support-agent")), fromConfig);
  // Moving a spread's user to the flag without removing the names is the one refusal.
  assert.throws(
    () => config({ http: [{ "/legacy": { directory: directory("http_functions", "legacy"), methods: ["GET"], userPool: true, environment: shared } }] }),
    /declares environment "USER_POOL_ID" beside userPool: true/,
  );
});

test("naming a pool in the config changes nothing a workload already declared", () => {
  const sections = {
    http: [{ "/legacy": { directory: directory("http_functions", "legacy"), methods: ["GET"], auth: true, environment: { USER_POOL_ID: resources.partnerPoolId, USER_POOL_CLIENT_ID: resources.partnerClientId, OTHER: "x" } } }],
    tools: [{ "lookup-case": { auth: true, environment: { USER_POOL_ID: resources.partnerPoolId, USER_POOL_CLIENT_ID: resources.partnerClientId } } }],
    agents: [{ "support-agent": { auth: true, tools: ["lookup-case"], environment: { USER_POOL_ID: resources.partnerPoolId, USER_POOL_CLIENT_ID: resources.partnerClientId } } }],
  };
  const environments = (built: FrameworkConfig) =>
    Object.fromEntries(getFrameworkTargets(built).map((target) => [target.reference, target.environment]));
  assert.deepEqual(environments(config(sections, userPool)), environments(config(sections, null)));
});

test("two routes sharing one handler must agree on whether it is handed the pool", () => {
  assert.throws(
    () => config({
      http: [{
        "/reports": { directory: directory("http_functions", "reports"), methods: ["GET"], userPool: true },
        "/reports/export": { directory: directory("http_functions", "reports"), methods: ["GET"] },
      }],
    }),
    /Target "lambda:reports" is declared with different build or cloud settings in http\["\/reports"\] and http\["\/reports\/export"\]/,
  );
});

test("a local Lambda process reads the pool it is handed, and only that", async () => {
  // Executed, not only resolved: the handler runs in the child process the dev
  // servers use, and reports what its process.env holds.
  const root = path.resolve(__dirname, "../../..");
  const cache = path.join(root, ".cache"); mkdirSync(cache, { recursive: true });
  const fixture = mkdtempSync(path.join(cache, "user-pool-handlers-"));
  try {
    for (const id of ["reports", "gated"]) {
      const handler = path.join(fixture, "cdk-app/lambda_functions/http_functions", id);
      mkdirSync(handler, { recursive: true });
      writeFileSync(path.join(handler, "index.ts"), "export async function lambdaHandler() { return { pool: process.env.USER_POOL_ID ?? null, client: process.env.USER_POOL_CLIENT_ID ?? null }; }");
    }
    const built = config({
      http: [{
        "/reports": { directory: directory("http_functions", "reports"), methods: ["GET"], auth: true, userPool: true },
        "/gated": { directory: directory("http_functions", "gated"), methods: ["GET"], auth: true },
      }],
    });
    const manifest: ResourceManifest = {
      version: 1, mode: "dev", deployment: "example", account: "111122223333", region: "eu-west-2", integrations: {},
      attributes: {
        [resourceAttributeKey(resources.pool.userPoolId)]: "eu-west-2_Example",
        [resourceAttributeKey(resources.client.userPoolClientId)]: "example-client",
      },
    };
    // What Compose hands the launcher for its own gate.
    const environment = { ...process.env, USER_POOL_ID: "eu-west-2_Launcher", USER_POOL_CLIENT_ID: "launcher-client" };
    const options = { repositoryRoot: fixture, manifest, authored: {}, environment };
    assert.deepEqual(await invokeLocalNodeLambda(built, "lambda:reports", {}, options), { pool: "eu-west-2_Example", client: "example-client" });
    assert.deepEqual(await invokeLocalNodeLambda(built, "lambda:gated", {}, options), { pool: null, client: null });
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
