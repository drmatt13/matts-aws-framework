import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * A development and a production deployment in one account and region must not
 * share a stack, a physical name or an export. Both graphs are synthesized
 * through the real entry point (bin/main.ts) with the CLI's context contract,
 * asset bundling skipped so the test stays fast and offline.
 */

const root = path.resolve(__dirname, "../..");
const account = "734849394764";
const region = "us-east-1";

interface Synth { status: number | null; output: string; templates: Record<string, any> }

function synthesize(directory: string, mode: "dev" | "prod", inputs: string, overrides: NodeJS.ProcessEnv = {}): Synth {
  const outdir = path.join(directory, mode);
  const project = JSON.parse(readFileSync(path.join(root, "cdk-app", "cdk.json"), "utf8")).context;
  const cached = existsSync(path.join(root, "cdk-app", "cdk.context.json")) ? JSON.parse(readFileSync(path.join(root, "cdk-app", "cdk.context.json"), "utf8")) : {};
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (/^(CDK_|FRAMEWORK_|AWS_PROFILE$|PROD_DEPLOYMENT$|DEPLOY_PROD_WEBSOCKET_API$|DATABASE_)/.test(key)) delete env[key];
  const run = spawnSync(process.execPath, ["--import", "tsx", "bin/main.ts"], {
    cwd: path.join(root, "cdk-app"), encoding: "utf8", timeout: 120_000,
    env: {
      ...env,
      CDK_OUTDIR: outdir,
      CDK_DEFAULT_ACCOUNT: account,
      CDK_DEFAULT_REGION: region,
      CDK_CONTEXT_JSON: JSON.stringify({ ...project, ...cached, "aws:cdk:bundling-stacks": [], prodDeployment: String(mode === "prod") }),
      FRAMEWORK_INPUTS_FILE: inputs,
      ...overrides,
    },
  });
  const templates: Record<string, any> = {};
  if (run.status === 0) {
    const manifest = JSON.parse(readFileSync(path.join(outdir, "manifest.json"), "utf8"));
    for (const [id, artifact] of Object.entries<any>(manifest.artifacts)) {
      if (artifact.type === "aws:cloudformation:stack") templates[artifact.properties?.stackName ?? id] = JSON.parse(readFileSync(path.join(outdir, artifact.properties.templateFile), "utf8"));
    }
  }
  return { status: run.status, output: `${run.stdout}${run.stderr}`, templates };
}

/** Names AWS holds unique per account and region: stacks, top-level literal *Name properties and Cognito domains, exports. */
function physicalNames(templates: Record<string, any>): Set<string> {
  const names = new Set<string>(Object.keys(templates).map((stack) => `stack:${stack}`));
  for (const template of Object.values(templates)) {
    for (const resource of Object.values<any>(template.Resources ?? {})) {
      for (const [key, value] of Object.entries<any>(resource.Properties ?? {})) {
        // An inline policy's name is unique only within the role it is attached to.
        if (resource.Type === "AWS::IAM::Policy" && key === "PolicyName") continue;
        if (typeof value === "string" && (/Name$/.test(key) || (resource.Type === "AWS::Cognito::UserPoolDomain" && key === "Domain"))) names.add(`${resource.Type}.${key}:${value}`);
      }
    }
    for (const output of Object.values<any>(template.Outputs ?? {})) {
      if (typeof output.Export?.Name === "string") names.add(`export:${output.Export.Name}`);
    }
  }
  return names;
}

function identities(templates: Record<string, any>): Set<string> {
  const found = new Set<string>();
  for (const template of Object.values(templates)) {
    const marker = Object.values<any>(template.Outputs ?? {}).find((output) => output.Description === "framework:deployment:v1");
    const value = JSON.parse(marker.Value);
    found.add(`${value.deployment}/${value.mode}/${value.account}/${value.region}`);
  }
  return found;
}

test("development and production deployments in one account and region are disjoint", () => {
  mkdirSync(path.join(root, ".cache"), { recursive: true });
  const directory = mkdtempSync(path.join(root, ".cache", "isolation-"));
  try {
    const devInputs = path.join(directory, "dev.env");
    const prodInputs = path.join(directory, "prod.env");
    writeFileSync(devInputs, "CDK_APP_NAME=my-aws-app\nLOCAL_DEV_URL=http://localhost:3000\n");
    writeFileSync(prodInputs, "USE_FRONTEND_CUSTOM_DOMAIN=false\nUSE_COGNITO_CUSTOM_DOMAIN=false\n");
    const dev = synthesize(directory, "dev", devInputs);
    assert.equal(dev.status, 0, dev.output);
    const prod = synthesize(directory, "prod", prodInputs);
    assert.equal(prod.status, 0, prod.output);

    assert.deepEqual([...identities(dev.templates)], [`my-aws-app/dev/${account}/${region}`]);
    assert.deepEqual([...identities(prod.templates)], [`my-aws-app-prod/prod/${account}/${region}`]);
    assert.ok(Object.keys(prod.templates).includes("my-aws-app-prod-RdsStack"), "production builds its database");
    assert.ok(!Object.keys(dev.templates).some((stack) => stack.endsWith("-RdsStack")), "development builds none");

    const shared = [...physicalNames(dev.templates)].filter((name) => physicalNames(prod.templates).has(name));
    assert.deepEqual(shared, [], "no stack, physical name or export is shared");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a production target pinned to an account refuses a synth for any other account", () => {
  mkdirSync(path.join(root, ".cache"), { recursive: true });
  const directory = mkdtempSync(path.join(root, ".cache", "isolation-"));
  try {
    const inputs = path.join(directory, "prod.env");
    writeFileSync(inputs, "USE_FRONTEND_CUSTOM_DOMAIN=false\nUSE_COGNITO_CUSTOM_DOMAIN=false\n");
    const wrong = synthesize(directory, "prod", inputs, { CDK_DEFAULT_ACCOUNT: "111122223333" });
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.output, /pinned to account 734849394764/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
