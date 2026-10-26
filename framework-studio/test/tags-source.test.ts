import { sourceFixtureCheckpoint } from "./support/source-fixture";
import assert from "./support/assert";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { SnapshotBuilder } from "../server/snapshot";
import { EditService } from "../server/edits/transaction";
import { planCreation } from "../server/edits/creation";
import { readCreationRequest } from "../shared/creation";
import { ResourceService } from "../server/resources";
import { locateConfigSource } from "../../packages/framework/scripts/config-source";
import { SourceFiles } from "../server/source";
import { declarationObject, parse } from "../server/source/syntax";
import ts from "typescript";

const root = path.resolve(__dirname, "../..");
const fixture = path.join(root, ".cache/framework-studio", `tag-source-${randomUUID()}`);
const workload = path.join(fixture, "framework-config/features/identity.ts");
const inputs = path.join(fixture, "framework-config/resources/inputs.ts");
const original = `// Cohesive aliases keep their own authored comments.
export const identityRoutes = {
  "/identity": { directory: "/lambda_functions/fixture", methods: ["GET"], tags: { Feature: "Identity" }, memorySize: 256 },
  "/identity/details": { directory: "/lambda_functions/fixture", methods: ["GET"], tags: { Feature: "Identity" }, memorySize: 256 },
} as const;
`;
const originalInputs = `import { resource } from "@repo/framework/config";
export const setting = resource.fromEnv("SETTING", { tags: { Feature: "Models" } }).default("initial");
export const modelInputs = { secondary: resource.fromEnv() };
`;
let builder: SnapshotBuilder;
let edits: EditService;
before(async () => {
  for (const directory of ["framework-config/features", "framework-config/resources", "cdk-app/lambda_functions/fixture"]) mkdirSync(path.join(fixture, directory), { recursive: true });
  cpSync(path.join(root, "framework-config/defaults.ts"), path.join(fixture, "framework-config/defaults.ts"));
  writeFileSync(path.join(fixture, "cdk-app/lambda_functions/fixture/index.ts"), "export const handler = async () => ({});\n");
  writeFileSync(workload, original);
  writeFileSync(inputs, originalInputs);
  writeFileSync(path.join(fixture, "framework-config/resources.ts"), 'import { defineResources } from "@repo/framework/config";\nimport { setting, modelInputs } from "./resources/inputs";\nexport const resources = defineResources({ setting, modelInputs });\n');
  writeFileSync(path.join(fixture, "framework.config.ts"), 'import { defineFrameworkConfig } from "@repo/framework/config";\nimport { defaults } from "./framework-config/defaults";\nimport { resources } from "./framework-config/resources";\nimport { identityRoutes } from "./framework-config/features/identity";\nexport default defineFrameworkConfig({ resources, defaults, http: [identityRoutes], webSocket: [], events: [], services: [] });\n');
  builder = new SnapshotBuilder(fixture);
  edits = new EditService(fixture, builder);
  await builder.refresh();
  assert.equal(builder.current!.snapshot.models.dev.status, "ok", JSON.stringify(builder.current!.snapshot.models.dev.diagnostics));
});
let restoreSource: () => Promise<void>;
beforeEach(() => { restoreSource = sourceFixtureCheckpoint(fixture, builder); });
afterEach(async () => { await restoreSource(); });

after(async () => { await builder?.dispose(); rmSync(fixture, { recursive: true, force: true }); });
const state = () => builder.current!;
const revision = () => state().snapshot.revision;
function assertReadableObjects(node: ts.Node, source: ts.SourceFile): void {
  if (ts.isObjectLiteralExpression(node) && node.properties.length > 1) {
    const lines = node.properties.map(property => source.getLineAndCharacterOfPosition(property.getStart(source)).line);
    assert.equal(new Set(lines).size, lines.length, "every generated object property starts on its own line");
  }
  ts.forEachChild(node, child => assertReadableObjects(child, source));
}

