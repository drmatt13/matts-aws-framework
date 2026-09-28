import { runsTask, startsWorkflow } from "@repo/framework/config";
import type { HttpSection } from "../contracts";
import { resources } from "../resources";

/**
 * Routed callers of the invocation and workflow capability smoke tests.
 *
 * They are ordinary HTTP targets so the same handler can be exercised through
 * the local dev API and the deployed HTTP API, and so the workflow starter
 * respects v1's rule that a runtime `startWorkflow` caller is a routed Lambda or
 * a service. Nothing about them belongs in an API stack or a dev server: the
 * routes and the bindings are declared here, and the section is composed by the
 * root config as one more array entry.
 *
 * Each starter gets only its own binding. `test-start-workflow` holds no grant
 * on the task or the activity Lambda — the workflow derives those for the state
 * machine's role, which is what makes "the workflow really ran" observable
 * rather than assumed.
 */
const invocationTestEnvironment = {
  USER_POOL_ID: resources.cognito.userPool.userPoolId,
  USER_POOL_CLIENT_ID: resources.cognito.userPoolClient.userPoolClientId,
  TRUSTED_FRONTEND_ORIGINS: resources.cognito.trustedOriginsCsv,
};

export const invocationTestRoutes = {
  "/test/run-task": {
    directory: "/lambda_functions/http_functions/test-run-task",
    methods: ["POST"],
    auth: true,
    // The AWS SDK's first ECS call is not free on a cold start.
    memorySize: 256,
    timeoutSeconds: 15,
    deploy: "both",
    environment: { ...invocationTestEnvironment },
    cloud: {
      bindings: [runsTask("invocation-test-task")],
    },
  },
  "/test/start-workflow": {
    directory: "/lambda_functions/http_functions/test-start-workflow",
    methods: ["POST"],
    auth: true,
    memorySize: 256,
    timeoutSeconds: 15,
    deploy: "both",
    environment: { ...invocationTestEnvironment },
    cloud: {
      bindings: [startsWorkflow("invocation-test-workflow")],
    },
  },
  "/test/capability-check": {
    directory: "/lambda_functions/http_functions/test-capability-check",
    methods: ["POST"],
    auth: true,
    deploy: "local-only",
    environment: { ...invocationTestEnvironment },
    cloud: { bindings: [startsWorkflow("capability-check")] },
  },
} satisfies HttpSection;
