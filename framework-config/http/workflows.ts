import { startsWorkflow } from "@repo/framework/config";
import type { HttpSection } from "../contracts";
import { resources } from "../resources";

/** The authenticated starter used by the frontend's Workflows panel. */
export const workflowRoutes = {
  "/test/start-workflow": {
    directory: "/lambda_functions/http_functions/test-start-workflow",
    methods: ["POST"],
    auth: true,
    memorySize: 256,
    timeoutSeconds: 15,
    deploy: "both",
    userPool: true,
    environment: { TRUSTED_FRONTEND_ORIGINS: resources.cognito.trustedOriginsCsv },
    cloud: { bindings: [startsWorkflow("invocation-test-workflow")] },
  },
} satisfies HttpSection;