test("source discovery follows explicitly composed grouped modules and imported catalog descriptors", () => {
  assert.equal(state().snapshot.models.dev.targets[0]!.origins.length, 2);
  assert.equal(state().snapshot.source.entities["lambda:fixture"]!.value.file, "framework-config/features/identity.ts");
  assert.equal(state().snapshot.source.entities["resource:setting"]!.value.file, "framework-config/resources/inputs.ts");
  assert.equal(state().snapshot.source.entities["resource:modelInputs.secondary"]!.value.file, "framework-config/resources/inputs.ts");
  assert.equal(state().snapshot.source.editability["resource:setting"]!.tags.kind, "literal");
});

test("reviewed tags update shared aliases together, preserve source, and exact bytes", async () => {
  const plan = await edits.planBatch([{ kind: "tags", entity: "lambda:fixture", tags: { Feature: "Accounts", Owner: "platform" } }], revision());
  assert.ok(plan.ok, JSON.stringify(plan.preflight));
  assert.deepEqual(plan.changes.map(change => change.file), ["framework-config/features/identity.ts"]);
  assert.equal(readFileSync(workload, "utf8"), original, "review writes nothing");
  assert.equal((await edits.applyBatch(plan.planId)).status, "applied");
  assert.match(readFileSync(workload, "utf8"), /Cohesive aliases/);
  assert.equal((readFileSync(workload, "utf8").match(/Feature: "Accounts"/g) ?? []).length, 2);
  assert.equal(state().snapshot.models.dev.tagging!["lambda:fixture"]!.effective.Owner, "platform");
  await restoreSource();
  assert.equal(readFileSync(workload, "utf8"), original);
  await restoreSource();
});

test("catalog tag add/change/removal edits its descriptor without flattening its module", async () => {
  const plan = await edits.planBatch([{ kind: "tags", entity: "resource:setting", tags: { Feature: "Intelligence", Team: "AI" } }], revision());
  assert.ok(plan.ok, JSON.stringify(plan.preflight));
  assert.deepEqual(plan.changes.map(change => change.file), ["framework-config/resources/inputs.ts"]);
  assert.equal((await edits.applyBatch(plan.planId)).status, "applied");
  assert.match(readFileSync(inputs, "utf8"), /default\("initial"\)/);
  const removal = await edits.planBatch([{ kind: "tags", entity: "resource:setting", tags: {} }], revision());
  assert.equal((await edits.applyBatch(removal.planId)).status, "applied");
  assert.deepEqual(state().snapshot.models.dev.tagging!["resource:setting"]!.authored, {});
  await restoreSource();
  assert.equal(readFileSync(inputs, "utf8"), originalInputs);
});

test("tagging a derived input materializes its stable environment name", async () => {
  const entity = "resource:modelInputs.secondary";
  const envName = state().snapshot.models.dev.resources.find(resource => resource.id === entity)!.fromEnv;
  const plan = await edits.planBatch([{ kind: "tags", entity, tags: { Feature: "Models" } }], revision());
  assert.ok(plan.ok, JSON.stringify(plan.preflight));
  assert.equal((await edits.applyBatch(plan.planId)).status, "applied");
  assert.ok(readFileSync(inputs, "utf8").includes(`resource.fromEnv(${JSON.stringify(envName)},`));
  await restoreSource();
  assert.equal(readFileSync(inputs, "utf8"), originalInputs);
});

test("resource defaults remain editable in split catalogs and preserve declaration tags", async () => {
  const service = new ResourceService(fixture, builder);
  const plan = await service.plan({ resource: "resource:setting", kind: "input", default: "updated", group: "", requirements: {} }, revision(), "dev");
  assert.ok(plan.ok, JSON.stringify(plan.diagnostics));
  assert.equal((await service.apply(plan.planId)).status, "applied");
  assert.equal(state().snapshot.models.dev.tagging!["resource:setting"]!.effective.Feature, "Models");
  await restoreSource();
  assert.equal(readFileSync(inputs, "utf8"), originalInputs);
});

test("moving an imported resource changes catalog membership while preserving its definition and tags", async () => {
  const service = new ResourceService(fixture, builder);
  for (const group of ["billing", "modelInputs"]) {
    const plan = await service.plan({ resource: "resource:setting", kind: "input", default: "initial", group, requirements: {} }, revision(), "dev");
    assert.ok(plan.ok, JSON.stringify(plan.diagnostics));
    assert.equal((await service.apply(plan.planId)).status, "applied");
    assert.equal(state().snapshot.models.dev.tagging![`resource:${group}.setting`]!.effective.Feature, "Models");
    assert.match(readFileSync(inputs, "utf8"), /export const setting = resource.fromEnv/);
    await restoreSource();
    assert.equal(readFileSync(inputs, "utf8"), originalInputs);
  }
});

