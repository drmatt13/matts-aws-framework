import assert from "./support/assert";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import ts from "typescript";
import { SnapshotBuilder } from "../server/snapshot";
import { namingSourceFingerprint, planResourceMove, planResourceRename, resourceReferenceIssues } from "../server/naming-source";
import { disposeNamingWorkers, planResourceNaming } from "../server/naming-service";
import { removeWithComments, reviewedComments, withCommentReview } from "../server/edits/comments";
import { sourceFixtureCheckpoint } from "./support/source-fixture";
import { isNamingSource } from "../server/naming-program";

const repository = path.resolve(__dirname, "../..");
const root = path.join(repository, ".cache/framework-studio", `naming-${randomUUID()}`);
const file = (name: string) => path.join(root, "framework-config", name);
const read = (overrides: ReadonlyMap<string, string>, name: string) => overrides.get(file(name)) ?? readFileSync(file(name), "utf8");
let builder: SnapshotBuilder;
let restore: () => Promise<void>;
before(async () => {
  mkdirSync(path.join(root, "framework-config"), { recursive: true });
  cpSync(path.join(repository, "framework-config/defaults.ts"), file("defaults.ts"));
  writeFileSync(file("parameters.ts"), `import { resource } from "@repo/framework/config";
export const enableWebSocketApi = resource.value("true").enum("true", "false");
export const derived = resource.fromEnv();
export const token = resource.secret("TOKEN", { tags: { purpose: "fixture" } });
`);
  writeFileSync(file("resources.ts"), `import { defineResources } from "@repo/framework/config";
import { enableWebSocketApi, derived, token } from "./parameters";
export const resources = defineResources({ enableWebSocketApi, group: { derived, token } });
`);
  writeFileSync(file("consumers.ts"), `import { resources } from "./resources";
export const conditions = [
  { when: resources.enableWebSocketApi }, { when: resources.enableWebSocketApi },
  { when: resources.enableWebSocketApi }, { when: resources.enableWebSocketApi },
  { when: resources.enableWebSocketApi },
];
`);
  writeFileSync(path.join(root, "framework.config.ts"), `import { defineFrameworkConfig } from "@repo/framework/config";
import { defaults } from "./framework-config/defaults";
import { resources } from "./framework-config/resources";
export default defineFrameworkConfig({ resources, defaults, http: [], webSocket: [], events: [], services: [] });
`);
  builder = new SnapshotBuilder(root);
  await builder.refresh();
  assert.equal(builder.current!.snapshot.models.dev.status, "ok", JSON.stringify(builder.current!.snapshot.models.dev.diagnostics));
});
beforeEach(() => { restore = sourceFixtureCheckpoint(root, builder); });
afterEach(async () => { await restore(); });
after(async () => { await disposeNamingWorkers(root); await builder?.dispose(); rmSync(root, { recursive: true, force: true }); });

