import { getFrameworkTargets, type FrameworkConfig } from "../src/config/index";

/**
 * Each tool and agent entry point uses the wrapper its declaration implies.
 *
 * `auth: true` on a tool is half a feature: the other half is
 * `authenticatedTool`, which verifies the user's token. A tool declared with
 * users but written with `tool()` would ignore the token and act as the
 * application; one written with `authenticatedTool` but declared without would
 * refuse every call, because no token is ever sent. A tool with no wrapper at
 * all is checked against no contract. Each of these is refused here, as
 * `localReplay` and `withLocalReplay` are paired.
 *
 * An agent's `agent("<id>", …)` names the declaration whose tools it is typed
 * against, so the id has to be the agent's own key.
 */

const AUTHENTICATED_TOOL_CALL = /\bauthenticatedTool\s*\(/;
const TOOL_CALL = /(?<![\w.])tool\s*\(/;
const AGENT_CALL = /\bagent\s*\(\s*["']([^"']+)["']/;

/** `read(reference)` is the entry module's source, or undefined when there is none. */
export function assertAgentCoreEntries(
  config: FrameworkConfig,
  read: (reference: string) => string | undefined,
): void {
  for (const target of getFrameworkTargets(config)) {
    if (target.role === "tool") {
      const source = read(target.reference);
      if (source === undefined) continue;
      const origin = `tools["${target.id}"]`;
      const declaredAuth = config.tools?.[target.id]?.auth === true;
      const usesAuthenticated = AUTHENTICATED_TOOL_CALL.test(source);
      if (declaredAuth && !usesAuthenticated) {
        throw new Error(
          `${origin} declares auth: true, but its handler does not use authenticatedTool. Export it as:\n  export const lambdaHandler = authenticatedTool(contract, async (input, session) => { ... });\nfrom "@repo/framework/runtime/tools".`,
        );
      }
      if (!declaredAuth && usesAuthenticated) {
        throw new Error(
          `${origin} uses authenticatedTool, but does not declare auth: true, so no user's token is ever sent and every call would be refused. Add auth: true, or use tool().`,
        );
      }
      if (!declaredAuth && !TOOL_CALL.test(source)) {
        throw new Error(
          `${origin}'s handler does not use tool(). Export it as:\n  export const lambdaHandler = tool(contract, async (input) => { ... });\nfrom "@repo/framework/runtime/tools", so its arguments and result are checked against its contract.`,
        );
      }
    }
    if (target.role === "agent") {
      const source = read(target.reference);
      if (source === undefined) continue;
      const origin = `agents["${target.id}"]`;
      const declared = AGENT_CALL.exec(source)?.[1];
      if (declared === undefined) {
        throw new Error(
          `${origin}'s index.ts does not export agent("${target.id}", contract). Export it as:\n  export const handler = agent("${target.id}", contract).stream(async function* (input, context) { ... });\nor .respond(async (input, context) => ...) for a contract with a response, from "@repo/framework/runtime/agentcore".`,
        );
      }
      if (declared !== target.id) {
        throw new Error(
          `${origin} exports agent("${declared}", ...). The id names the declaration whose tools the agent is typed and served against; write agent("${target.id}", ...).`,
        );
      }
    }
  }
}