test("protected keys and stale source reviews refuse before writing", async () => {
  await assert.rejects(edits.planBatch([{ kind: "tags", entity: "lambda:fixture", tags: { "aws:reserved": "x" } }], revision()), /reserved/i);
  await assert.rejects(edits.planBatch([{ kind: "tags", entity: "lambda:fixture", tags: { Feature: "One" } }, { kind: "tags", entity: "route:http:/identity", tags: { Feature: "Two" } }], revision()), /only once/i);
  const plan = await edits.planBatch([{ kind: "tags", entity: "lambda:fixture", tags: { Feature: "Changed" } }], revision());
  writeFileSync(workload, original + "\n// Manual concurrent edit\n");
  await assert.rejects(edits.applyBatch(plan.planId), /changed/i);
  assert.equal(readFileSync(workload, "utf8"), original + "\n// Manual concurrent edit\n");
  writeFileSync(workload, original);
  await builder.refresh();
});

test("computed/shared maps remain source-owned and tag comments are never discarded", async () => {
  const computed = original.replaceAll('tags: { Feature: "Identity" }', "tags: identityTags");
  writeFileSync(workload, 'const identityTags = { Feature: "Identity" };\n' + computed);
  await builder.refresh();
  assert.equal(state().snapshot.source.editability["lambda:fixture"]!.tags.kind, "unsupported");
  await assert.rejects(edits.planBatch([{ kind: "tags", entity: "lambda:fixture", tags: {} }], revision()), /computed|expression/i);
  const comments = original.replaceAll('Feature: "Identity"', '/* retain ownership comment */ Feature: "Identity"');
  writeFileSync(workload, comments);
  await builder.refresh();
  await assert.rejects(edits.planBatch([{ kind: "tags", entity: "lambda:fixture", tags: {} }], revision()), /comment/i);
  assert.equal(readFileSync(workload, "utf8"), comments);
  writeFileSync(workload, original);
  await builder.refresh();
});

test("a descriptor composed under multiple catalog names explains shared source ownership", async () => {
  const facade = path.join(fixture, "framework-config/resources.ts");
  const before = readFileSync(facade, "utf8");
  try {
    writeFileSync(facade, before.replace("defineResources({ setting, modelInputs })", "defineResources({ setting, alias: setting, modelInputs })"));
    await builder.refresh();
    assert.equal(state().snapshot.source.editability["resource:setting"]!.tags.kind, "unsupported");
    await assert.rejects(edits.planBatch([{ kind: "tags", entity: "resource:setting", tags: { Feature: "Changed" } }], revision()), /shared.*resources.setting.*resources.alias/i);
    assert.equal(readFileSync(inputs, "utf8"), originalInputs);
  } finally { writeFileSync(facade, before); await builder.refresh(); }
});

test("literal tags changed by later module code are read-only and raw API edits refuse without writes", async () => {
  const mutated = original + '\nfor (const route of Object.values(identityRoutes)) (route as { tags: Record<string, string> }).tags = { Feature: "Runtime override" };\n';
  try {
    writeFileSync(workload, mutated);
    await builder.refresh();
    const editable = state().snapshot.source.editability["lambda:fixture"]!.tags;
    assert.equal(editable.kind, "unsupported");
    assert.ok(editable.kind === "unsupported" && /differ.*evaluated/i.test(editable.reason));
    await assert.rejects(edits.planBatch([{ kind: "tags", entity: "lambda:fixture", tags: { Feature: "Requested" } }], revision()), /differ.*evaluated/i);
    assert.equal(readFileSync(workload, "utf8"), mutated);
  } finally { writeFileSync(workload, original); await builder.refresh(); }
});

