import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCloudEdgesResolvable,
  defineFrameworkConfig,
  defineResources,
  getCloudTargets,
  isTargetDeployed,
  resource,
  runsTask,
  type FrameworkConfig,
  type FrameworkConfigInput,
} from "../src/config/index";
import { defaults } from "../../../framework-config/defaults";

const cognito = { USER_POOL_ID: "us-east-1_pool", USER_POOL_CLIENT_ID: "client" };
const webSocketRoles = ["webSocket", "webSocketAuthorizer"] as const;

const routes = {
  $connect: {
    directory: "/lambda_functions/websocket_functions/ws-connect-route",
    authorizer: { directory: "/lambda_functions/websocket_functions/ws-authorizer", environment: cognito },
  },
  $default: { directory: "/lambda_functions/websocket_functions/ws-default-route" },
  customAction: { directory: "/lambda_functions/websocket_functions/ws-custom-action-route" },
};

const config = (overrides: Partial<FrameworkConfigInput> = {}, defaultRoute: Record<string, unknown> = {}): FrameworkConfig =>
  defineFrameworkConfig({
    defaults,
    http: [{ "/verify-session": { directory: "/lambda_functions/http_functions/verify-session", methods: ["GET"] } }],
    webSocket: [{ ...routes, $default: { ...routes.$default, ...defaultRoute } }],
    events: [],
    services: [],
    ...overrides,
  } as never);

test("a dev deployment holds the WebSocket handlers only when it builds the WebSocket API", () => {
  const built = config();
  assert.deepEqual(getCloudTargets(built, webSocketRoles, "dev"), []);

  const withApi = getCloudTargets(built, webSocketRoles, "dev", { webSocketApi: true });
  assert.equal(withApi.length, 4, "three routes and the $connect authorizer");
  assert.ok(withApi.some((target) => target.role === "webSocketAuthorizer"));
  assert.deepEqual(
    withApi.map((target) => target.reference),
    getCloudTargets(built, webSocketRoles, "prod").map((target) => target.reference),
  );

  // The exception is the WebSocket API's handlers, nothing else it might reach.
  assert.equal(isTargetDeployed(built, "lambda", "verify-session", "dev", { webSocketApi: true }), false);
  assert.equal(isTargetDeployed(built, "lambda", "verify-session", "prod"), true);
  assert.doesNotThrow(() => assertCloudEdgesResolvable(built, "dev", { webSocketApi: true }));
});

test("a WebSocket handler a dev deployment builds may not need what the dev graph lacks", () => {
  const callsTask = config({ tasks: [{ worker: { directory: "/test/fixtures/task-worker", deploy: "both" } }] }, { cloud: { bindings: [runsTask("worker")] } });
  // Served under Compose, it reaches the local task, as before.
  assert.doesNotThrow(() => assertCloudEdgesResolvable(callsTask, "dev"));
  assert.doesNotThrow(() => assertCloudEdgesResolvable(callsTask, "prod", { webSocketApi: true }));
  assert.throws(
    () => assertCloudEdgesResolvable(callsTask, "dev", { webSocketApi: true }),
    /declares runsTask\("worker"\), which a dev deployment does not build.*Turn DEPLOY_PROD_WEBSOCKET_API off to serve it under Compose/,
  );

  const inside = config({}, { subnet: "private" });
  assert.doesNotThrow(() => assertCloudEdgesResolvable(inside, "dev"));
  assert.throws(
    () => assertCloudEdgesResolvable(inside, "dev", { webSocketApi: true }),
    /has subnet: "private", but a dev deployment builds no network, and DEPLOY_PROD_WEBSOCKET_API builds this WebSocket handler in AWS/,
  );

  const catalog = defineResources({ rds: resource.stack<{ readonly database: { readonly connections: object; readonly node: { readonly id: string; readonly path: string } } }>() });
  const connected = config({ resources: catalog, database: catalog.rds.database } as never, { database: true });
  assert.doesNotThrow(() => assertCloudEdgesResolvable(connected, "prod", { webSocketApi: true }));
  assert.throws(
    () => assertCloudEdgesResolvable(connected, "dev", { webSocketApi: true }),
    /declares database: true, but a dev deployment builds no database/,
  );
});
