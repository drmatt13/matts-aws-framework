import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_CONTEXT_KEY,
  APP_ID_CONTEXT_KEY,
  appIdProblem,
  appNameProblem,
  newAppId,
  deploymentNameFor,
  modeFromContext,
  parseTargets,
  projectTargets,
  selectTarget,
  TARGETS_CONTEXT_KEY,
} from "@repo/framework/deploy";

const appId = "5b7e3c1a-9d2f-4e6b-8a1c-3f0d2e9b7a64";
const targets = projectTargets({
  app: "acme",
  appId,
  targets: {
    prod: { account: "734800004764", region: "us-east-1", inputs: "cdk-app/.env.prod" },
    staging: { mode: "prod", account: "111122223333" },
    "team-dev": { mode: "dev" },
  },
});
const get = (context: Record<string, unknown>) => (key: string) => context[key];

test("the app, app id and targets context keys are the framework's", () => {
  assert.equal(APP_CONTEXT_KEY, "framework:app");
  assert.equal(APP_ID_CONTEXT_KEY, "framework:appId");
  assert.equal(TARGETS_CONTEXT_KEY, "framework:targets");
});

test("the app name is required, lowercase, and its absence names the fix", () => {
  assert.equal(appNameProblem("acme"), undefined);
  assert.match(appNameProblem(undefined) ?? "", /cdk-app\/cdk.json has no "framework:app".*"deployAs": "<that name>"/);
  for (const bad of ["Acme", "acme-", "-acme", "ac_me", 7]) assert.match(appNameProblem(bad) ?? "", /framework:app must be lowercase/);
  assert.throws(() => projectTargets({ app: undefined, appId, targets: {} }), /has no "framework:app"/);
});

