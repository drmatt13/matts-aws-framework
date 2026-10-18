import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { contextFromArgs, deploymentInputsFile, frameworkMode, readCdkContext, resolveRepositoryTarget } from "@repo/framework/deploy/node";

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
const prodTarget = { "my-aws-app-prod": { mode: "prod", account: "734800004764", inputs: "cdk-app/.env.prod" } };

test("context arguments are read in every spelling the CDK CLI accepts", () => {
  assert.deepEqual(contextFromArgs(["--all", "-c", "prodDeployment=true", "--context", "deployment=app", "--context=a=b=c", "-c", "flag"]), { prodDeployment: "true", deployment: "app", a: "b=c" });
});

test("cdk.json context is read, and absent or broken files read as none", () => {
  withRepository({ "cdk-app/cdk.json": cdkJson({ "framework:targets": prodTarget }) }, (root) => {
    assert.deepEqual(Object.keys(readCdkContext(root)), ["framework:targets"]);
  });
  withRepository({}, (root) => assert.deepEqual(readCdkContext(root), {}));
  withRepository({ "cdk-app/cdk.json": "{ not json" }, (root) => assert.throws(() => readCdkContext(root), /cdk-app\/cdk.json/));
});

test("each mode reads its own inputs file, falling back to cdk-app/.env", () => {
  withRepository({ "cdk-app/.env": "CDK_APP_NAME=mine\n", "cdk-app/.env.prod": "X=1\n" }, (root) => {
    assert.equal(deploymentInputsFile(root, "dev"), path.join(root, "cdk-app", ".env"));
    assert.equal(deploymentInputsFile(root, "prod"), path.join(root, "cdk-app", ".env.prod"));
  });
});

test("a repository resolves the personal development target from CDK_APP_NAME", () => {
  withRepository({ "cdk-app/cdk.json": cdkJson({ "framework:targets": prodTarget }), "cdk-app/.env.dev": "CDK_APP_NAME=my-aws-app\n", "cdk-app/.env": "CDK_APP_NAME=ignored\n" }, (root) => {
    const selection = resolveRepositoryTarget({ root, get: () => undefined, env: {} });
    assert.deepEqual([selection.target.name, selection.mode, selection.inputsFile], ["my-aws-app", "dev", path.join(root, "cdk-app", ".env.dev")]);
  });
});

test("a production target uses its declared inputs file, which must exist", () => {
  const files = { "cdk-app/cdk.json": cdkJson({ "framework:targets": prodTarget }), "cdk-app/.env": "CDK_APP_NAME=my-aws-app\n" };
  withRepository(files, (root) => {
    assert.throws(() => resolveRepositoryTarget({ root, get: (key) => ({ prodDeployment: "true" } as Record<string, unknown>)[key], env: {} }), /Create cdk-app\/\.env\.prod/);
  });
  withRepository({ ...files, "cdk-app/.env.prod": "X=1\n" }, (root) => {
    const selection = resolveRepositoryTarget({ root, get: (key) => ({ prodDeployment: "true" } as Record<string, unknown>)[key], env: {} });
    assert.deepEqual([selection.target.name, selection.target.account, selection.inputsFile], ["my-aws-app-prod", "734800004764", path.join(root, "cdk-app", ".env.prod")]);
  });
});

test("FRAMEWORK_INPUTS_FILE overrides the inputs file, relative to the working directory", () => {
  withRepository({ "cdk-app/.env": "CDK_APP_NAME=from-default\n", "fixture.env": "CDK_APP_NAME=from-override\n" }, (root) => {
    const relative = path.relative(process.cwd(), path.join(root, "fixture.env"));
    const selection = resolveRepositoryTarget({ root, get: () => undefined, env: { FRAMEWORK_INPUTS_FILE: relative } });
    assert.deepEqual([selection.target.name, selection.inputsFile], ["from-override", path.join(root, "fixture.env")]);
  });
});

test("FRAMEWORK_MODE is dev unless it says prod, and anything else is refused", () => {
  assert.equal(frameworkMode({}), "dev");
  assert.equal(frameworkMode({ FRAMEWORK_MODE: "prod" }), "prod");
  assert.equal(frameworkMode({ FRAMEWORK_MODE: "dev" }), "dev");
  assert.throws(() => frameworkMode({ FRAMEWORK_MODE: "production" }), /FRAMEWORK_MODE/);
});
