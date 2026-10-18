// The application: framework composition and your own stacks. Loaded by
// bin/main.ts, which resolves the deployment target from CDK context first.
import * as path from "path";
import { frameworkApp } from "./app";
import {
  createFrameworkFoundation,
  createFrameworkTasks,
  createFrameworkOrchestration,
  createFrameworkWorkloads,
} from "../lib/framework/framework-composition";
// lib/app: this application's own infrastructure.
import { CognitoStack } from "../lib/app/cognito-stack";
import { FrontendWebsiteS3Stack } from "../lib/app/frontend-website-s3-stack";
import { FrontendRouting } from "../lib/app/frontend-routing";
import { RdsStack } from "../lib/app/rds-stack";
import { EventLambdaFunctionsStack } from "../lib/framework/event-lambda-functions-stack";
import { assertCloudEdgesResolvable, validateFrameworkConfig } from "@repo/framework/config";
import { PROD_DEPLOYMENT, readAuthoredInputs } from "@repo/framework/config/source";
import { initializeFrameworkResources, finalizeFrameworkResources } from "../lib/framework/framework-resources";
import { describeFrameworkNetwork } from "../lib/framework/framework-network";
import { describeFrameworkDatabase } from "../lib/framework/framework-database";
import framework from "../../framework.config";

import {
  loadDeploymentEnvironment,
  resolveDeploymentInputs,
  resolveFrontendSettings,
} from "../deployment";

const repositoryRoot = path.join(__dirname, "..", "..");

// Which deployment and graph this is was decided from CDK context before this
// file loaded (bin/app.ts): `-c prodDeployment`, `-c deployment`, and the
// targets in cdk.json. Deployment flags — which domain, which optional stacks —
// are read from the process environment with that target's inputs file loaded
// behind it.
const { app, selection } = frameworkApp();
selection.warnings.forEach((warning) => console.warn(warning));
loadDeploymentEnvironment(selection.inputsFile);

// Declared resource inputs are *not* read from the process environment. Every
// `.fromEnv()` in framework-config/resources.ts resolves against the target's
// inputs file itself (cdk-app/.env for development, the file `docker compose up` reads),
// so a deployment and a local run cannot disagree about a model id. `-c` still
// overrides one, because an override you typed is not an override you inherited.
const readers = {
  env: readAuthoredInputs(repositoryRoot),
  getContext: (key: string) => app.node.tryGetContext(key),
};
validateFrameworkConfig(framework);
const deployment = resolveDeploymentInputs({
  getContext: (key) => app.node.tryGetContext(key),
  env: process.env,
  target: selection.target,
});
deployment.warnings.forEach((warning) => console.warn(warning));
const { stackEnv, mode } = deployment;

// The catalog branched on the mode while it was being imported. bin/main.ts
// decides it before that import; loading this file any other way would build a
// catalog for one graph and stacks for another, so it is refused.
if ((mode === "prod") !== PROD_DEPLOYMENT) {
  throw new Error(
    `This deployment resolved to ${mode} mode, but framework-config/resources.ts was evaluated for ${PROD_DEPLOYMENT ? "prod" : "dev"}. Run the app through bin/main.ts (cdk.json does), which sets the mode before the catalog loads.`,
  );
}
const stackId = (name: string) => `${deployment.deploymentName}-${name}`;

initializeFrameworkResources(app, {
  config: framework, mode, deployment: deployment.deploymentName,
  readers,
});

// Every declared edge whose caller this graph builds has a destination in it.
// Checked here, against the config, because a dev deployment holds only what
// AWS invokes: an event Lambda naming a task would otherwise fail much later as
// a missing registry handle, in a message about stacks rather than about the
// declaration that caused it. With DEPLOY_PROD_WEBSOCKET_API, that includes the
// WebSocket handlers, which API Gateway invokes.
assertCloudEdgesResolvable(framework, mode, { webSocketApi: deployment.deployProdWebSocketApi });

// Framework stack orchestration lives in the composition factories. Your own
// stacks go at the marked place below. Flags: docs/FRAMEWORK.md#configuration-and-environment.
//
// One resolved mode, threaded everywhere. No stack re-derives which graph this
// is from something else it can see.
const composition = { env: stackEnv, stackId, mode };