test("adding member tags preserves sibling metadata and one owning members object", async () => {
  const facade = path.join(fixture, "framework-config/resources.ts");
  const beforeFacade = readFileSync(facade, "utf8");
  const stackFile = path.join(fixture, "cdk-app/lib/app/catalog-fixture-stack.ts");
  mkdirSync(path.dirname(stackFile), { recursive: true });
  writeFileSync(stackFile, 'export class CatalogFixtureStack { public readonly first!: string; public readonly second!: string; public readonly third!: string; }\n');
  const descriptor = originalInputs + '\nimport type { CatalogFixtureStack } from "../../cdk-app/lib/app/catalog-fixture-stack";\nexport const stackFixture = resource.stack<CatalogFixtureStack>({ tags: { Feature: "Shared" }, members: { first: { tags: { Owner: "First" } }, second: {} } });\n';
  writeFileSync(inputs, descriptor);
  writeFileSync(facade, beforeFacade.replace("{ setting, modelInputs }", "{ setting, modelInputs, stackFixture }").replace("defineResources({ setting, modelInputs })", "defineResources({ setting, modelInputs, stackFixture })"));
  try {
    await builder.refresh();
    const plan = await edits.planBatch([{ kind: "tags", entity: "resource:stackFixture.second", tags: { Owner: "Second" } }, { kind: "tags", entity: "resource:stackFixture.third", tags: { Owner: "Third" } }], revision());
    assert.ok(plan.ok, JSON.stringify(plan.preflight));
    const applied = await edits.applyBatch(plan.planId);
    assert.equal(applied.status, "applied", applied.message);
    const actual = readFileSync(inputs, "utf8");
    assert.equal((actual.match(/members:/g) ?? []).length, 1);
    assert.ok(actual.includes('first: { tags: { Owner: "First" } }'));
    for (const member of ["first", "second", "third"]) {
      assert.equal(state().snapshot.models.prod.tagging![`resource:stackFixture.${member}`]!.effective.Feature, "Shared");
      assert.equal(state().snapshot.models.prod.tagging![`resource:stackFixture.${member}`]!.effective.Owner, member[0]!.toUpperCase() + member.slice(1));
    }
  } finally { writeFileSync(inputs, originalInputs); writeFileSync(facade, beforeFacade); rmSync(stackFile); await builder.refresh(); }
});

test("adding tags refuses empty commented maps and metadata containers without writes", async () => {
  const examples = [
    { file: workload, before: original, after: original.replaceAll('tags: { Feature: "Identity" }', "tags: { /* preserve this tag placeholder */ }"), entity: "lambda:fixture" },
    { file: inputs, before: originalInputs, after: originalInputs.replace('{ tags: { Feature: "Models" } }', "{ /* preserve these metadata notes */ }"), entity: "resource:setting" },
  ];
  for (const example of examples) {
    try {
      writeFileSync(example.file, example.after);
      await builder.refresh();
      await assert.rejects(edits.planBatch([{ kind: "tags", entity: example.entity, tags: { Feature: "Requested" } }], revision()), /comments.*source|source.*comments/i);
      assert.equal(readFileSync(example.file, "utf8"), example.after);
    } finally { writeFileSync(example.file, example.before); await builder.refresh(); }
  }
});

test("adding resource tag options preserves an authored trailing argument comma", async () => {
  const authored = originalInputs.replace('resource.fromEnv("SETTING", { tags: { Feature: "Models" } })', 'resource.fromEnv("SETTING",)');
  try {
    writeFileSync(inputs, authored);
    await builder.refresh();
    const plan = await edits.planBatch([{ kind: "tags", entity: "resource:setting", tags: { Feature: "Requested" } }], revision());
    assert.ok(plan.ok, JSON.stringify(plan.preflight));
    const applied = await edits.applyBatch(plan.planId);
    assert.equal(applied.status, "applied", applied.message);
    assert.equal(state().snapshot.models.prod.tagging!["resource:setting"]!.effective.Feature, "Requested");
  } finally { writeFileSync(inputs, originalInputs); await builder.refresh(); }
});

test("post-apply verification failure restores tag edits through the guarded transaction", async () => {
  const plan = await edits.planBatch([{ kind: "tags", entity: "lambda:fixture", tags: { Feature: "Changed" } }], revision());
  const refresh = builder.refresh.bind(builder);
  let fail = true;
  builder.refresh = async () => { if (fail) { fail = false; throw new Error("Simulated post-write failure"); } return refresh(); };
  try { assert.equal((await edits.applyBatch(plan.planId)).status, "reverted"); }
  finally { builder.refresh = refresh; }
  assert.equal(readFileSync(workload, "utf8"), original);
});

