import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { IdentityService } from "../server/identity/service";
import { CognitoOperations } from "../server/identity/operations";
import type { DeployService } from "../server/deploy/service";
import type { CommandSpec, Runner } from "../server/deploy/process";

const cache = path.resolve(__dirname, "../../.cache/framework-studio/cognito-reference-tests");
mkdirSync(cache, { recursive: true });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { assert.ok(root.startsWith(cache + path.sep)); rmSync(root, { recursive: true }); } });
const selection = { profile: "dev", deployment: "new-app", region: "us-east-1" };
const poolId = "us-east-1_Original123", clientId = "originalpublicclient", account = "111122223333";

function harness() {
  const root = mkdtempSync(path.join(cache, "case-")); roots.push(root); writeFileSync(path.join(root, "package.json"), "{}");
  const calls: CommandSpec[] = [];
  const tags: Record<string, string> = { "framework:owner": "matts-aws-framework", "framework:deployment": "old-app", "framework:mode": "dev" };
  const state = { arn: `arn:aws:cognito-idp:${selection.region}:${account}:userpool/${poolId}`, clientPoolId: poolId, clientPresent: true, duplicateReference: false };
  const outputs: Record<string, string> = { UserPoolManagement: "external-reference", UserPoolOriginalDeployment: "old-app", UserPoolId: poolId, UserPoolClientId: clientId, UserPoolDomainUrl: "https://old-app.auth.us-east-1.amazoncognito.com" };
  const deploy = { targets: () => [{ name: selection.deployment, mode: "dev", account, region: selection.region }], observer: { status: async () => ({ ok: true, value: { context: { account }, detail: { stacks: ["new-app-CognitoStack", ...(state.duplicateReference ? ["new-app-OtherStack"] : [])].map(name => ({ name, identity: { deployment: selection.deployment, mode: "dev" } })) } } }) } } as unknown as Pick<DeployService, "targets" | "observer">;
  const run: Runner = async spec => {
    calls.push(spec);
    const operation = spec.args[1]!, query = spec.args[spec.args.indexOf("--query") + 1] ?? "";
    assert.doesNotMatch(query, /ClientSecret|client_secret|GetSecretValue/i);
    let value: unknown;
    if (operation === "list-stack-resources") value = [];
    else if (operation === "describe-stacks") value = Object.entries(outputs).map(([key, value]) => ({ key, value }));
    else if (operation === "describe-user-pool") value = query.includes("tags:") ? { id: poolId, arn: state.arn, tags } : { name: "Original users", deletionProtection: "ACTIVE", estimatedUsers: 3 };
    else if (operation === "describe-user-pool-client") {
      assert.equal(spec.args[spec.args.indexOf("--user-pool-id") + 1], poolId);
      assert.equal(spec.args[spec.args.indexOf("--client-id") + 1], clientId);
      if (!state.clientPresent) return { code: 1, stdout: "", stderr: "ResourceNotFoundException private-sentinel" };
      value = query.includes("poolId:") ? { id: clientId, poolId: state.clientPoolId } : { id: clientId, callbacks: ["https://app.example.com/auth/callback"], logout: ["https://app.example.com/"], providers: ["COGNITO"] };
    } else if (operation === "list-user-pool-clients") value = [clientId];
    else if (operation === "list-identity-providers") value = [];
    else if (operation === "list-groups") value = [{ name: "original-group", precedence: 10 }];
    else if (operation === "list-users") value = { users: [{ username: "retained-test-user", enabled: true, status: "CONFIRMED" }] };
    else throw new Error(`Unexpected operation ${operation}`);
    return { code: 0, stdout: JSON.stringify(value), stderr: "" };
  };
  return { root, calls, tags, state, outputs, service: new IdentityService(root, deploy, run, {}) };
}

test("read-only Cognito inspection follows verified reference outputs and reports original ownership/client identity", async () => {
  const h = harness(), result = await h.service.cognito(selection);
  assert.equal(result.poolId, poolId);
  assert.equal(result.management, "external-reference");
  assert.equal(result.originalDeployment, "old-app");
  assert.equal(result.selectedClientId, clientId);
  assert.equal(result.users[0]?.username, "retained-test-user");
  assert.equal(result.groups[0]?.name, "original-group");
  assert.match(result.warnings.join(" "), /externally managed.*mutations are unavailable/);
  assert.ok(h.calls.every(call => /^(list-|describe-)/.test(call.args[1]!)));
});

test("user/group mutation review refuses the externally managed reference ownership scope without a user operation", async () => {
  const h = harness();
  await assert.rejects(h.service.verifiedUserPool(selection), /only references an externally managed retained User Pool/);
  const operations = new CognitoOperations(h.root, h.service, async () => { throw new Error("No user or group API may execute"); }, {});
  await assert.rejects(operations.review(selection, { action: "disable-user", username: "retained-test-user" }), /externally managed/);
  assert.equal(operations.history().length, 0);
  assert.ok(!h.calls.some(call => /^(admin-|create-|update-|delete-)/.test(call.args[1]!)));
});

test("reference observations reject conflicting original ownership, mode, account and region before listing users", async () => {
  for (const corrupt of [
    (h: ReturnType<typeof harness>) => { h.tags["framework:deployment"] = "another-app"; },
    (h: ReturnType<typeof harness>) => { h.tags["framework:mode"] = "prod"; },
    (h: ReturnType<typeof harness>) => { delete h.tags["framework:owner"]; },
    (h: ReturnType<typeof harness>) => { h.state.arn = h.state.arn.replace(account, "999988887777"); },
    (h: ReturnType<typeof harness>) => { h.state.arn = h.state.arn.replace("us-east-1:", "us-west-2:"); },
  ]) {
    const h = harness(); corrupt(h);
    await assert.rejects(h.service.cognito(selection), /original framework ownership differs/);
    assert.ok(!h.calls.some(call => call.args[1] === "list-users"));
  }
});

test("incomplete or ambiguous deployed reference outputs cannot select a pool by a guessed name", async () => {
  for (const corrupt of [
    (h: ReturnType<typeof harness>) => { delete h.outputs.UserPoolManagement; },
    (h: ReturnType<typeof harness>) => { delete h.outputs.UserPoolClientId; },
    (h: ReturnType<typeof harness>) => { h.outputs.UserPoolId = "us-west-2_Another123"; },
    (h: ReturnType<typeof harness>) => { h.state.duplicateReference = true; },
  ]) {
    const h = harness(); corrupt(h);
    await assert.rejects(h.service.cognito(selection), /exactly one|userPoolClientId|userPoolId/);
    assert.ok(!h.calls.some(call => call.args[1] === "list-users"));
  }
});

test("missing or changed selected app client fails safely without listing retained users", async () => {
  const missing = harness(); missing.state.clientPresent = false;
  await assert.rejects(missing.service.cognito(selection), error => error instanceof Error && /AWS read failed/.test(error.message) && !error.message.includes("sentinel"));
  const changed = harness(); changed.state.clientPoolId = "us-east-1_Another123";
  await assert.rejects(changed.service.cognito(selection), /belongs to another pool/);
  for (const h of [missing, changed]) assert.ok(!h.calls.some(call => call.args[1] === "list-users"));
});
