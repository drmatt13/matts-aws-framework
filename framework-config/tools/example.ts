import type { ToolsSection } from "../contracts";

/** Lambda tools exposed through the example agent's Gateway. */
export const exampleTools = {
  "add-numbers": {
    directory: "/lambda_functions/tool_functions/add-numbers",
    deploy: "local-only",
  },
  "multiply-numbers": {
    directory: "/lambda_functions/tool_functions/multiply-numbers",
    deploy: "local-only",
  },
} satisfies ToolsSection;