test("creation accepts validated string pairs and emits readable modules with authored tags", () => {
  const request = readCreationRequest({ kind: "input", id: "invoiceRegion", envName: "INVOICE_REGION", tags: { Feature: "Billing" } });
  const proposal = planCreation(fixture, state(), request);
  const module = [...proposal.overrides].find(([file]) => file === path.join(fixture, "framework-config/resources/inputs.ts"))!;
  assert.match(module[1], /export const invoiceRegionResource/);
  assert.match(module[1], /Feature: "Billing"|"Feature": "Billing"/);
  assert.match(proposal.overrides.get(path.join(fixture, "framework-config/resources.ts"))!, /invoiceRegion: invoiceRegionResource/);
  assert.ok(proposal.overrides.get(path.join(fixture, "framework-config/resources.ts"))!.startsWith('import { defineResources }'), "creation keeps the composition module's import order");
  assert.throws(() => readCreationRequest({ kind: "input", id: "bad", envName: "BAD", tags: { Feature: 12 } }), /string/i);
  const group = planCreation(fixture, state(), readCreationRequest({ kind: "input", id: "invoiceRegion", group: "modelInputs", envName: "INVOICE_REGION", tags: { Feature: "Billing", Team: "Finance" } }));
  const grouped = parse(inputs, group.overrides.get(inputs)!);
  const namespace = grouped.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations]).find(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "modelInputs")!.initializer as ts.ObjectLiteralExpression;
  const property = namespace.properties.find(property => property.name?.getText(grouped) === "invoiceRegion") as ts.PropertyAssignment;
  assertReadableObjects(property.initializer, grouped);
});

test("creation composes a missing per-kind module beside manually split declaration modules", () => {
  const request = readCreationRequest({ kind: "function", id: "created-http", category: "http", path: "/created-http", auth: false });
  const proposal = planCreation(fixture, state(), request);
  const file = path.join(fixture, "framework-config/workloads/http.ts");
  assert.match(proposal.overrides.get(file)!, /export const http =/);
  assert.match(proposal.overrides.get(file)!, /from "\.\.\/contracts"/);
  assert.ok(![...proposal.overrides.keys()].some(file => file.includes("workloads/http/")));
  const located = locateConfigSource(path.join(fixture, "framework.config.ts"), { repositoryRoot: fixture, host: new SourceFiles(proposal.overrides).host() });
  assert.deepEqual(located.sections.http.map(entry => entry.key), ["/identity", "/identity/details", "/created-http"]);
});

test("workflow options remain editable through an official imported helper alias", () => {
  const source = parse("workflows.ts", 'import { workflow as flow } from "@repo/framework/config"; const declarations = { example: flow(() => 1, { tags: { Feature: "Flows" } }) };');
  const declaration = source.statements.find(ts.isVariableStatement)!.declarationList.declarations[0]!.initializer as ts.ObjectLiteralExpression;
  const call = (declaration.properties[0] as ts.PropertyAssignment).initializer;
  const found = declarationObject(call, "workflows", []);
  assert.ok("object" in found);
  const foreign = parse("workflows.ts", 'import { workflow as flow } from "./custom"; const declaration = flow(() => 1, { tags: {} });');
  const expression = foreign.statements.find(ts.isVariableStatement)!.declarationList.declarations[0]!.initializer!;
  assert.ok("unsupported" in declarationObject(expression, "workflows", []));
});

test("creation refuses to shadow a manually composed directory-index section", () => {
  const rootFile = path.join(fixture, "framework.config.ts");
  const before = readFileSync(rootFile, "utf8");
  const directory = path.join(fixture, "framework-config/workloads/http");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "index.ts"), "export const additionalRoutes = {};\n");
  writeFileSync(rootFile, 'import { additionalRoutes } from "./framework-config/workloads/http";\n' + before.replace("http: [identityRoutes]", "http: [identityRoutes, additionalRoutes]"));
  try {
    const request = readCreationRequest({ kind: "function", id: "created-http", category: "http", path: "/created-http", auth: false });
    assert.throws(() => planCreation(fixture, state(), request), /shadow.*directory index/i);
    assert.equal(readFileSync(path.join(directory, "index.ts"), "utf8"), "export const additionalRoutes = {};\n");
  } finally { writeFileSync(rootFile, before); rmSync(directory, { recursive: true }); }
});

