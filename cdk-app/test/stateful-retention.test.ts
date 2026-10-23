import assert from "node:assert/strict";
import test from "node:test";
import { resolveDeploymentInputs } from "../deployment";
import { resolveStatefulResources } from "../stateful-resources";

const inputs = (context: Record<string, unknown> = {}, env: Record<string, string> = {}, statefulResources?: Parameters<typeof resolveDeploymentInputs>[0]["statefulResources"]) => resolveDeploymentInputs({ getContext: key => context[key], env: { CDK_DEFAULT_ACCOUNT: "734849394764", CDK_DEFAULT_REGION: "us-east-1", ...env }, statefulResources });
test("unspecified per-resource policies preserve every legacy precedence and default", () => {
  for (const [context, env, expected] of [[{}, {}, false], [{}, { RETAIN_STATEFUL_RESOURCES: "true" }, true], [{ retainStatefulResouces: true }, { RETAIN_STATEFUL_RESOURCES: "false" }, true], [{ retainStatefulResources: false, retainStatefulResouces: true }, { RETAIN_STATEFUL_RESOURCES: "true" }, false]] as const) {
    const result = inputs(context, env);
    assert.equal(result.databaseRetention, expected);
    assert.equal(result.cognitoRetention, expected);
    assert.equal(result.stateful.database.retentionSource, "legacy");
  }
  assert.throws(() => inputs({}, { RETAIN_STATEFUL_RESOURCES: "typo" }, { dev: { database: { retention: "retain" }, cognito: { retention: "retain" } } }), /must be "true" or "false"/);
});
test("each resource and environment resolves independently while incomplete source inherits legacy", () => {
  const configuration = { dev: { database: { retention: "remove" as const }, cognito: { retention: "retain" as const } }, prod: { database: { retention: "retain" as const } } };
  assert.deepEqual([inputs({}, {}, configuration).databaseRetention, inputs({}, {}, configuration).cognitoRetention], [false, true]);
  assert.deepEqual([inputs({ prodDeployment: true }, {}, configuration).databaseRetention, inputs({ prodDeployment: true }, {}, configuration).cognitoRetention], [true, false]);
  assert.equal(inputs({ prodDeployment: true }, { RETAIN_STATEFUL_RESOURCES: "true" }, configuration).cognitoRetention, true);
  assert.throws(() => resolveStatefulResources({ dev: { database: { retention: "typo" } } } as any, "dev", false), /must be retain or remove/);
  assert.throws(() => resolveStatefulResources({ staging: {} } as any, "dev", false), /only dev and prod/);
  assert.throws(() => resolveStatefulResources({ dev: { database: { reference: {} } } } as any, "dev", false), /local PostgreSQL/);
});
