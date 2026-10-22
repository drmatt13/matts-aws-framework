import { defineFrameworkConfig } from "@repo/framework/config";
import { defaults } from "./framework-config/defaults";
import { resources } from "./framework-config/resources";
import { applicationVpc } from "./framework-config/networks/application";
import { studioTestVpc } from "./framework-config/networks/test";
import { applicationDatabase } from "./framework-config/databases/application";
import { http } from "./framework-config/workloads/http";
import { webSocket } from "./framework-config/workloads/websocket";
import { events } from "./framework-config/workloads/events";
import { services } from "./framework-config/workloads/services";
import { tasks } from "./framework-config/workloads/tasks";
import { workflows } from "./framework-config/workloads/workflows";
import { tools } from "./framework-config/workloads/tools";
import { agents } from "./framework-config/workloads/agents";

/**
 * The repository's inventory: every target, grouped by how it is invoked.
 *
 * This file composes rather than declares. Each workload kind has one readable
 * module under `framework-config/workloads/`; tags describe concerns across kinds.
 * A growing section may explicitly compose smaller modules. Arrays merge in the order
 * written, and a key declared by two modules is an error naming both — which is
 * why sections compose as an array here and never as an object spread.
 *
 * The resource catalog is re-exported rather than declared: section modules
 * reference it, so it lives in `framework-config/resources.ts` where importing
 * it cannot cycle back through this file.
 */

export { resources } from "./framework-config/resources";

const framework = defineFrameworkConfig({
  resources,
  defaults,
  networks: [applicationVpc, studioTestVpc],
  // What a workload reaches by declaring database: true. Built only by a
  // production deployment; locally, the Compose Postgres stands in for it.
  database: applicationDatabase,
  // What a workload's userPool: true is handed, as USER_POOL_ID and
  // USER_POOL_CLIENT_ID, and what an auth: true tool or agent verifies its
  // caller against. The HTTP API's and AgentCore's authorizers check the same
  // pool, which bin/cdk-app.ts hands them as cognitoStack.
  userPool: {
    userPoolId: resources.cognito.userPool.userPoolId,
    userPoolClientId: resources.cognito.userPoolClient.userPoolClientId,
  },
  http: [http],
  webSocket: [webSocket],
  events: [events],
  services: [services],
  tasks: [tasks],
  workflows: [workflows],
  tools: [tools],
  agents: [agents],
});

export default framework;
