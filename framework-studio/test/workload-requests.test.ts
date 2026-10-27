import assert from "./support/assert";
import test from "node:test";
import { readDraftEdits } from "../server/server";
import { creationDefaults } from "../shared/creation";
import { grantOptions } from "../shared/grants";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { projectModel } from "../server/model/project";
import { planConnection } from "../server/edits/connections";
import type { StudioState } from "../server/snapshot";
import type { FrameworkConfig } from "@repo/framework/config";

test("the batch HTTP parser accepts implementation, connection, removal and new creator requests", () => {
  const operations = [
    { kind: "implementation", target: "lambda:orders" },
    { kind: "removeWorkload", target: "service:reports" },
    ...["database", "userPool"].map(connection => ({ kind: "connection", target: "lambda:orders", connection, enabled: true })),
    { kind: "connection", target: "lambda:orders", connection: "resource", destination: "resource:providerKey", variable: "PROVIDER_SECRET_ARN", enabled: true },
    { kind: "connection", target: "lambda:orders", connection: "grant", destination: "resource:uploads.bucket", grant: "grantRead", scope: "tenant/*", enabled: true },
    { kind: "connection", target: "agent:support", connection: "tool", destination: "lambda:lookup", enabled: true },
    { kind: "connection", target: "lambda:orders", connection: "runsTask", destination: "task:export", enabled: false },
  ];
  assert.deepEqual(readDraftEdits(operations), operations);
  assert.equal(readDraftEdits([{ kind: "create", request: { kind: "tool", ...creationDefaults("tool"), id: "lookup" } }])[0]!.kind, "create");
  assert.equal(readDraftEdits([{ kind: "create", request: { kind: "agent", ...creationDefaults("agent"), id: "echo", directory: "/agents/echo" } }])[0]!.kind, "create");
});

test("HTTP workload operations reject arbitrary writes, unrecognized grants and malformed references", () => {
  for (const operation of [
    { kind: "implementation", target: "lambda:orders", source: "private-do-not-reflect" },
    { kind: "implementation", target: "../../elsewhere" },
    { kind: "removeWorkload", target: "lambda:orders", file: "package.json" },
    { kind: "connection", target: "lambda:orders", connection: "grant", destination: "resource:uploads.bucket", grant: "grantAdministrator", enabled: true },
    { kind: "connection", target: "lambda:orders", connection: "grant", destination: "resource:uploads.bucket", grant: "constructor", enabled: true },
    { kind: "connection", target: "lambda:orders", connection: "grant", destination: "resource:uploads.bucket", grant: ["grantRead"], enabled: true },
    { kind: "connection", target: "lambda:orders", connection: "resource", variable: "bad name", enabled: true },
  ]) assert.throws(() => readDraftEdits([operation]), error => error instanceof Error && !error.message.includes("private-do-not-reflect"));
});

test("every configured service permission survives HTTP review parsing for add and remove", () => {
  const services = ["aws-s3:IBucket", "aws-sqs:IQueue", "aws-dynamodb:ITable", "aws-sns:ITopic", "aws-events:IEventBus"];
  for (const service of services) {
    const choices = grantOptions([service]);
    assert.ok(choices.length, `No permissions offered for ${service}`);
    for (const choice of choices) for (const enabled of [true, false]) {
      const operation = { kind: "connection", target: "lambda:orders", connection: "grant", destination: "resource:store.resource", grant: choice.method, scope: choice.scope ? "tenant/*" : "", enabled };
      assert.deepEqual(readDraftEdits([operation]), [operation], `${service}: ${choice.method}`);
    }
  }
});

test("configured service grants pass HTTP parsing and support exact add, duplicate rejection and removal", () => {
  const parent = path.resolve(__dirname, "../../.cache/framework-studio");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, "grant-request-"));
  const file = path.join(root, "framework.config.ts");
  writeFileSync(file, 'import { defineFrameworkConfig } from "@repo/framework/config"; export default defineFrameworkConfig({ http: [{ "/caller": { directory: "/lambda_functions/caller", methods: ["GET"] } }], webSocket: [], events: [], services: [] });');
  const base = projectModel({ defaults: { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: {} } }, http: { "/caller": { directory: "/lambda_functions/caller", methods: ["GET"] } }, webSocket: {}, events: {}, services: {}, tasks: {}, workflows: {} } as FrameworkConfig, { mode: "prod" });
  const resource = { id: "resource:store.data", path: ["store", "data"], kind: "member", absent: false };
  const model = { ...base, resources: [resource] };
  try {
    for (const service of ["aws-s3:IBucket", "aws-sqs:IQueue", "aws-dynamodb:ITable", "aws-sns:ITopic", "aws-events:IEventBus"]) {
      const state = { snapshot: { models: { dev: model, prod: model }, source: { triggerCapabilities: [{ resource: resource.id, canonicalTypes: [service] }] } } } as unknown as StudioState;
      for (const choice of grantOptions([service])) {
        const [operation] = readDraftEdits([{ kind: "connection", target: "lambda:caller", connection: "grant", destination: resource.id, grant: choice.method, scope: choice.scope ? "tenant/*" : "", enabled: true }]);
        assert.ok(operation?.kind === "connection");
        const overrides = new Map<string, string>();
        planConnection(root, state, operation, overrides);
        assert.ok(overrides.get(file)?.includes(`.${choice.method}(`), choice.method);
        assert.throws(() => planConnection(root, state, operation, overrides), /exact native grant already exists/);
        if (choice.scope) planConnection(root, state, { ...operation, scope: "other/*" }, overrides);
        planConnection(root, state, { ...operation, enabled: false }, overrides);
        assert.ok(!overrides.get(file)?.includes(choice.scope ? `.${choice.method}("tenant/*")` : `.${choice.method}()`), choice.method);
        if (choice.scope) assert.ok(overrides.get(file)?.includes(`.${choice.method}("other/*")`), "Removing one scope preserves the other");
      }
    }
  } finally { rmSync(root, { recursive: true }); }
});
