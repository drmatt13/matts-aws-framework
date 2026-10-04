import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import {
  getAllHttpRoutes,
  getAgentBrowserRoutes,
  getDeclaredHttpMethods,
  getHttpRoutes,
  getLocalTargets,
  toTargetReference,
  validateFrameworkConfig,
  type LambdaTarget,
} from "@repo/framework/config";
import { LocalLambdaExecutor, LocalServiceRegistry } from "@repo/framework/local";
import { findRepositoryRoot } from "@repo/framework/config/source";
import { getLocalBrowserOrigins } from "@repo/framework/local/origins";
import framework from "../../framework.config";
import {
  applyApiGatewayRouting,
  registerAgentRoute,
  registerApiGatewayErrorHandler,
  registerLambdaRoute,
  registerServiceRoute,
  registerUnmatchedRouteHandler,
} from "../lib/routeProxyHelpers";
import invokeAsyncLambdaFunctions from "./invokeAsyncLambdaFunctions";

dotenv.config({ path: "./.env" });
validateFrameworkConfig(framework);

const PORT = process.env.PORT || 8080;
const localBrowserOrigins = getLocalBrowserOrigins();
process.env.TRUSTED_FRONTEND_ORIGINS ??= localBrowserOrigins.join(",");

const app = express();
applyApiGatewayRouting(app);
app.use(
  cors({
    origin: localBrowserOrigins,
    credentials: true,
    // The session header routes an agent conversation to its session.
    allowedHeaders: ["Content-Type", "Authorization", "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id"],
    // Same derivation as the deployed HTTP API's corsPreflight, so a route
    // added to the manifest cannot be reachable locally but blocked in AWS.
    methods: [...getDeclaredHttpMethods(framework, "local")],
  }),
);
// No body parser here: each Lambda route reads its body as raw bytes, the way
// API Gateway hands it to the handler, and a service route streams it through.

const repositoryRoot = findRepositoryRoot(process.cwd());
const executor = new LocalLambdaExecutor({ config: framework, repositoryRoot });
const serviceRegistry = new LocalServiceRegistry({ config: framework, repositoryRoot });

const REPLAY_POLL_RESTART_DELAY_MS = 1_000;
let replayPollingEnabled = true;
let replayPollTimer: NodeJS.Timeout | undefined;

function stopPolling(): void {
  if (!replayPollingEnabled) return;
  replayPollingEnabled = false;
  if (replayPollTimer) clearTimeout(replayPollTimer);
  replayPollTimer = undefined;
  console.warn("[replay] Polling stopped due to a fatal AWS configuration error.");
}

async function pollReplayQueue(): Promise<void> {
  try {
    await invokeAsyncLambdaFunctions(executor, stopPolling);
  } finally {
    if (replayPollingEnabled) {
      replayPollTimer = setTimeout(
        () => void pollReplayQueue(),
        REPLAY_POLL_RESTART_DELAY_MS,
      );
    }
  }
}

if (
  process.env.DEV_LAMBDA_REPLAY_QUEUE_URL &&
  process.env.DEV_LAMBDA_REPLAY_BUCKET_NAME
) {
  replayPollTimer = setTimeout(() => void pollReplayQueue(), 0);
}

app.get("/", (_req, res) => {
  res.send("Welcome to the manifest-driven local API server.");
});

// Targets disabled for the local scope are skipped rather than resolved, so a
// missing Compose service cannot take the whole dev server down at boot.
const enabledRoutes = getHttpRoutes(framework, "local").map(([, route]) => route);
const enabledPaths = new Set(enabledRoutes.map((route) => route.path));
const skippedRoutes = getAllHttpRoutes(framework)
  .map((route) => route.path)
  .filter((path) => !enabledPaths.has(path));

// Preserve full browser paths at this server too. HTTP/service declarations
// are mounted under /api; agent routes are independently mounted verbatim.
const httpApp = express();
applyApiGatewayRouting(httpApp);
for (const route of enabledRoutes) {
  if (route.type === "lambda") {
    registerLambdaRoute(
      httpApp,
      route,
      toTargetReference("lambda", route.target) as LambdaTarget,
      executor,
    );
  } else {
    registerServiceRoute(httpApp, route, serviceRegistry);
  }
}

// Explicit agent browser routes stream from
// its session process in the invocation runner.
const runnerUrl = process.env.LOCAL_INVOCATION_RUNNER_URL ?? "http://local-invocation-runner:8090";
const localAgentIds = new Set(getLocalTargets(framework, ["agent"]).map((target) => target.id));
for (const { id, path } of getAgentBrowserRoutes(framework)) {
  if (localAgentIds.has(id)) registerAgentRoute(app, id, path, runnerUrl);
}
registerUnmatchedRouteHandler(httpApp, enabledRoutes);
registerApiGatewayErrorHandler(httpApp);
app.use("/api", httpApp);

// Registered after every route, because it is what answers when none of them
// did — including a declared path reached with a method it does not serve.
registerUnmatchedRouteHandler(app, []);
registerApiGatewayErrorHandler(app);

app.listen(PORT, () => {
  console.log(`Local API Dev Server is running on port ${PORT}`);
  console.log(`Trusted browser origins: ${localBrowserOrigins.join(", ")}`);
  if (skippedRoutes.length > 0) {
    console.log(`Skipping locally disabled routes: ${skippedRoutes.join(", ")}`);
  }
  console.log("Service routes resolve directly from framework.config.ts through Compose DNS.");
});
