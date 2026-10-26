import assert from "./support/assert";
import test from "node:test";
import { readDraftEdits } from "../server/server";
import { creationDefaults } from "../shared/creation";

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
    { kind: "connection", target: "lambda:orders", connection: "resource", variable: "bad name", enabled: true },
  ]) assert.throws(() => readDraftEdits([operation]), error => error instanceof Error && !error.message.includes("private-do-not-reflect"));
});