const frontendWebsiteS3Stack = mode === "prod"
  ? new FrontendWebsiteS3Stack(app, stackId("FrontendWebsiteS3Stack"), {
      env: stackEnv,
      enableCloudFront: true,
      useDynamicOrigins: !deployment.frontendDomainName,
      frontendDomainName: deployment.frontendDomainName,
      frontendCloudFrontCertificateArn: deployment.frontendDomainName
        ? deployment.configuredFrontendCloudFrontCertificateArn
        : undefined,
    })
  : undefined;

// The generated URL is available only after constructing the website. This
// explicit second stage supplies every auth/CORS consumer with the same values.
const frontend = resolveFrontendSettings(
  deployment,
  frontendWebsiteS3Stack?.cloudFrontUrl,
);

const foundation = createFrameworkFoundation(app, composition);

// Created only by a production deployment (-c prodDeployment=true).
const rdsStack = mode === "prod"
  ? new RdsStack(app, stackId("RdsStack"), {
      env: stackEnv,
      primaryDatabaseName: "app_db",
      retainStatefulResources: deployment.retainStatefulResources,
      backupRetentionDays: deployment.databaseBackupRetentionDays,
      databaseSettings: deployment.database,
    })
  : undefined;

// Preserve the established stack order and identities. Resource attachments are
// finalized only after every native construct has been linked.
const tasks = createFrameworkTasks(app, {
  env: stackEnv,
  stackId,
  config: framework,
  cloud: { mode },
  readers,
});
if (tasks.stack && rdsStack) {
  tasks.stack.addStackDependency(rdsStack);
}

// Events must exist before the AWS resources that invoke them: a stack reaches
// one with `eventFunction(this, id)`, so this ordering is the only thing the
// entrypoint has to say about them. Their narrow contract deliberately excludes
// the user pool's outputs.
const eventHandlers = new EventLambdaFunctionsStack(
  app,
  // Preserve the deployed stack identity while naming its purpose in code.
  stackId("AsynchronousLambdaFunctionsStack"),
  {
    env: stackEnv,
    config: framework,
    cloud: { mode },
    readers,
    replay: foundation.replay,
  },
);
if (foundation.replayStack) {
  eventHandlers.addStackDependency(foundation.replayStack);
}
if (tasks.stack) {
  // An event Lambda may declare `runsTask`, and its descriptor carries a value
  // from that stack. CDK adds the reference edge itself, but the ordering is
  // stated here so a task-launching event cannot be constructed first.
  eventHandlers.addStackDependency(tasks.stack);
}

// Create Cognito User Pool + Client + Identity Pool
const cognitoStack = new CognitoStack(app, stackId("CognitoStack"), {
  env: stackEnv,
  retainStatefulResources: deployment.retainStatefulResources,
  skipEmailVerification: frontend.skipEmailVerification,
  sesFromEmail: deployment.cognitoSesFromEmail,
  sesFromName: deployment.cognitoSesFromName,
  sesRegion: deployment.cognitoSesRegion,
  cognitoDomainPrefix: deployment.cognitoDomainPrefix,
  cognitoDomainName: deployment.cognitoDomainName,
  cognitoDomainCertificateArn: deployment.cognitoDomainCertificateArn,
  googleClientId: deployment.googleClientId,
  callbackUrls: frontend.authCallbackUrls,
  logoutUrls: frontend.cognitoFrontendUrls,
  // The resolved frontend settings this deployment's workloads read back as
  // `resources.cognito.trustedOriginsCsv`, `.frontendUrl` and
  // `.skipEmailVerification`. Handed to the stack that publishes them rather
  // than linked here one call at a time.
  trustedFrontendUrls: frontend.trustedFrontendUrls,
  frontendUrl: frontend.frontendUrl,
});

// ─── Your application stacks go here ───────────────────────────────────────
// Built after the event handlers, so a stack can attach a trigger with
// `eventFunction(this, id)`, and before the workflows, so a stack can bind a
// workflow integration beside its construct. A stack that only links
// resources can go anywhere: links resolve when finalizeFrameworkResources()
// runs at the end of this file. End each constructor with
// `linkResources(this, resources.<name>)`.
//
//   new OrdersStack(app, stackId("OrdersStack"), { env: stackEnv });

// ────────────────────────────────────────────────────────────────────────────