test("creation appends to a composed per-kind literal module and reuses authored import aliases", async () => {
  const rootFile = path.join(fixture, "framework.config.ts");
  const beforeRoot = readFileSync(rootFile, "utf8");
  const module = path.join(fixture, "framework-config/workloads/http.ts");
  const authored = 'import type { HttpSection } from "../contracts";\nimport { resources as catalog } from "../resources";\n\n// Shared fragments remain authored beside their workload family.\nconst sharedEnvironment = { SOURCE: "authored" };\nexport const http = {} satisfies HttpSection;\n';
  mkdirSync(path.dirname(module), { recursive: true });
  writeFileSync(module, authored);
  const composedRoot = 'import { http as canonicalHttp } from "./framework-config/workloads/http";\n' + beforeRoot.replace("http: [identityRoutes]", "http: [identityRoutes, canonicalHttp]");
  writeFileSync(rootFile, composedRoot);
  try {
    await builder.refresh();
    const request = readCreationRequest({ kind: "function", id: "created-http", category: "http", path: "/created-http", auth: false, bindingResource: "resource:setting", bindingVariable: "SETTING" });
    const proposal = planCreation(fixture, state(), request);
    const after = proposal.overrides.get(module)!;
    assert.ok(after.includes("// Shared fragments remain authored beside their workload family."));
    assert.ok(after.includes('const sharedEnvironment = { SOURCE: "authored" };'));
    assert.match(after, /SETTING: catalog\["setting"\]/);
    assert.equal((after.match(/from "\.\.\/resources"/g) ?? []).length, 1);
    const generated = parse(module, after);
    const section = generated.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations]).find(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "http")!.initializer as ts.SatisfiesExpression;
    const entry = (section.expression as ts.ObjectLiteralExpression).properties[0] as ts.PropertyAssignment;
    assertReadableObjects(entry.initializer, generated);
    assert.ok(!proposal.overrides.has(rootFile), "the existing composition remains byte-identical");
    assert.equal(readFileSync(module, "utf8"), authored, "planning never writes source");
    writeFileSync(module, authored.replace("export const http = {}", "const custom = {}; export const http = { ...custom }"));
    assert.throws(() => planCreation(fixture, state(), request), /literal section object/i);
  } finally { writeFileSync(rootFile, beforeRoot); rmSync(module); await builder.refresh(); }
});

test("new route aliases format only their copied declaration and preserve original compact source", () => {
  const request = readCreationRequest({ kind: "route", id: "pretty-alias", category: "http", path: "/pretty-alias", existingTarget: "lambda:fixture" });
  const proposal = planCreation(fixture, state(), request);
  const after = proposal.overrides.get(workload)!;
  for (const line of original.split("\n").filter(line => line.includes('"/identity'))) assert.ok(after.includes(line), "authored declaration bytes stay unchanged");
  const source = parse(workload, after);
  const section = (source.statements.find(ts.isVariableStatement)!.declarationList.declarations[0]!.initializer as ts.AsExpression).expression as ts.ObjectLiteralExpression;
  const alias = section.properties.find(property => property.name?.getText(source) === '"/pretty-alias"') as ts.PropertyAssignment;
  assertReadableObjects(alias.initializer, source);
  assert.ok(!proposal.overrides.has(path.join(fixture, "framework.config.ts")));
});

test("new network modules put generated options on separate readable lines", () => {
  const proposal = planCreation(fixture, state(), readCreationRequest({ kind: "vpc", id: "readable-vpc", cidr: "10.42.0.0/16", tags: { Feature: "Readability", Team: "Platform" } }));
  const file = path.join(fixture, "framework-config/networks/readable-vpc/index.ts");
  const source = parse(file, proposal.overrides.get(file)!);
  assertReadableObjects(source, source);
});
