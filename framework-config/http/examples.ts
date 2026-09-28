import type { HttpSection } from "../contracts";

/**
 * Reference endpoints kept deployable on purpose, so the paths a new handler
 * copies are ones that are known to build.
 */
export const exampleRoutes = {
  "/examples/python": {
    directory: "/lambda_functions/http_functions/python-example",
    methods: ["POST"],
    auth: true,
    packaging: "container",
  },
} satisfies HttpSection;
