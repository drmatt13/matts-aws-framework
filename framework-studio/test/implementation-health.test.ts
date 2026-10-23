import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defineFrameworkConfig } from "@repo/framework/config";
import { defaults } from "../../framework-config/defaults";
import { withImplementationHealth } from "../server/implementation";
import { projectModel } from "../server/model/project";

test("implementation health reuses canonical tool, agent and Cognito verifier checks against overlays", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "studio-implementation-health-"));
  const tool = path.join(root, "cdk-app/lambda_functions/tool_functions/check-tool/index.ts"), http = path.join(root, "cdk-app/lambda_functions/http_functions/check-http/index.ts"), agent = path.join(root, "agents/check-agent/index.ts");
  for (const file of [tool, http, agent]) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, ""); writeFileSync(path.join(path.dirname(file), "contract.ts"), "export const contract = {};\n"); }
  const cognito = { USER_POOL_ID: "fixture", USER_POOL_CLIENT_ID: "fixture" };
  const config = defineFrameworkConfig({ defaults, http: [{ "/check": { directory: "/lambda_functions/http_functions/check-http", methods: ["GET"] } }], tools: [{ "check-tool": { auth: true, environment: cognito } }], agents: [{ "check-agent": { auth: true, tools: ["check-tool"], environment: cognito } }], webSocket: [], events: [], services: [] });
  const projected = projectModel(config, { mode: "dev", webSocketApi: false });
  try {
    const bad = withImplementationHealth(config, projected, root, { [tool]: "export const lambdaHandler = tool(contract, async () => ({}));", [http]: 'import { authenticated as signedIn } from "@repo/framework/runtime/auth";\nexport const lambdaHandler = signedIn(async () => ({}));', [agent]: 'export const handler = agent("other-agent", contract).respond(async () => ({}));' });
    assert.match(bad.targets.find(target => target.ref === "lambda:check-tool")!.implementation!.problems.join("\n"), /authenticatedTool/);
    assert.match(bad.targets.find(target => target.ref === "lambda:check-http")!.implementation!.problems.join("\n"), /userPool/);
    assert.match(bad.targets.find(target => target.ref === "agent:check-agent")!.implementation!.problems.join("\n"), /other-agent/);
    const good = withImplementationHealth(config, projected, root, { [tool]: "export const lambdaHandler = authenticatedTool(contract, async () => ({}));", [http]: 'export * from "./implementation";', [agent]: 'export const handler = agent("check-agent", contract).respond(async () => ({}));' });
    assert.ok(good.targets.every(target => target.implementation?.ready));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
