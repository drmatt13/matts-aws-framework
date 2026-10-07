import { defineFrameworkConfig } from "@repo/framework/config";
import { defaults } from "./framework-config/defaults";
import { resources } from "./framework-config/resources";
import { authRoutes } from "./framework-config/http/auth";
import { graphqlRoutes } from "./framework-config/http/graphql";
import { exampleRoutes } from "./framework-config/http/examples";
import { invocationTestRoutes } from "./framework-config/http/invocation-tests";
import { webSocketRoutes } from "./framework-config/websocket/routes";
import { cognitoEvents } from "./framework-config/events/cognito";
import { invocationTestEvents } from "./framework-config/events/invocation-tests";
import { exampleService } from "./framework-config/services/example";
import { invocationTestTasks } from "./framework-config/tasks/invocation-tests";
import { capabilityWorkflows } from "./framework-config/workflows/capabilities";
import { invocationTestWorkflows } from "./framework-config/workflows/invocation-tests";
import { exampleTools } from "./framework-config/tools/example";
import { exampleAgent } from "./framework-config/agents/example";

/**
 * The repository's inventory: every target, grouped by how it is invoked.
 *
 * This file composes rather than declares. Each section is one or more modules
 * under `framework-config/`, named for the architecture it describes, so a new
 * API surface is a new file and two of them can be written in parallel without
 * touching the same lines. A section listed as an array is merged in the order
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
  http: [authRoutes, graphqlRoutes, exampleRoutes, invocationTestRoutes],
  webSocket: [webSocketRoutes],
  events: [cognitoEvents, invocationTestEvents],
  services: [exampleService],
  tasks: [invocationTestTasks],
  workflows: [invocationTestWorkflows, capabilityWorkflows],
  tools: [exampleTools],
  agents: [exampleAgent],
});

export default framework;
