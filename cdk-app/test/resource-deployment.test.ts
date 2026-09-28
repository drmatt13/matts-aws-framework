import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CreateSecretCommand, DescribeSecretCommand, GetSecretValueCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { synchronizeDeploymentSecrets, type SecretRequirement } from "../../scripts/deployment-secrets";
import { deploymentArguments, inspectDeploymentAssembly } from "../../scripts/deployment-assembly";
import { collectDevelopmentResources, readDeploymentStackPages, writeDevelopmentFiles, type DeploymentStack } from "../../scripts/resource-export";
import { defaults } from "../../framework-config/defaults";
import { App, Stack } from "aws-cdk-lib";
import { defineFrameworkConfig, defineResources, resource, resourceAttributeKey } from "@repo/framework/config";
import { initializeFrameworkResources, resolveDeploymentSecret, finalizeFrameworkResources } from "../lib/framework/framework-resources";

const identity = { account: "111122223333", region: "eu-west-2" };
const requirement: SecretRequirement = { version: 1, path: ["key"], variable: "KEY", name: "example/secret/KEY", deployment: "example", mode: "dev", ...identity, stack: "App", parameter: "KeyArn" };
const arn = "arn:aws:secretsmanager:eu-west-2:111122223333:secret:example/secret/KEY-AbCdEf";
const raw = "sentinel-raw-secret-never-publish";
function fake(existing: boolean, current = raw, owned = true) {
  const calls: unknown[] = [];
  const client = { send: async (command: any): Promise<any> => {
    calls.push(command);
    if (command instanceof DescribeSecretCommand) {
      if (!existing) throw Object.assign(new Error("absent"), { name: "ResourceNotFoundException" });
      return { ARN: arn, Tags: owned ? [{ Key: "framework:deployment", Value: "example" }, { Key: "framework:resource", Value: "key" }, { Key: "framework:environment", Value: "KEY" }] : [] };
    }
    if (command instanceof GetSecretValueCommand) return { SecretString: current };
    return { ARN: arn };
  } };
  return { client, calls };
}

test("secret sync reuses existing values and skips unchanged uploads", async () => {
  for (const authored of [{}, { KEY: raw }]) {
    const { client, calls } = fake(true);
    const result = await synchronizeDeploymentSecrets([requirement], authored, identity, client);
    assert.deepEqual(result.parameters, [`App:KeyArn=${arn}`]);
    assert.deepEqual(result.updated, []);
    assert.equal(calls.some(call => call instanceof PutSecretValueCommand || call instanceof CreateSecretCommand), false);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(raw));
  }
});

test("secret validation finishes before uploads and checks account and ownership", async () => {
  const { client, calls } = fake(false);
  await assert.rejects(synchronizeDeploymentSecrets([requirement, { ...requirement, name: "example/secret/MISSING", variable: "MISSING", path: ["missing"] }], { KEY: raw }, identity, client), /MISSING is required/);
  assert.equal(calls.some(call => call instanceof CreateSecretCommand), false);
  await assert.rejects(synchronizeDeploymentSecrets([requirement], { KEY: raw }, { ...identity, account: "999999999999" }, client), /credentials\/account/);
  await assert.rejects(synchronizeDeploymentSecrets([requirement], { KEY: raw }, identity, fake(true, raw, false).client), /not owned/);
});

test("changed values upload through the SDK once per resource and failures report prior changes", async () => {
  const { client, calls } = fake(true, "old");
  const result = await synchronizeDeploymentSecrets([requirement, { ...requirement, stack: "Other" }], { KEY: raw }, identity, client);
  assert.equal(calls.filter(call => call instanceof PutSecretValueCommand).length, 1);
  assert.deepEqual(result.updated, [requirement.name]);
  const failing = fake(false);
  let creates = 0;
  const send = failing.client.send;
  failing.client.send = async command => {
    if (command instanceof CreateSecretCommand && ++creates === 2) throw new Error(raw);
    return send(command);
  };
  await assert.rejects(synchronizeDeploymentSecrets([requirement, { ...requirement, name: "example/secret/SECOND", path: ["second"], variable: "SECOND" }], { KEY: raw, SECOND: raw }, identity, failing.client), error => {
    assert.match(String(error), /updates already performed: example\/secret\/KEY/);
    assert.doesNotMatch(String(error), new RegExp(raw)); return true;
  });
});

