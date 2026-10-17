import { runsTask } from "@repo/framework/config";
import type { HttpSection } from "../contracts";
import { resources } from "../resources";

/** The authenticated starter used by the frontend's Tasks panel. */
export const taskRoutes = {
  "/test/run-task": {
    directory: "/lambda_functions/http_functions/test-run-task",
    methods: ["POST"],
    auth: true,
    // The AWS SDK's first ECS call is not free on a cold start.
    memorySize: 256,
    timeoutSeconds: 15,
    deploy: "both",
    userPool: true,
    environment: { TRUSTED_FRONTEND_ORIGINS: resources.cognito.trustedOriginsCsv },
    cloud: { bindings: [runsTask("invocation-test-task")] },
  },
} satisfies HttpSection;
