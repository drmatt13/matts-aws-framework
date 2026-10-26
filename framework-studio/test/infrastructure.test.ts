import assert from "./support/assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { test } from "node:test";
import { inspectInfrastructureAssembly, infrastructureId } from "../../scripts/infrastructure-inventory";
import { INFRASTRUCTURE_OWNER } from "../../scripts/infrastructure-types";
import { readAssemblyStacks } from "../../scripts/cloud-assembly";
import { InfrastructureService } from "../server/infrastructure";

const cache = path.resolve(__dirname, "../../.cache/framework-studio/inventory-tests");
mkdirSync(cache, { recursive: true });
function fixture() { return mkdtempSync(path.join(cache, "case-")); }
function remove(root: string) {
  assert.ok(path.relative(cache, root) && !path.relative(cache, root).startsWith(".."));
  rmSync(root, { recursive: true });
}
function json(root: string, file: string, value: unknown) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), JSON.stringify(value));
}
const metadata = (entity: string, role = "primary", extra = {}) => [{ type: INFRASTRUCTURE_OWNER, data: { entity, role, ...extra } }];
function assembly(root: string) {
  json(root, "manifest.json", { version: "48.0.0", artifacts: {
    A: { type: "aws:cloudformation:stack", environment: "aws://111111111111/us-east-1", properties: { templateFile: "a.json", stackName: "A" }, additionalMetadataFile: "a.metadata.json", metadata: {
      "/A": metadata("resource:stack", "primary", { stack: true }),
      "/A/Handler": metadata("lambda:handler"),
      "/A/Logs": metadata("lambda:handler", "supporting"),
      "/A/Imported": metadata("resource:existing", "primary", { external: true }),
    } },
    Nested: { type: "cdk:cloud-assembly", properties: { directoryName: "nested" } },
  } });
  json(root, "a.metadata.json", { "/A/Handler": [{ type: "aws:cdk:logicalId", data: "Function" }] });
  json(root, "a.json", { Resources: {
    Function: { Type: "AWS::Lambda::Function", Metadata: { "aws:cdk:path": "A/Handler/Resource" }, Properties: { Secret: "never-export-me", Role: { "Fn::GetAtt": ["Role", "Arn"] } } },
    Role: { Type: "AWS::IAM::Role", Metadata: { "aws:cdk:path": "A/Handler/Role/Resource" } },
    Logs: { Type: "AWS::Logs::LogGroup", Metadata: { "aws:cdk:path": "A/Logs/Resource" }, DependsOn: "Function" },
    Unknown: { Type: "Custom::Unknown", Condition: "Enabled", Properties: { Value: { "Fn::Sub": "${Function.Arn}-${AWS::Region}-${!escaped}" } } },
  }, Outputs: { FunctionArn: { Value: { "Fn::GetAtt": ["Function", "Arn"] }, Export: { Name: "function-arn" } } } });
  json(root, "nested/manifest.json", { artifacts: { B: { type: "aws:cloudformation:stack", environment: "aws://111111111111/us-east-1", properties: { templateFile: "b.json" }, additionalMetadataFile: "metadata.json" } } });
  json(root, "nested/metadata.json", { "/Stage/B/Resource": [{ type: "aws:cdk:logicalId", data: "Consumer" }] });
  json(root, "nested/b.json", { Resources: { Consumer: { Type: "AWS::SSM::Parameter", Properties: { Value: { "Fn::ImportValue": "function-arn" } } } } });
  json(root, "leftover.template.json", { Resources: { Wrong: { Type: "AWS::S3::Bucket" } } });
}

