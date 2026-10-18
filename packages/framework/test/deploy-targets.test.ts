import assert from "node:assert/strict";
import test from "node:test";
import { modeFromContext, parseTargets, selectTarget, TARGETS_CONTEXT_KEY } from "@repo/framework/deploy";

const declared = parseTargets({
  "my-aws-app-prod": { mode: "prod", account: "734800004764", region: "us-east-1", inputs: "cdk-app/.env.prod" },
  "team-dev": { mode: "dev" },
});
const get = (context: Record<string, unknown>) => (key: string) => context[key];

test("the targets context key is the framework's", () => {
  assert.equal(TARGETS_CONTEXT_KEY, "framework:targets");
});

test("declared targets are validated", () => {
  assert.deepEqual(declared.map((target) => [target.name, target.mode, target.account]), [["my-aws-app-prod", "prod", "734800004764"], ["team-dev", "dev", undefined]]);
  assert.deepEqual(parseTargets(undefined), []);
  assert.throws(() => parseTargets({ "Bad Name": { mode: "dev" } }), /lowercase/);
  assert.throws(() => parseTargets({ app: { mode: "staging" } }), /mode must be "dev" or "prod"/);
  assert.throws(() => parseTargets({ app: { mode: "prod" } }), /production target app needs an account/);
  assert.throws(() => parseTargets({ app: { mode: "prod", account: "123" } }), /12-digit/);
  assert.throws(() => parseTargets(["app"]), /object of targets/);
});

test("the mode comes from context: prodDeployment, or the legacy inverse useLocalDevStack", () => {
  assert.deepEqual(modeFromContext(get({})), { mode: undefined, warnings: [] });
  assert.equal(modeFromContext(get({ prodDeployment: "true" })).mode, "prod");
  assert.equal(modeFromContext(get({ prodDeployment: false })).mode, "dev");
  const legacy = modeFromContext(get({ useLocalDevStack: "false" }));
  assert.equal(legacy.mode, "prod");
  assert.match(legacy.warnings[0] ?? "", /useLocalDevStack is deprecated.*prodDeployment=true/);
  assert.throws(() => modeFromContext(get({ prodDeployment: "true", useLocalDevStack: "true" })), /disagree/);
  assert.throws(() => modeFromContext(get({ prodDeployment: "yes" })), /"true" or "false"/);
});

test("with no flags, the personal development deployment is selected", () => {
  const selection = selectTarget({ get: get({}), declared, personalName: "my-aws-app" });
  assert.deepEqual([selection.target.name, selection.mode, selection.target.origin], ["my-aws-app", "dev", "personal"]);
});

test("stating prod selects the only declared production target", () => {
  const selection = selectTarget({ get: get({ prodDeployment: "true" }), declared, personalName: "my-aws-app" });
  assert.deepEqual([selection.target.name, selection.mode, selection.target.account], ["my-aws-app-prod", "prod", "734800004764"]);
  const two = parseTargets({ a: { mode: "prod", account: "111122223333" }, b: { mode: "prod", account: "111122223333" } });
  assert.throws(() => selectTarget({ get: get({ prodDeployment: "true" }), declared: two }), /Several production targets.*-c deployment=<name>.*a, b/);
});

test("a named target must agree with the stated mode, and production is never implied", () => {
  assert.equal(selectTarget({ get: get({ deployment: "my-aws-app-prod", prodDeployment: "true" }), declared }).target.name, "my-aws-app-prod");
  assert.throws(() => selectTarget({ get: get({ deployment: "my-aws-app-prod" }), declared }), /production target.*-c prodDeployment=true/);
  assert.throws(() => selectTarget({ get: get({ deployment: "my-aws-app-prod", prodDeployment: "false" }), declared }), /declared prod.*disagrees/);
  assert.equal(selectTarget({ get: get({ deployment: "team-dev" }), declared }).mode, "dev");
});

test("an undeclared name is allowed for development, but production must be declared once targets exist", () => {
  const adhoc = selectTarget({ get: get({ cdkAppName: "scratch-app" }), declared });
  assert.deepEqual([adhoc.target.name, adhoc.mode, adhoc.target.origin], ["scratch-app", "dev", "named"]);
  assert.throws(() => selectTarget({ get: get({ deployment: "other-prod", prodDeployment: "true" }), declared }), /Declare other-prod in framework:targets/);
  // A repository with no targets keeps the single-name behavior, pinned by nothing.
  const legacy = selectTarget({ get: get({ prodDeployment: "true" }), declared: [], personalName: "my-aws-app" });
  assert.deepEqual([legacy.target.name, legacy.mode], ["my-aws-app", "prod"]);
  assert.match(legacy.warnings.join(" "), /no account pin/);
});

test("the personal development name can never be a declared target of the other mode", () => {
  assert.throws(() => selectTarget({ get: get({}), declared, personalName: "my-aws-app-prod" }), /names the production target my-aws-app-prod/);
  assert.equal(selectTarget({ get: get({}), declared, personalName: "team-dev" }).target.origin, "declared");
});

test("names are validated wherever they come from", () => {
  assert.throws(() => selectTarget({ get: get({ deployment: "Bad_Name" }), declared }), /lowercase letters/);
  assert.throws(() => selectTarget({ get: get({}), declared: [], personalName: "-bad" }), /lowercase letters/);
  assert.equal(selectTarget({ get: get({}), declared: [] }).target.name, "matts-aws-framework");
});