test("the app id is a permanent UUID, and its absence offers one to paste", () => {
  assert.equal(appIdProblem(appId), undefined);
  assert.match(newAppId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(newAppId(), newAppId());
  const missing = appIdProblem(undefined) ?? "";
  assert.match(missing, /cdk-app\/cdk.json has no "framework:appId".*recognized after the app is renamed. Add one to its context, once, and never change it: "framework:appId": "<the output of node -p "crypto.randomUUID\(\)">"/);
  assert.equal(appIdProblem(undefined), missing, "the same text every time, so a page showing it does not churn");
  for (const bad of ["acme", appId.toUpperCase(), 7]) assert.match(appIdProblem(bad) ?? "", /framework:appId must be a lowercase UUID/);
  assert.throws(() => projectTargets({ app: "acme", appId: undefined, targets: {} }), /has no "framework:appId"/);
});

test("every repository target carries the app id, which with its stage identifies it under any name", () => {
  assert.deepEqual([...new Set(targets.map((target) => target.appId))], [appId]);
  assert.equal(parseTargets({ prod: { account: "734800004764" } }, "acme")[0]!.appId, undefined, "parseTargets alone has no app id");
});

test("each stage deploys as <app>-<stage>, and the dev stage exists even when undeclared", () => {
  assert.equal(deploymentNameFor("acme", "prod"), "acme-prod");
  assert.deepEqual(targets.map((target) => [target.name, target.stage, target.mode, target.origin]), [
    ["acme-dev", "dev", "dev", "implicit"],
    ["acme-prod", "prod", "prod", "declared"],
    ["acme-staging", "staging", "prod", "declared"],
    ["acme-team-dev", "team-dev", "dev", "declared"],
  ]);
  const declaredDev = projectTargets({ app: "acme", appId, targets: { dev: { region: "eu-west-1" } } });
  assert.deepEqual(declaredDev.map((target) => [target.name, target.origin, target.region]), [["acme-dev", "declared", "eu-west-1"]]);
});

test("deployAs names a stage whatever the app is called", () => {
  const kept = parseTargets({ prod: { account: "734800004764", deployAs: "my-aws-app-prod" } }, "aws-studio");
  assert.deepEqual(kept.map((target) => [target.name, target.stage, target.deployAs]), [["my-aws-app-prod", "prod", "my-aws-app-prod"]]);
  assert.equal(parseTargets({ prod: { account: "734800004764" } }, "aws-studio")[0]!.deployAs, undefined);
  assert.throws(() => parseTargets({ prod: { account: "734800004764", deployAs: "Bad_Name" } }, "acme"), /deployAs must be 1-63 lowercase/);
  assert.throws(() => parseTargets({ prod: { account: "734800004764", deployment: "my-aws-app-prod" } }, "acme"), /unknown setting "deployment".*"deployment" is now "deployAs"/);
});

test("stages and their settings are validated", () => {
  assert.deepEqual(parseTargets(undefined, "acme"), []);
  assert.throws(() => parseTargets(["prod"], "acme"), /object of targets keyed by stage/);
  assert.throws(() => parseTargets({ "Bad Stage": {} }, "acme"), /stage "Bad Stage" must be lowercase/);
  assert.throws(() => parseTargets({ staging: { account: "734800004764" } }, "acme"), /staging.mode must be "dev" or "prod": only the dev and prod stages imply/);
  assert.throws(() => parseTargets({ prod: { mode: "dev" } }, "acme"), /prod is the production stage; its mode cannot be "dev"/);
  assert.throws(() => parseTargets({ staging: { mode: "staging" } }, "acme"), /mode must be "dev" or "prod"/);
  assert.throws(() => parseTargets({ prod: {} }, "acme"), /production stage prod needs an account/);
  assert.throws(() => parseTargets({ prod: { account: "123" } }, "acme"), /12-digit/);
  assert.throws(() => parseTargets({ prod: { account: "734800004764", deploymnet: "x" } }, "acme"), /unknown setting "deploymnet"/);
  assert.throws(() => parseTargets({ dev: { region: "" } }, "acme"), /dev.region must be a non-empty string/);
});

test("a derived name that is too long says how to fix it, and two stages may not share a name", () => {
  const app = "a".repeat(58);
  assert.throws(() => projectTargets({ app, appId, targets: { staging: { mode: "prod", account: "734800004764" } } }), /staging stage deploys as a+-staging \(66 characters\).*Shorten framework:app or the stage, or set "deployAs"/);
  assert.throws(() => projectTargets({ app: "acme", appId, targets: { prod: { account: "734800004764", deployAs: "acme-dev" } } }), /dev and prod stages both deploy as acme-dev/);
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

test("with no flags, the development stage is selected", () => {
  const selection = selectTarget({ get: get({}), targets });
  assert.deepEqual([selection.target.name, selection.mode, selection.target.origin], ["acme-dev", "dev", "implicit"]);
});

test("stating prod selects the only production target, and several must be chosen between", () => {
  const single = projectTargets({ app: "acme", appId, targets: { prod: { account: "734800004764" } } });
  const selection = selectTarget({ get: get({ prodDeployment: "true" }), targets: single });
  assert.deepEqual([selection.target.name, selection.mode, selection.target.account], ["acme-prod", "prod", "734800004764"]);
  assert.throws(() => selectTarget({ get: get({ prodDeployment: "true" }), targets }), /Several production targets.*-c deployment=<name>: acme-prod \(prod\), acme-staging \(staging\)/);
  assert.throws(() => selectTarget({ get: get({ prodDeployment: "true" }), targets: projectTargets({ app: "acme", appId, targets: {} }) }), /No production target is declared/);
});

test("a named deployment must agree with the stated mode, and production is never implied", () => {
  assert.equal(selectTarget({ get: get({ deployment: "acme-prod", prodDeployment: "true" }), targets }).target.name, "acme-prod");
  assert.throws(() => selectTarget({ get: get({ deployment: "acme-prod" }), targets }), /production target.*-c prodDeployment=true/);
  assert.throws(() => selectTarget({ get: get({ deployment: "acme-prod", prodDeployment: "false" }), targets }), /declared prod.*disagrees/);
  assert.throws(() => selectTarget({ get: get({ deployment: "acme-dev", prodDeployment: "true" }), targets }), /declared dev.*disagrees/);
  assert.equal(selectTarget({ get: get({ deployment: "acme-team-dev" }), targets }).mode, "dev");
});

test("a stage key is not a deployment name", () => {
  assert.throws(() => selectTarget({ get: get({ deployment: "prod", prodDeployment: "true" }), targets }), /prod is a stage, not a deployment: it deploys as acme-prod/);
  assert.throws(() => selectTarget({ get: get({ deployment: "staging" }), targets }), /Use -c deployment=acme-staging/);
});

test("an undeclared name is allowed for development only", () => {
  const adhoc = selectTarget({ get: get({ deployment: "scratch-app" }), targets });
  assert.deepEqual([adhoc.target.name, adhoc.mode, adhoc.target.origin], ["scratch-app", "dev", "named"]);
  assert.throws(() => selectTarget({ get: get({ deployment: "other-prod", prodDeployment: "true" }), targets }), /Declare other-prod in framework:targets/);
});

test("-c cdkAppName is a deprecated alias of -c deployment", () => {
  const legacy = selectTarget({ get: get({ cdkAppName: "acme-team-dev" }), targets });
  assert.equal(legacy.target.name, "acme-team-dev");
  assert.match(legacy.warnings.join(" "), /-c cdkAppName is deprecated. Use -c deployment=acme-team-dev/);
  assert.equal(selectTarget({ get: get({ deployment: "acme-dev", cdkAppName: "acme-dev" }), targets }).target.name, "acme-dev");
  assert.throws(() => selectTarget({ get: get({ deployment: "acme-dev", cdkAppName: "acme-team-dev" }), targets }), /disagree. Pass only -c deployment/);
});

test("names are validated wherever they come from", () => {
  assert.throws(() => selectTarget({ get: get({ deployment: "Bad_Name" }), targets }), /-c deployment must be 1-63 lowercase letters/);
  assert.throws(() => selectTarget({ get: get({ cdkAppName: "-bad" }), targets }), /-c cdkAppName must be 1-63 lowercase letters/);
});