test("inventory follows manifests and nested assemblies, retains identities and projects no values", () => {
  const root = fixture();
  try {
    assembly(root);
    const inventory = inspectInfrastructureAssembly(root);
    assert.equal(inventory.stacks.length, 2);
    assert.equal(inventory.resources.length, 6);
    assert.ok(!JSON.stringify(inventory).includes("never-export-me"));
    assert.ok(!inventory.resources.some((resource) => resource.logicalId === "Wrong"));
    assert.equal(inventory.resources.find((resource) => resource.logicalId === "Function")!.id, infrastructureId("A", "Function", "aws://111111111111/us-east-1"));
    assert.equal(inventory.resources.find((resource) => resource.logicalId === "Consumer")!.constructPath, "Stage/B/Resource");
    assert.deepEqual(inspectInfrastructureAssembly(root), inventory);
    assert.ok(inventory.dependencies.some((edge) => edge.kind === "import" && edge.from === infrastructureId("Nested/B", "Consumer", "aws://111111111111/us-east-1")));
  } finally { remove(root); }
});

test("ownership is explicit, generated children inherit it, missing metadata stays unknown and external references are separate", () => {
  const root = fixture();
  try {
    assembly(root);
    const inventory = inspectInfrastructureAssembly(root);
    const get = (id: string) => inventory.resources.find((resource) => resource.logicalId === id)!;
    assert.equal(get("Function").classification, "framework");
    assert.equal(get("Role").classification, "supporting");
    assert.equal(get("Logs").classification, "supporting");
    assert.deepEqual(get("Unknown").owners, []);
    assert.equal(get("Unknown").source, undefined);
    assert.equal(get("Unknown").condition, "Enabled");
    assert.deepEqual(inventory.stacks[0]!.owners, ["resource:stack"]);
    assert.ok(inventory.resources.some((resource) => resource.classification === "imported" && resource.owners.includes("resource:existing") && !resource.logicalId));
    assert.ok(inventory.dependencies.some((edge) => edge.kind === "reference" && edge.to === get("Role").id));
    assert.ok(inventory.dependencies.some((edge) => edge.kind === "depends-on" && edge.to === get("Function").id));
  } finally { remove(root); }
});

test("manifest paths cannot escape the selected assembly, and missing templates fail explicitly", () => {
  const root = fixture();
  try {
    json(root, "manifest.json", { artifacts: { X: { type: "aws:cloudformation:stack", properties: { templateFile: "../outside.json" } } } });
    assert.throws(() => readAssemblyStacks(root));
    json(root, "manifest.json", { artifacts: { X: { type: "aws:cloudformation:stack" } } });
    assert.throws(() => readAssemblyStacks(root), /has no template/);
    json(root, "manifest.json", { artifacts: { X: { type: "cdk:cloud-assembly", properties: { directoryName: "." } } } });
    assert.throws(() => readAssemblyStacks(root), /cyclic/);
  } finally { remove(root); }
});

test("cross-stack export names never establish dependencies across AWS environments", () => {
  const root = fixture();
  try {
    assembly(root);
    const manifest = JSON.parse(readFileSync(path.join(root, "nested/manifest.json"), "utf8"));
    manifest.artifacts.B.environment = "aws://222222222222/us-east-1";
    json(root, "nested/manifest.json", manifest);
    const inventory = inspectInfrastructureAssembly(root);
    assert.ok(!inventory.dependencies.some((edge) => edge.kind === "import"));
    const a = infrastructureId("App", "Resource", "aws://111111111111/us-east-1");
    const b = infrastructureId("App", "Resource", "aws://222222222222/us-east-1");
    assert.notEqual(a, b);
  } finally { remove(root); }
});

