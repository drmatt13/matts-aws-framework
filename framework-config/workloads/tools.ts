import type { ToolsSection } from "../contracts";

/** Tools declarations. Tags describe concerns independently of this module. */
export const tools = {
  /** Lambda tools exposed through the example agent's Gateway. */

  "add-numbers": {
    directory: "/lambda_functions/tool_functions/add-numbers",
    tags: { area: "examples" },
  },
  "multiply-numbers": {
    directory: "/lambda_functions/tool_functions/multiply-numbers",
    tags: { area: "examples" },
  },
} satisfies ToolsSection;
