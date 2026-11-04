import assert from "node:assert/strict";
import test from "node:test";
import {
  defineFrameworkConfig,
  resolveLambdaTarget,
  type LambdaTargetDefinition,
} from "../src/config/index";
import { defaults } from "../../../framework-config/defaults";

function config(settings: LambdaTargetDefinition = {}) {
  return defineFrameworkConfig({
    defaults,
    http: [{ "/concurrency": { directory: "/lambda_functions/http_functions/concurrency", methods: ["GET"], ...settings } }],
    webSocket: [], events: [], services: [],
  });
}

test("Lambda concurrency is absent by default and either reservation can be configured independently", () => {
  const disabled = resolveLambdaTarget(config(), "concurrency");
  assert.equal(disabled.reservedConcurrentExecutions, undefined);
  assert.equal(disabled.provisionedConcurrentExecutions, undefined);
  const reserved = resolveLambdaTarget(config({ reservedConcurrentExecutions: 0 }), "concurrency");
  assert.equal(reserved.reservedConcurrentExecutions, 0, "zero intentionally stops invocations");
  assert.equal(reserved.provisionedConcurrentExecutions, undefined);
  const provisioned = resolveLambdaTarget(config({ provisionedConcurrentExecutions: 3 }), "concurrency");
  assert.equal(provisioned.reservedConcurrentExecutions, undefined);
  assert.equal(provisioned.provisionedConcurrentExecutions, 3);
  const both = resolveLambdaTarget(config({ reservedConcurrentExecutions: 3, provisionedConcurrentExecutions: 3 }), "concurrency");
  assert.equal(both.reservedConcurrentExecutions, 3);
  assert.equal(both.provisionedConcurrentExecutions, 3);
});

test("Lambda concurrency rejects nonnumeric, fractional, negative, and unsafe integer values", () => {
  for (const field of ["reservedConcurrentExecutions", "provisionedConcurrentExecutions"] as const) {
    for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "2", true, null]) {
      assert.throws(() => resolveLambdaTarget(config({ [field]: value } as never), "concurrency"), new RegExp(field), `${field}: ${String(value)}`);
    }
  }
  assert.throws(() => resolveLambdaTarget(config({ provisionedConcurrentExecutions: 0 }), "concurrency"), /provisionedConcurrentExecutions/);
});

test("provisioned concurrency cannot exceed a function's configured reserved concurrency", () => {
  for (const reservedConcurrentExecutions of [0, 2]) {
    assert.throws(() => resolveLambdaTarget(config({ reservedConcurrentExecutions, provisionedConcurrentExecutions: 3 }), "concurrency"), /provisioned.*reserved|reserved.*provisioned/i);
  }
});

test("HTTP, WebSocket, authorizer, event, and tool declarations retain their own concurrency settings", () => {
  const settings = { reservedConcurrentExecutions: 4, provisionedConcurrentExecutions: 2 } as const;
  const framework = defineFrameworkConfig({
    defaults,
    http: [{ "/http": { directory: "/lambda_functions/http_functions/http", methods: ["GET"], ...settings } }],
    webSocket: [{ $connect: {
      directory: "/lambda_functions/websocket_functions/connect", ...settings,
      authorizer: { directory: "/lambda_functions/websocket_functions/authorizer", ...settings },
    } }],
    events: [{ event: settings }], tools: [{ tool: settings }], services: [],
  });
  for (const id of ["http", "connect", "authorizer", "event", "tool"]) {
    const resolved = resolveLambdaTarget(framework, id);
    assert.equal(resolved.reservedConcurrentExecutions, 4, id);
    assert.equal(resolved.provisionedConcurrentExecutions, 2, id);
  }
});
