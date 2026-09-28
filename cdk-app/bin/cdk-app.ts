#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import * as path from "path";
import {
  createFrameworkFoundation,
  createFrameworkTasks,
  createFrameworkWorkflows,
  createFrameworkWorkloads,
} from "../lib/framework/framework-composition";
// lib/app: this application's own infrastructure.
import { WorkflowFixturesStack } from "../lib/app/workflow-fixtures-stack";
import { CognitoStack } from "../lib/app/cognito-stack";
import { FrontendWebsiteS3Stack } from "../lib/app/frontend-website-s3-stack";
import { RdsStack } from "../lib/app/rds-stack";
import { EventLambdaFunctionsStack } from "../lib/framework/event-lambda-functions-stack";
import { assertCloudEdgesResolvable, validateFrameworkConfig } from "@repo/framework/config";
import { PROD_DEPLOYMENT, readAuthoredInputs } from "@repo/framework/config/source";
import { initializeFrameworkResources, finalizeFrameworkResources } from "../lib/framework/framework-resources";
import framework from "../../framework.config";

import {
  loadDeploymentEnvironment,
  resolveDeploymentInputs,
  resolveFrontendSettings,
} from "../deployment";

const repositoryRoot = path.join(__dirname, "..", "..");

// Deployment flags — which account, which domain, which optional stacks — are
// read from the process environment with cdk-app/.env loaded behind it. The
// graph itself (PROD_DEPLOYMENT) is decided by that file alone; see the check
// below.
loadDeploymentEnvironment(path.join(__dirname, "..", ".env"));
const app = new cdk.App();

// Declared resource inputs are *not* read from the process environment. Every
// `.fromEnv()` in framework-config/resources.ts resolves against cdk-app/.env
// itself, which is the same file and the same line `docker compose up` reads,
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
});
deployment.warnings.forEach((warning) => console.warn(warning));
const { stackEnv, mode } = deployment;

// The catalog branched on PROD_DEPLOYMENT while it was being imported, and a
// `-c` override cannot reach back into that decision. Refused here rather than
// left to surface as a resource nothing linked: a graph whose stacks and whose
// catalog disagree about whether there is a database is not a graph worth
// synthesizing.
if ((mode === "prod") !== PROD_DEPLOYMENT) {
  throw new Error(
    `This deployment resolved to ${mode} mode, but framework-config/resources.ts was built with PROD_DEPLOYMENT=${PROD_DEPLOYMENT} from cdk-app/.env. The catalog is read from that file and a -c override cannot change it. Set PROD_DEPLOYMENT=${mode === "prod"} in cdk-app/.env.`,
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
// declaration that caused it.
assertCloudEdgesResolvable(framework, mode);

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

// Created only by a full deployment (PROD_DEPLOYMENT=true).
const rdsStack = mode === "prod"
  ? new RdsStack(app, stackId("RdsStack"), {
      env: stackEnv,
      enableRdsProxy: deployment.enableRdsProxy,
      primaryDatabaseName: "app_db",
      primaryDatabaseUsername: "app_user",
      retainStatefulResources: deployment.retainStatefulResources,
      backupRetentionDays: deployment.databaseBackupRetentionDays,
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
  network: deployment.taskNetwork,
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

// Dev only: the resources the capability-check workflow exercises.
if (mode === "dev") {
  new WorkflowFixturesStack(app, stackId("WorkflowFixturesStack"), { env: stackEnv });
}
// ────────────────────────────────────────────────────────────────────────────

// Workflows come after the events and tasks their graphs name, and before the
// routed workload factory whose starter Lambdas bind them. A workflow
// references targets rather than resources, so it takes no provider contract.
const workflows = createFrameworkWorkflows(app, {
  env: stackEnv,
  stackId,
  config: framework,
  mode,
  dependencies: [eventHandlers, ...(tasks.stack ? [tasks.stack] : [])],
});

// Event Lambdas are collected from the app itself, whichever stack built them,
// so an event-owning application stack adds nothing here. Resource-only stacks
// supply catalog values above and need no entry either.
//
// `readers` is where declared deployment inputs are read from: cdk-app/.env,
// resolved once at the top of this file.
const workloads = createFrameworkWorkloads(app, {
  env: stackEnv,
  stackId,
  config: framework,
  cloud: { mode },
  cognito: cognitoStack,
  readers,
  frontendUrls: frontend.trustedFrontendUrls,
  deployWebSocketApi: deployment.deployWebSocketApi,
  handlerDependencies: [
    cognitoStack,
    // A routed starter's descriptor and grants reference these stacks, so the
    // handlers wait for whichever of them this deployment built.
    ...(tasks.stack ? [tasks.stack] : []),
    ...(workflows.stack ? [workflows.stack] : []),
  ],
  httpApiDependencies: rdsStack ? [rdsStack] : [],
});
// Reported by reason, because the two are fixed in different places: the first
// by editing the target's `deploy`, the second by deploying with
// PROD_DEPLOYMENT=true. This is where a developer finds out why the thing they
// declared is not in AWS.
if (workloads.skippedTargets.disabled.length > 0) {
  console.warn(
    `Skipping cloud-disabled framework targets: ${workloads.skippedTargets.disabled.join(", ")}`,
  );
}
if (workloads.skippedTargets.withoutWebSocketApi.length > 0) {
  console.warn(
    `Not built because this deployment has no WebSocket API (DEPLOY_WEBSOCKET_API is off): ${workloads.skippedTargets.withoutWebSocketApi.join(", ")}. They still run locally under the WebSocket dev server.`,
  );
}
if (workloads.skippedTargets.notInThisDeployment.length > 0) {
  console.warn(
    `Not built by this ${mode} deployment, which holds only what AWS invokes: ${workloads.skippedTargets.notInThisDeployment.join(", ")}. Run them locally with npm run dev, or deploy with PROD_DEPLOYMENT=true.`,
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
  frontendWebsiteS3Stack.addStackDependency(workloads.httpApi);
}

finalizeFrameworkResources(app);