test("synthesis isolates both modes, preserves authored inputs, and never runs from an inventory read", async () => {
  const root = fixture();
  try {
    mkdirSync(path.join(root, "cdk-app"));
    const text = 'PROD_DEPLOYMENT=false\nMODEL="two lines\nhere"\nAPI_KEY=never-export-me\n';
    writeFileSync(path.join(root, "cdk-app/.env.dev"), text);
    writeFileSync(path.join(root, "cdk-app/.env.prod"), text);
    let calls = 0;
    const service = new InfrastructureService(root, () => undefined, async (request) => {
      calls++;
      assert.ok(request.environment?.FRAMEWORK_INPUTS_FILE !== path.join(root, "cdk-app/.env.dev"));
      const input = parseEnv(readFileSync(request.environment!.FRAMEWORK_INPUTS_FILE!, "utf8"));
      assert.equal(input.PROD_DEPLOYMENT, String(!request.context.useLocalDevStack));
      assert.equal(input.MODEL, "two lines\nhere");
      assembly(request.outputDirectory);
    });
    assert.equal(service.get("dev").status, "empty"); assert.equal(calls, 0);
    const dev = await service.synthesize("dev");
    const prod = await service.synthesize("prod");
    assert.equal(calls, 2); assert.equal(dev.stale, false); assert.equal(prod.stale, false);
    assert.equal(readFileSync(path.join(root, "cdk-app/.env.dev"), "utf8"), text);
    assert.ok(!JSON.stringify([dev, prod]).includes("never-export-me"));
    assert.equal(dev.mode, "dev"); assert.equal(prod.mode, "prod");
  } finally { remove(root); }
});

test("ambiguous exports remain unresolved and shared workload source changes invalidate freshness", async () => {
  const root = fixture();
  try {
    const service = new InfrastructureService(root, () => undefined, async (request) => {
      assembly(request.outputDirectory);
      const template = JSON.parse(readFileSync(path.join(request.outputDirectory, "a.json"), "utf8"));
      template.Outputs.Ambiguous = { Value: { Ref: "Role" }, Export: { Name: "function-arn" } };
      json(request.outputDirectory, "a.json", template);
    });
    const good = await service.synthesize("dev");
    assert.equal(good.stale, false);
    assert.ok(!good.inventory!.dependencies.some((edge) => edge.kind === "import"));
    mkdirSync(path.join(root, "packages/models/src"), { recursive: true });
    writeFileSync(path.join(root, "packages/models/src/index.ts"), "// bundled workload dependency changed");
    assert.equal(service.get("dev").stale, true);
  } finally { remove(root); }
});

test("failed synthesis retains the last successful assembly and its configuration, redacts inputs, and marks only that attempt stale", async () => {
  const root = fixture();
  try {
    mkdirSync(path.join(root, "cdk-app")); writeFileSync(path.join(root, "cdk-app/.env.dev"), "SECRET=never-export-me\n");
    let fail = false;
    const service = new InfrastructureService(root, () => undefined, async (request) => {
      if (fail) throw new Error("Validation failed: never-export-me");
      assembly(request.outputDirectory);
    });
    const good = await service.synthesize("dev", "development");
    await service.synthesize("prod"); fail = true;
    const failed = await service.synthesize("dev", "another-profile");
    assert.equal(failed.inventory, good.inventory);
    assert.equal(failed.inputs?.profile, "development");
    assert.equal(failed.generatedAt, good.generatedAt);
    assert.equal(failed.status, "failed"); assert.equal(failed.stale, true);
    assert.ok(failed.error?.includes("Validation failed"));
    assert.ok(!failed.error?.includes("never-export-me"));
    assert.equal(service.get("prod").stale, false);
    writeFileSync(path.join(root, "cdk-app/cdk.context.json"), "{}");
    assert.equal(service.get("prod").stale, true);
  } finally { remove(root); }
});

test("a change during synthesis marks the result stale and overlapping jobs are rejected", async () => {
  const root = fixture();
  try {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const service = new InfrastructureService(root, () => undefined, async (request) => { await waiting; assembly(request.outputDirectory); });
    const job = service.synthesize("dev");
    assert.equal(service.get("dev").status, "running");
    await assert.rejects(service.synthesize("prod"), /already running/);
    writeFileSync(path.join(root, "framework.config.ts"), "// changed while synthesizing");
    release();
    assert.equal((await job).stale, true);
  } finally { remove(root); }
});