// Workflows and agents come after the events and tasks their graphs name, and
// before the routed workload factory whose handlers start and invoke them. They
// share one stack, so each may call the other; neither takes a provider
// contract, because they reference targets rather than resources.
const orchestration = createFrameworkOrchestration(app, {
  env: stackEnv,
  stackId,
  config: framework,
  mode,
  cognito: cognitoStack,
  dependencies: [eventHandlers, ...(tasks.stack ? [tasks.stack] : [])],
});

// Event Lambdas are collected from the app itself, whichever stack built them,
// so an event-owning application stack adds nothing here. Resource-only stacks
// supply catalog values above and need no entry either.
//
// `readers` is where declared deployment inputs are read from: the target's
// inputs file, resolved once at the top of this file.
const workloads = createFrameworkWorkloads(app, {
  env: stackEnv,
  stackId,
  config: framework,
  cloud: { mode },
  cognito: cognitoStack,
  ...(orchestration.agentcore ? { agentcore: orchestration.agentcore } : {}),
  readers,
  frontendUrls: frontend.trustedFrontendUrls,
  deployWebSocketApi: deployment.deployProdWebSocketApi,
  handlerDependencies: [
    cognitoStack,
    // A routed starter's descriptor and grants reference these stacks, so the
    // handlers wait for whichever of them this deployment built.
    ...(tasks.stack ? [tasks.stack] : []),
    ...(orchestration.stack ? [orchestration.stack] : []),
  ],
  httpApiDependencies: rdsStack ? [rdsStack] : [],
});
// Reported by reason, because the two are fixed in different places: the first
// by editing the target's `deploy`, the second by deploying with
// -c prodDeployment=true. This is where a developer finds out why the thing they
// declared is not in AWS.
if (workloads.skippedTargets.disabled.length > 0) {
  console.warn(
    `Skipping cloud-disabled framework targets: ${workloads.skippedTargets.disabled.join(", ")}`,
  );
}
if (workloads.skippedTargets.withoutWebSocketApi.length > 0) {
  console.warn(
    `Not built because this deployment has no WebSocket API (DEPLOY_PROD_WEBSOCKET_API is off): ${workloads.skippedTargets.withoutWebSocketApi.join(", ")}. They still run locally under the WebSocket dev server.`,
  );
}
if (workloads.skippedTargets.notInThisDeployment.length > 0) {
  console.warn(
    `Not built by this ${mode} deployment, which holds only what AWS invokes: ${workloads.skippedTargets.notInThisDeployment.join(", ")}. Run them locally with npm run dev:containers, or deploy a production target with -c prodDeployment=true.`,
  );
}

// Serve the API same-origin under /api/* so the refresh cookie can be
// SameSite=Lax rather than SameSite=None.
if (
  frontend.useSameOriginApiProxy &&
  workloads.httpApi &&
  frontendWebsiteS3Stack
) {
  frontendWebsiteS3Stack.addApiOrigin(workloads.httpApi.apiDomainName);
  if (!frontendWebsiteS3Stack.routingStore) {
    frontendWebsiteS3Stack.addStackDependency(workloads.httpApi);
  }
}

// Agents with declared browser routes stream at those same-origin paths,
// straight from AgentCore Runtime. Generated-domain routing looks up Runtime
// ARNs in the store so the website can be created before their Cognito authorizer.
if (
  frontend.useSameOriginApiProxy &&
  frontendWebsiteS3Stack &&
  orchestration.stack &&
  orchestration.agentcore &&
  orchestration.agentcore.browserAgents.length > 0
) {
  frontendWebsiteS3Stack.addAgentOrigins(orchestration.agentcore.region, orchestration.agentcore.browserAgents);
  if (!frontendWebsiteS3Stack.routingStore) {
    frontendWebsiteS3Stack.addStackDependency(orchestration.stack);
  }
}

if (frontendWebsiteS3Stack?.routingStore && workloads.httpApi) {
  new FrontendRouting(workloads.httpApi, "FrontendRouting", {
    routingStore: frontendWebsiteS3Stack.routingStore,
    apiDomainName: workloads.httpApi.apiDomainName,
    agents: orchestration.agentcore?.browserAgents ?? [],
  });
}

finalizeFrameworkResources(app);

// What the network holds and what it costs, when this deployment built one. A
// dev deployment never does.
const network = describeFrameworkNetwork(app);
if (network) console.warn(network);
const database = describeFrameworkDatabase(app);
if (database) console.warn(database);