test("renames the declaration, catalog leaf, and all five WebSocket conditions without writing", () => {
  const originalRecipes = `export const clientEnvironment = {
  // Keep the public environment field name stable.
  VITE_FLAG: { kind: "input", name: 'resource:enableWebSocketApi' /* Inline explanation. */ },
  VITE_ENDPOINT: {
    // resource:enableWebSocketApi stays in prose.
    dev: { kind: "endpoint", protocol: "ws", port: "resource:enableWebSocketApi", override: \`resource:enableWebSocketApi\`, when: {
      input: "resource:enableWebSocketApi", // Explain the condition.
      equals: "resource:enableWebSocketApi", /* This is a comparison value, not a reference. */
    } },
    prod: { kind: "input", name: "resource:enableWebSocketApi" },
  },
  VITE_UNCHANGED: { kind: "input", name: "GROUP_DERIVED" }, // Leave this complete recipe alone.
} as const;
`;
  writeFileSync(file("client-environment.ts"), originalRecipes);
  const overrides = new Map<string, string>();
  const before = readFileSync(file("parameters.ts"), "utf8");
  const result = planResourceRename(root, builder.current!, "resource:enableWebSocketApi", "webSocketEnabled", overrides);
  assert.deepEqual(result.issues, []);
  assert.equal(result.entityRemap["resource:enableWebSocketApi"], "resource:webSocketEnabled");
  assert.match(read(overrides, "parameters.ts"), /export const webSocketEnabled =/);
  assert.match(read(overrides, "resources.ts"), /defineResources\(\{ webSocketEnabled,/);
  assert.equal(read(overrides, "consumers.ts").match(/resources\.webSocketEnabled/g)?.length, 5);
  assert.equal(readFileSync(file("parameters.ts"), "utf8"), before);
  const recipes = read(overrides, "client-environment.ts");
  assert.equal(recipes.match(/resource:webSocketEnabled/g)?.length, 5);
  assert.match(recipes, /Keep the public environment field name stable/);
  assert.match(recipes, /VITE_FLAG:/);
  const expectedRecipes = originalRecipes
    .replace("name: 'resource:enableWebSocketApi'", "name: 'resource:webSocketEnabled'")
    .replace('port: "resource:enableWebSocketApi"', 'port: "resource:webSocketEnabled"')
    .replace('override: `resource:enableWebSocketApi`', 'override: `resource:webSocketEnabled`')
    .replace('input: "resource:enableWebSocketApi"', 'input: "resource:webSocketEnabled"')
    .replace('name: "resource:enableWebSocketApi"', 'name: "resource:webSocketEnabled"');
  assert.equal(recipes, expectedRecipes, "only typed reference literal spans change, preserving every other byte");
  assert.ok(result.referenceCount >= 7);
  assert.equal(result.sourceFingerprint, namingSourceFingerprint(root));
});

test("semantic references preserve local aliases, destructured bindings, and unrelated text", () => {
  writeFileSync(file("barrel.ts"), `export { resources } from "./resources";\n`);
  writeFileSync(file("aliases.ts"), `import * as catalog from "./barrel";
import { enableWebSocketApi as localFlag } from "./parameters";
const receiver = catalog.resources;
const { enableWebSocketApi: explicitLocal } = receiver;
const { enableWebSocketApi } = receiver;
export const references = [receiver["enableWebSocketApi"], explicitLocal, enableWebSocketApi, localFlag];
export type Flag = typeof catalog.resources.enableWebSocketApi;
// enableWebSocketApi stays in comments.
export const text = "enableWebSocketApi";
`);
  const overrides = new Map<string, string>();
  const result = planResourceRename(root, builder.current!, "resource:enableWebSocketApi", "webSocketEnabled", overrides);
  assert.deepEqual(result.issues, []);
  const after = read(overrides, "aliases.ts");
  assert.match(after, /webSocketEnabled as localFlag/);
  assert.match(after, /webSocketEnabled: explicitLocal/);
  assert.match(after, /webSocketEnabled: enableWebSocketApi/);
  assert.match(after, /receiver\["webSocketEnabled"\]/);
  assert.match(after, /typeof catalog\.resources\.webSocketEnabled/);
  assert.match(after, /\/\/ enableWebSocketApi stays in comments\./);
  assert.match(after, /text = "enableWebSocketApi"/);
});

test("computed and reflective catalog references return actionable blockers while retaining preview", () => {
  writeFileSync(file("dynamic.ts"), `import { resources } from "./resources";
const key = "enableWebSocketApi" as const;
export const dynamic = resources[key];
export const reflected = Reflect.get(resources, "enableWebSocketApi");
export const descriptor = Object.getOwnPropertyDescriptor(resources, "enableWebSocketApi");
const erased: Record<string, unknown> = resources;
declare function untyped(value: any): void;
untyped(resources);
`);
  const overrides = new Map<string, string>();
  const result = planResourceRename(root, builder.current!, "resource:enableWebSocketApi", "webSocketEnabled", overrides);
  assert.ok(result.issues.some(issue => issue.message.includes("computed catalog key")), JSON.stringify(result.issues));
  assert.ok(result.issues.filter(issue => issue.message.includes("shape-erasing")).length >= 4, JSON.stringify(result.issues));
  assert.ok(result.issues.every(issue => issue.source.file === "framework-config/dynamic.ts"));
  assert.ok(result.issues.every(issue => issue.message.includes("existing resource name until Apply")));
  assert.match(read(overrides, "parameters.ts"), /export const webSocketEnabled/);
  assert.match(read(overrides, "dynamic.ts"), /Reflect\.get\(resources, "enableWebSocketApi"\)/);
});

test("group renaming pins derived environments and secret binding identity", () => {
  writeFileSync(file("client-environment.ts"), 'export const clientEnvironment = { VITE_UNCHANGED: { kind: "input", name: "resource:enableWebSocketApi" /* Keep this exactly. */ } } as const;\n');
  writeFileSync(file("group-consumer.ts"), `import { resources } from "./resources";
export const values = [resources.group.derived, resources.group.token.arn];
`);
  const overrides = new Map<string, string>();
  const result = planResourceRename(root, builder.current!, "resource:group", "settings", overrides);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.entityRemap, { "resource:group": "resource:settings", "resource:group.derived": "resource:settings.derived", "resource:group.token": "resource:settings.token" });
  assert.match(read(overrides, "parameters.ts"), /resource\.fromEnv\("GROUP_DERIVED"\)/);
  assert.match(read(overrides, "parameters.ts"), /bindingPath: \["group","token"\]/);
  assert.match(read(overrides, "parameters.ts"), /tags: \{ purpose: "fixture" \}/);
  assert.match(read(overrides, "group-consumer.ts"), /resources\.settings\.token\.arn/);
  assert.equal(overrides.has(file("client-environment.ts")), false, "unaffected recipes are omitted from the source changes");
});

test("supported input group moves retain direct references and reject hidden alias rewrites", () => {
  writeFileSync(file("group-consumer.ts"), `import { resources } from "./resources";
export const value = resources.group.derived;
`);
  const overrides = new Map<string, string>();
  const result = planResourceMove(root, builder.current!, "resource:group.derived", ["flags", "derived"], overrides);
  assert.deepEqual(result.issues, []);
  assert.match(read(overrides, "group-consumer.ts"), /resources\["flags"\]\["derived"\]/);
  assert.match(read(overrides, "parameters.ts"), /fromEnv\("GROUP_DERIVED"\)/);
  writeFileSync(file("group-consumer.ts"), `import * as catalog from "./resources";
const group = catalog.resources.group;
export const value = group.derived;
`);
  assert.ok(resourceReferenceIssues(root, builder.current!, "resource:group.derived").some(issue => issue.message.includes("structural source rewrite")));
});

test("kind conversion inventory blocks namespace catalog and receiver alias accesses", () => {
  writeFileSync(file("conversion.ts"), `import * as catalog from "./resources";
const receiver = catalog.resources;
export const namespaceValue = catalog.resources.enableWebSocketApi;
export const aliasedValue = receiver.enableWebSocketApi;
`);
  const issues = resourceReferenceIssues(root, builder.current!, "resource:enableWebSocketApi");
  const structural = issues.filter(issue => issue.message.includes("structural source rewrite"));
  assert.equal(structural.length, 2, JSON.stringify(issues));
  assert.ok(structural.every(issue => issue.message.includes("existing resources.enableWebSocketApi")));
});

test("reference fingerprints include newly added source and project membership", () => {
  const before = namingSourceFingerprint(root);
  writeFileSync(file("new-consumer.ts"), `import { resources } from "./resources"; export const value = resources.enableWebSocketApi;`);
  assert.notEqual(namingSourceFingerprint(root), before);
  rmSync(file("new-consumer.ts"));
  assert.equal(namingSourceFingerprint(root), before);
});

test("the source API independently rejects groups containing native deployed identities", () => {
  const state = builder.current!;
  const forbidden = { ...state, snapshot: { ...state.snapshot, models: { ...state.snapshot.models, dev: { ...state.snapshot.models.dev, resources: [...state.snapshot.models.dev.resources, { ...state.snapshot.models.dev.resources[0]!, id: "resource:group.native", path: ["group", "native"], kind: "stack" as const }] } } } };
  const overrides = new Map<string, string>();
  const result = planResourceRename(root, forbidden, "resource:group", "settings", overrides);
  assert.ok(result.issues.some(issue => issue.message.includes("native or deployed resource identities")));
  assert.equal(overrides.size, 0);
});

test("async review keeps the event loop responsive and merges only candidate source", async () => {
  const overrides = new Map<string, string>();
  const saved = readFileSync(file("parameters.ts"), "utf8");
  let complete = false;
  const planning = planResourceNaming(root, builder.current!, { kind: "rename", entity: "resource:enableWebSocketApi", name: "webSocketEnabled" }, overrides).then(result => { complete = true; return result; });
  const started = Date.now();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(Date.now() - started < 1_000, "an HTTP server timer can run while TypeScript indexes source");
  assert.equal(complete, false, "indexing runs independently of the parent event loop");
  const result = await planning;
  assert.deepEqual(result.issues, []);
  assert.equal(result.entityRemap["resource:enableWebSocketApi"], "resource:webSocketEnabled");
  assert.match(read(overrides, "parameters.ts"), /export const webSocketEnabled/);
  assert.equal(readFileSync(file("parameters.ts"), "utf8"), saved);
});

test("closing the owner cancels and awaits its naming worker without merging source", async () => {
  const started = Date.now();
  const overrides = new Map<string, string>();
  const planning = planResourceNaming(root, builder.current!, { kind: "rename", entity: "resource:enableWebSocketApi", name: "webSocketEnabled" }, overrides);
  await new Promise(resolve => setTimeout(resolve, 25));
  await disposeNamingWorkers(root);
  const result = await planning;
  assert.ok(result.issues.some(issue => issue.message.includes("cancelled during shutdown")));
  assert.equal(result.sourceFiles.length, 0);
  assert.equal(overrides.size, 0);
  assert.ok(Date.now() - started < 5_000, "owner disposal completes before the review deadline");
});

test("cancellation awaits process exit during backpressured startup IPC", async () => {
  const current = builder.current!;
  const state = { ...current, snapshot: { ...current.snapshot, descriptions: { ...current.snapshot.descriptions, "resource:enableWebSocketApi": "public description ".repeat(65_536) } } };
  for (const delay of [0, 25, 50]) {
    const started = Date.now(), overrides = new Map<string, string>();
    const planning = planResourceNaming(root, state, { kind: "rename", entity: "resource:enableWebSocketApi", name: "webSocketEnabled" }, overrides);
    await new Promise(resolve => setTimeout(resolve, delay));
    await disposeNamingWorkers(root);
    const result = await planning;
    assert.ok(result.issues.some(issue => issue.message.includes("cancelled during shutdown")));
    assert.equal(overrides.size, 0);
    assert.ok(Date.now() - started < 5_000, `startup cancellation at ${delay}ms must not wait for the 120s deadline`);
  }
});

test("async moves return comment review choices and honor keep or remove", async () => {
  const catalog = readFileSync(file("resources.ts"), "utf8").replace("group: { derived, token }", "group: { derived, /* Explain this input. */ token }");
  writeFileSync(file("resources.ts"), catalog);
  const kept = new Map<string, string>();
  const first = await withCommentReview(root, undefined, async () => {
    const result = await planResourceNaming(root, builder.current!, { kind: "move", entity: "resource:group.derived", nextPath: ["flags", "derived"] }, kept);
    return { result, comments: reviewedComments() };
  });
  assert.deepEqual(first.result.issues, []);
  assert.equal(first.comments.length, 1);
  assert.equal(first.comments[0]!.resolution, "keep");
  assert.match(read(kept, "resources.ts"), /Explain this input/);
  const removed = new Map<string, string>();
  const second = await withCommentReview(root, { comments: { [first.comments[0]!.id]: "remove" } }, async () => {
    const result = await planResourceNaming(root, builder.current!, { kind: "move", entity: "resource:group.derived", nextPath: ["flags", "derived"] }, removed);
    return { result, comments: reviewedComments() };
  });
  assert.deepEqual(second.result.issues, []);
  assert.equal(second.comments[0]!.resolution, "remove");
  assert.doesNotMatch(read(removed, "resources.ts"), /Explain this input/);
  assert.equal(readFileSync(file("resources.ts"), "utf8"), catalog);
});

test("a worker continues duplicate-comment occurrences after an earlier composed splice", async () => {
  const prose = "/* Shared explanation. */";
  const catalog = readFileSync(file("resources.ts"), "utf8").replace("{ enableWebSocketApi, group: { derived, token } }", `{ ${prose} enableWebSocketApi, group: { ${prose} derived, token } }`);
  writeFileSync(file("resources.ts"), catalog);
  const source = ts.createSourceFile(file("resources.ts"), catalog, ts.ScriptTarget.Latest, true);
  let membership: ts.ShorthandPropertyAssignment | undefined;
  const visit = (node: ts.Node) => { if (ts.isShorthandPropertyAssignment(node) && node.name.text === "enableWebSocketApi") membership = node; ts.forEachChild(node, visit); };
  visit(source);
  assert.ok(membership);
  const from = catalog.indexOf(prose), spans = [{ from, to: from + prose.length }];
  const initial = withCommentReview(root, undefined, () => { removeWithComments(catalog, source, membership!, spans); return reviewedComments(); });
  assert.equal(initial.length, 1);
  const overrides = new Map<string, string>();
  const reviewed = await withCommentReview(root, { comments: { [initial[0]!.id]: "remove" } }, async () => {
    overrides.set(file("resources.ts"), removeWithComments(catalog, source, membership!, spans));
    const result = await planResourceNaming(root, builder.current!, { kind: "move", entity: "resource:group.derived", nextPath: ["flags", "derived"] }, overrides);
    return { result, comments: reviewedComments() };
  });
  assert.deepEqual(reviewed.result.issues, []);
  assert.equal(reviewed.comments.length, 2);
  assert.deepEqual(reviewed.comments.map(comment => comment.resolution), ["remove", "keep"]);
  assert.equal(read(overrides, "resources.ts").split(prose).length - 1, 1);
});

test("queued workers retain their owning batch comment contexts", async () => {
  writeFileSync(file("resources.ts"), readFileSync(file("resources.ts"), "utf8").replace("group: { derived, token }", "group: { derived, /* Queued explanation. */ token }"));
  const results = await Promise.all(Array.from({ length: 3 }, () => withCommentReview(root, undefined, async () => {
    const result = await planResourceNaming(root, builder.current!, { kind: "move", entity: "resource:group.derived", nextPath: ["flags", "derived"] }, new Map());
    return { result, comments: reviewedComments() };
  })));
  for (const value of results) { assert.deepEqual(value.result.issues, []); assert.equal(value.comments.length, 1); }
});

test("worker startup failures release their active slot and settle review", async () => {
  const missing = path.join(root, "missing-repository");
  const started = Date.now();
  const result = await planResourceNaming(missing, builder.current!, { kind: "rename", entity: "resource:enableWebSocketApi", name: "webSocketEnabled" }, new Map());
  assert.ok(result.issues.some(issue => issue.message.includes("could not start")));
  assert.ok(Date.now() - started < 5_000);
  await disposeNamingWorkers(missing);
});

test("file and directory symlink consumers block review before Apply", () => {
  const targets = path.join(root, ".cache/linked-sources");
  mkdirSync(path.join(targets, "directory"), { recursive: true });
  writeFileSync(path.join(targets, "file.ts"), 'import { resources } from "../framework-config/resources";\nexport const linked = resources.enableWebSocketApi;\n');
  writeFileSync(path.join(targets, "directory/consumer.ts"), 'import { resources } from "../../framework-config/resources";\nexport const linked = resources.enableWebSocketApi;\n');
  const linkedFile = file("linked-consumer.ts"), linkedDirectory = file("linked-directory");
  symlinkSync(path.join(targets, "file.ts"), linkedFile);
  symlinkSync(path.join(targets, "directory"), linkedDirectory, "dir");
  try {
    writeFileSync(file("imports-links.ts"), 'import "./linked-consumer";\nimport "./linked-directory/consumer";\n');
    assert.equal(isNamingSource(root, linkedFile), false);
    assert.equal(isNamingSource(root, path.join(linkedDirectory, "consumer.ts")), false);
    assert.equal(isNamingSource(root, file("consumers.ts")), true);
    const overrides = new Map<string, string>();
    const result = planResourceRename(root, builder.current!, "resource:enableWebSocketApi", "webSocketEnabled", overrides);
    const linked = result.issues.filter(issue => issue.message.includes("generated, linked, or outside authored source"));
    assert.equal(linked.length, 2, JSON.stringify(result.issues));
    assert.ok(linked.every(issue => issue.source.line === 2));
    assert.ok([...overrides.keys()].every(candidate => !candidate.includes("linked-consumer") && !candidate.includes("linked-directory") && !candidate.includes("linked-sources")));
  } finally {
    rmSync(linkedFile, { force: true });
    rmSync(linkedDirectory, { force: true });
  }
});

test("the generic CDK exporter is a no-op adapter while direct resource access remains blocked", () => {
  const scripts = path.join(root, "scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true, noEmit: true }, include: ["framework-config/**/*.ts", "scripts/resource-export.ts"] }));
  writeFileSync(path.join(scripts, "resource-export.ts"), 'export { resources } from "../framework-config/resources";\nexport function collectDevelopmentResources(listed: unknown[], name: string, framework: unknown) { return { listed, name, framework }; }\n');
  const exporter = `import { resolve } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { listResourceDeclarations } = require("@repo/framework/config");
const { collectDevelopmentResources } = require("./resource-export.ts");
const { resolveClientEnvironmentMappings } = require("./client-environment-export.ts");
const mappingRoot = process.cwd();
const { default: framework } = require(resolve(mappingRoot, "framework.config.ts"));
const declarations = listResourceDeclarations(framework.resources);
const client = resolveClientEnvironmentMappings({}, { declarations });
const development = collectDevelopmentResources([], "local", framework);
`;
  const filename = path.join(scripts, "export-cdk-outputs.mjs");
  writeFileSync(filename, exporter);
  const unchanged = new Map<string, string>();
  const generic = planResourceRename(root, builder.current!, "resource:enableWebSocketApi", "webSocketEnabled", unchanged);
  assert.deepEqual(generic.issues, []);
  assert.equal(unchanged.has(filename), false);
  assert.equal(readFileSync(filename, "utf8"), exporter);
  writeFileSync(filename, exporter + 'export const direct = framework.resources.enableWebSocketApi;\n');
  const direct = planResourceRename(root, builder.current!, "resource:enableWebSocketApi", "webSocketEnabled", new Map());
  assert.ok(direct.issues.some(issue => issue.source.file === "scripts/export-cdk-outputs.mjs" && issue.message.includes("outside a configured TypeScript project")), JSON.stringify(direct.issues));
  for (const access of ['indexedCatalog.enableWebSocketApi', 'indexedCatalog[["enable", "WebSocketApi"].join("")]']) {
    writeFileSync(filename, exporter + `const indexedCatalog = Object.fromEntries(declarations.map(item => [item.path.at(-1), item]));\nconsole.log(${access});\n`);
    const derived = planResourceRename(root, builder.current!, "resource:enableWebSocketApi", "webSocketEnabled", new Map());
    assert.ok(derived.issues.some(issue => issue.source.file === "scripts/export-cdk-outputs.mjs" && issue.message.includes("outside a configured TypeScript project")), JSON.stringify(derived.issues));
  }
});