/** A stack's computed value, which is how a deployment now supplies a string. */
class ExampleStack extends Stack { public readonly identifier: string = "resolved"; }
const resources = defineResources({ key: resource.secret(), example: resource.stack<ExampleStack>() });
const config = defineFrameworkConfig({ resources, defaults, http: [], webSocket: [], services: [], events: [], tasks: [], workflows: [] });
const metadata = { version: 1, deployment: "example", mode: "dev", ...identity };
function deployed(outputs: DeploymentStack["Outputs"] = [], extra = {}): DeploymentStack {
  return { StackName: "App", StackId: "arn:aws:cloudformation:eu-west-2:111122223333:stack/App/id", StackStatus: "UPDATE_COMPLETE", Outputs: [{ Description: "framework:deployment:v1", OutputValue: JSON.stringify({ ...metadata, ...extra }) }, ...outputs!] };
}
test("export discovers resources across pages and rejects conflicting or production outputs", () => {
  const output = { Description: `framework:resource:v1:${resourceAttributeKey(resources.example.identifier)}`, OutputValue: "resolved" };
  const calls: (string | undefined)[] = [];
  const pages = readDeploymentStackPages(token => { calls.push(token); return token ? { Stacks: [deployed([output])] } : { Stacks: [], NextToken: "next" }; });
  assert.deepEqual(calls, [undefined, "next"]);
  assert.equal(collectDevelopmentResources(pages, "example", config).manifest.attributes[resourceAttributeKey(resources.example.identifier)], "resolved");
  assert.throws(() => collectDevelopmentResources([deployed([output]), deployed([output])], "example", config), /Duplicate/);
  assert.throws(() => collectDevelopmentResources([deployed([], { mode: "prod" })], "example", config), /production/);
  assert.throws(() => collectDevelopmentResources([deployed([], { account: "999999999999" })], "example", config), /inconsistent/);
  assert.throws(() => readDeploymentStackPages(() => ({ NextToken: "loop" })), /repeated/);
});

test("failed refresh preserves both previous files", () => {
  const cache = path.resolve(__dirname, "../../.cache"); mkdirSync(cache, { recursive: true });
  const fixture = mkdtempSync(path.join(cache, "export-test-"));
  try {
    const files = [".env", "resources.json"].map(name => ({ path: path.join(fixture, name), contents: "new" }));
    for (const file of files) writeFileSync(file.path, "old");
    let replacements = 0;
    assert.throws(() => writeDevelopmentFiles(files, (from, to) => { if (++replacements === 2) throw new Error("disk failure"); renameSync(from, to); }), /disk failure/);
    for (const file of files) assert.equal(readFileSync(file.path, "utf8"), "old");
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("deployment discovers generated parameters in the selected assembly, including dependencies", () => {
  const app = new App(); initializeFrameworkResources(app, { config, mode: "prod", deployment: "example", readers: { env: {} } });
  const owner = new Stack(app, "Owner", { env: identity });
  const consumer = new Stack(app, "Consumer", { env: identity }); consumer.addStackDependency(owner);
  resolveDeploymentSecret(owner, resources.key, true);
  finalizeFrameworkResources(app);
  const assembly = app.synth();
  const graph = inspectDeploymentAssembly(assembly.directory, deploymentArguments(["Consumer", "--profile", "test", "--require-approval", "never", "-c", "useLocalDevStack=false"]));
  assert.equal(graph.requirements.length, 1); assert.equal(graph.requirements[0].variable, "KEY");
  assert.deepEqual(new Set(graph.stacks), new Set(["Owner", "Consumer"]));
  assert.equal(inspectDeploymentAssembly(assembly.directory, deploymentArguments(["Consumer", "--exclusively"])).requirements.length, 0);
  assert.equal(deploymentArguments(["--app", "other", "--all"]).app, "other");
  assert.deepEqual(deploymentArguments(["--output", "out", "--all"]).forwarded, ["--all"]);
});
