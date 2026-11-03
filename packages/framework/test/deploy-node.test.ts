import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { contextFromArgs, deploymentInputsFile, frameworkMode, readCdkContext, repositoryTargets, resolveRepositoryTarget } from "@repo/framework/deploy/node";

const scratch = path.resolve(__dirname, "../../../.cache");

function withRepository(files: Record<string, string>, body: (root: string) => void): void {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, "deploy-node-"));
  try {
    for (const [name, contents] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      writeFileSync(path.join(root, name), contents);
    }
    body(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const cdkJson = (context: Record<string, unknown>) => JSON.stringify({ app: "npx tsx bin/main.ts", context });
const prodTarget = { prod: { account: "734800004764", inputs: "cdk-app/.env.prod" } };
const appId = "5b7e3c1a-9d2f-4e6b-8a1c-3f0d2e9b7a64";
const project = cdkJson({ "framework:app": "acme", "framework:appId": appId, "framework:targets": prodTarget });

test("context arguments are read in every spelling the CDK CLI accepts", () => {
  assert.deepEqual(contextFromArgs(["--all", "-c", "prodDeployment=true", "--context", "deployment=app", "--context=a=b=c", "-c", "flag"]), { prodDeployment: "true", deployment: "app", a: "b=c" });
});

test("cdk.json context is read, and absent or broken files read as none", () => {
  withRepository({ "cdk-app/cdk.json": project }, (root) => {
    assert.deepEqual(Object.keys(readCdkContext(root)), ["framework:app", "framework:appId", "framework:targets"]);
  });
  withRepository({}, (root) => assert.deepEqual(readCdkContext(root), {}));
  withRepository({ "cdk-app/cdk.json": "{ not json" }, (root) => assert.throws(() => readCdkContext(root), /cdk-app\/cdk.json/));
});

test("each mode reads its own inputs file, and never cdk-app/.env, whether or not the file exists", () => {
  for (const files of [{}, { "cdk-app/.env": "X=1\n", "cdk-app/.env.prod": "X=1\n" }] as Record<string, string>[]) {
    withRepository(files, (root) => {
      assert.equal(deploymentInputsFile(root, "dev"), path.join(root, "cdk-app", ".env.dev"));
      assert.equal(deploymentInputsFile(root, "prod"), path.join(root, "cdk-app", ".env.prod"));
    });
  }
});

test("the development stage reads cdk-app/.env.dev and is named from framework:app", () => {
  withRepository({ "cdk-app/cdk.json": project, "cdk-app/.env.dev": "X=1\n" }, (root) => {
    const dev = resolveRepositoryTarget({ root, get: () => undefined, env: {} });
    assert.deepEqual([dev.target.name, dev.mode, dev.inputsFile], ["acme-dev", "dev", path.join(root, "cdk-app", ".env.dev")]);
  });
});

test("CDK_APP_NAME in an inputs file never names a deployment", () => {
  withRepository({ "cdk-app/cdk.json": project, "cdk-app/.env.dev": "CDK_APP_NAME=my-aws-app\n", "cdk-app/.env": "CDK_APP_NAME=ignored\n" }, (root) => {
    const selection = resolveRepositoryTarget({ root, get: () => undefined, env: {} });
    assert.equal(selection.target.name, "acme-dev");
    assert.deepEqual(repositoryTargets(root).map((target) => target.name), ["acme-dev", "acme-prod"]);
  });
});

test("-c framework:app overrides cdk.json, and a missing app name or id stops with its fix", () => {
  withRepository({ "cdk-app/cdk.json": project }, (root) => {
    const selection = resolveRepositoryTarget({ root, get: (key) => ({ "framework:app": "other" } as Record<string, unknown>)[key], env: {} });
    assert.equal(selection.target.name, "other-dev");
    assert.equal(selection.target.appId, appId, "renaming on the command line keeps the app's identity");
  });
  withRepository({ "cdk-app/cdk.json": cdkJson({ "framework:appId": appId, "framework:targets": prodTarget }) }, (root) => {
    assert.throws(() => resolveRepositoryTarget({ root, get: () => undefined, env: {} }), /has no "framework:app"/);
    assert.throws(() => repositoryTargets(root), /has no "framework:app"/);
  });
  withRepository({ "cdk-app/cdk.json": cdkJson({ "framework:app": "acme", "framework:targets": prodTarget }) }, (root) => {
    assert.throws(() => resolveRepositoryTarget({ root, get: () => undefined, env: {} }), /has no "framework:appId".*node -p "crypto.randomUUID\(\)"/);
  });
});

test("repository targets list the development stage first, then the declared stages", () => {
  withRepository({ "cdk-app/cdk.json": cdkJson({ "framework:app": "acme", "framework:appId": appId, "framework:targets": { ...prodTarget, staging: { mode: "prod", account: "111122223333", deployAs: "legacy-staging" } } }) }, (root) => {
    assert.deepEqual(repositoryTargets(root).map((target) => [target.name, target.stage, target.origin, target.deployAs ?? null, target.appId]), [
      ["acme-dev", "dev", "implicit", null, appId],
      ["acme-prod", "prod", "declared", null, appId],
      ["legacy-staging", "staging", "declared", "legacy-staging", appId],
    ]);
  });
});

test("a production target uses its declared inputs file, which must exist", () => {
  withRepository({ "cdk-app/cdk.json": project }, (root) => {
    assert.throws(() => resolveRepositoryTarget({ root, get: (key) => ({ prodDeployment: "true" } as Record<string, unknown>)[key], env: {} }), /Create cdk-app\/\.env\.prod/);
  });
  withRepository({ "cdk-app/cdk.json": project, "cdk-app/.env.prod": "X=1\n" }, (root) => {
    const selection = resolveRepositoryTarget({ root, get: (key) => ({ prodDeployment: "true" } as Record<string, unknown>)[key], env: {} });
    assert.deepEqual([selection.target.name, selection.target.account, selection.inputsFile], ["acme-prod", "734800004764", path.join(root, "cdk-app", ".env.prod")]);
  });
});

test("FRAMEWORK_INPUTS_FILE overrides the inputs file, relative to the working directory, and never the name", () => {
  withRepository({ "cdk-app/cdk.json": project, "cdk-app/.env.dev": "X=1\n", "fixture.env": "CDK_APP_NAME=from-override\n" }, (root) => {
    const relative = path.relative(process.cwd(), path.join(root, "fixture.env"));
    const selection = resolveRepositoryTarget({ root, get: () => undefined, env: { FRAMEWORK_INPUTS_FILE: relative } });
    assert.deepEqual([selection.target.name, selection.inputsFile], ["acme-dev", path.join(root, "fixture.env")]);
  });
});

test("FRAMEWORK_MODE is dev unless it says prod, and anything else is refused", () => {
  assert.equal(frameworkMode({}), "dev");
  assert.equal(frameworkMode({ FRAMEWORK_MODE: "prod" }), "prod");
  assert.equal(frameworkMode({ FRAMEWORK_MODE: "dev" }), "dev");
  assert.throws(() => frameworkMode({ FRAMEWORK_MODE: "production" }), /FRAMEWORK_MODE/);
});
