import assert from "./support/assert";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import type { ResourceIntent } from "../shared/resources";
import { SnapshotBuilder } from "../server/snapshot";
import { readResourceIntent, ResourceService } from "../server/resources";
import { DeploymentInputService } from "../server/deployment-input-edits";
import { SourceJournal } from "../server/edits/journal";

const root = path.resolve(__dirname, "../..");
const fixture = path.join(root, ".cache/framework-studio", `resources-${randomUUID()}`);
let builder: SnapshotBuilder;
let service: ResourceService;
const catalog = path.join(fixture, "framework-config/resources.ts");
const route = path.join(fixture, "framework-config/http.ts");
const original = `import { defineResources, resource } from "@repo/framework/config";
export const resources = defineResources({
  key: resource.secret("FIXTURE_KEY"),
  setting: resource.fromEnv("FIXTURE_SETTING").default("initial"),
  group: { derived: resource.fromEnv() },
});
`;
const http = `import { resources } from "./resources";
export const routes = { "/fixture": {
  directory: "/lambda_functions/fixture",
  methods: ["GET"],
  environment: { SETTING: resources.setting, SECRET_ARN: resources.key.arn },
  cloud: { requirements: [{ when: { resource: resources.setting, equals: "required" }, require: [resources.key], message: "A fixture requirement." }] },
} } as const;
`;
const revision = () => builder.current!.snapshot.revision;
const intent = (changes: Partial<ResourceIntent> = {}): ResourceIntent => ({ resource: "resource:setting", kind: "input", default: "initial", group: "", requirements: {}, ...changes });
before(async () => {
  mkdirSync(path.join(fixture, "framework-config"), { recursive: true });
  mkdirSync(path.join(fixture, "cdk-app/lambda_functions/fixture"), { recursive: true });
  writeFileSync(path.join(fixture, "cdk-app/lambda_functions/fixture/index.ts"), "export const handler = async () => ({});\n");
  cpSync(path.join(root, "framework-config/defaults.ts"), path.join(fixture, "framework-config/defaults.ts"));
  writeFileSync(catalog, original);
  writeFileSync(route, http);
  writeFileSync(path.join(fixture, "framework.config.ts"), `import { defineFrameworkConfig } from "@repo/framework/config";
import { defaults } from "./framework-config/defaults";
import { resources } from "./framework-config/resources";
import { routes } from "./framework-config/http";
export default defineFrameworkConfig({ resources, defaults, http: [routes], webSocket: [], events: [], services: [] });
`);
  writeFileSync(path.join(fixture, "cdk-app/.env.dev"), '# fixture only\nFIXTURE_KEY="test secret with # and ="\nFIXTURE_SETTING="from local env"\nUNDECLARED_PRIVATE="do not return"\nGROUP_DERIVED="derived value"\n');
  builder = new SnapshotBuilder(fixture);
  service = new ResourceService(fixture, builder);
  await builder.refresh();
});
after(async () => { await builder?.dispose(); rmSync(fixture, { recursive: true, force: true }); });

test("only defined authored resources can reveal a targeted .env value, snapshots remain value-free", () => {
  assert.equal(service.details("resource:key", "dev").value, "test secret with # and =");
  assert.equal(service.details("resource:setting", "dev").value, "from local env");
  assert.equal(service.details("resource:group.derived", "dev").value, "derived value");
  for (const id of ["UNDECLARED_PRIVATE", "resource:UNDECLARED_PRIVATE", "../../cdk-app/.env", "resource:group"]) assert.throws(() => service.details(id, "dev"));
  const snapshot = JSON.stringify(builder.current!.snapshot);
  assert.ok(!snapshot.includes("test secret with # and ="));
  assert.ok(!snapshot.includes("do not return"));
  assert.ok(!snapshot.includes("from local env"));
  assert.equal(service.details("resource:key", "dev").consumers[0]?.rules[0]?.when?.equals, "required");
});

test("missing and empty values differ from a configured value", () => {
  const file = path.join(fixture, "cdk-app/.env.dev");
  const before = readFileSync(file, "utf8");
  try {
    writeFileSync(file, "FIXTURE_KEY=\n");
    assert.equal(service.details("resource:key", "dev").value, "");
    assert.equal(service.details("resource:key", "dev").configured, true);
    assert.equal(service.details("resource:setting", "dev").configured, false);
  } finally { writeFileSync(file, before); }
});

test("a selected input supplies the file revision for private review without reading other variables", () => {
  const details = service.details("resource:setting", "dev");
  assert.equal(details.inputFile?.exists, true);
  assert.equal(service.details("resource:setting", "prod").inputFile?.exists, false);
  assert.ok(!JSON.stringify(details).includes("UNDECLARED_PRIVATE"));
  assert.ok(!JSON.stringify(details).includes("test secret with # and ="));
  const inputs = new DeploymentInputService(fixture, builder);
  const plan = inputs.plan("dev", [{ name: "FIXTURE_SETTING", value: "selected-value-update" }], details.inputFile!.hash, revision());
  assert.equal(plan.ok, true);
  assert.ok(!JSON.stringify(plan).includes("selected-value-update"));
  assert.ok(readFileSync(path.join(fixture, "cdk-app/.env.dev"), "utf8").includes('FIXTURE_SETTING="from local env"'), "review does not write");
});

test("default changes are evaluated from candidate source, applied, undone and redone exactly", async () => {
  assert.equal(builder.current!.snapshot.models.dev.status, "ok", JSON.stringify(builder.current!.snapshot.models.dev.diagnostics));
  const plan = await service.plan(intent({ default: "changed" }), revision(), "dev");
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  assert.equal(readFileSync(catalog, "utf8"), original, "preview must not write source");
  assert.match(plan.changes[0]!.diff.unified, /default\("changed"\)/);
  assert.equal((await service.apply(plan.planId)).status, "applied");
  assert.equal(builder.current!.snapshot.models.dev.resources.find((resource) => resource.id === "resource:setting")?.default, "changed");
  assert.equal((await service.replay("undo")).status, "applied");
  assert.equal(readFileSync(catalog, "utf8"), original);
  assert.equal((await service.replay("redo")).status, "applied");
  await service.replay("undo");
});

test("moving an input rewrites catalog references and keeps a derived env key stable", async () => {
  const plan = await service.plan(intent({ resource: "resource:group.derived", default: null, group: "newGroup" }), revision(), "dev");
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  assert.equal(plan.nextResource, "resource:newGroup.derived");
  await service.apply(plan.planId);
  assert.equal(service.details(plan.nextResource, "dev").value, "derived value");
  await service.replay("undo");
  assert.equal(readFileSync(catalog, "utf8"), original);
  const used = await service.plan(intent({ group: "providers" }), revision(), "dev");
  assert.equal(used.ok, true, JSON.stringify(used.diagnostics));
  assert.equal(used.changes.length, 2);
  await service.apply(used.planId);
  assert.match(readFileSync(route, "utf8"), /providers.*setting/);
  assert.equal((await service.replay("undo")).status, "applied");
  assert.equal(readFileSync(route, "utf8"), http);
});

test("secret conversion cannot keep a fallback or bypass a string-only requirement condition", async () => {
  await assert.rejects(service.plan(intent({ kind: "secret" }), revision(), "dev"), /cannot have a default/);
  const refused = await service.plan(intent({ kind: "secret", default: null }), revision(), "dev");
  assert.equal(refused.ok, false, "a selector used as a string cannot become a secret without changing its consumers");
  await assert.rejects(service.apply(refused.planId), /refuses/);
  assert.equal(readFileSync(catalog, "utf8"), original);
});

test("workload requirement edits preserve the other rule fields and are reversible", async () => {
  const consumer = service.details("resource:key", "dev").consumers[0]!.target;
  const plan = await service.plan(intent({ resource: "resource:key", kind: "secret", default: null, requirements: { [consumer]: "required" } }), revision(), "dev");
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  await service.apply(plan.planId);
  const rules = service.details("resource:key", "dev").consumers[0]!.rules;
  assert.ok(rules.some((rule) => !rule.when && rule.require.includes("resource:key")));
  await service.replay("undo");
  assert.equal(readFileSync(route, "utf8"), http);
});

test("a concurrent edit expires a preview without overwriting it", async () => {
  const plan = await service.plan(intent({ default: "changed" }), revision(), "dev");
  const theirs = original + "// concurrent edit\n";
  writeFileSync(catalog, theirs);
  await assert.rejects(service.apply(plan.planId), /changed/);
  assert.equal(readFileSync(catalog, "utf8"), theirs);
  writeFileSync(catalog, original);
  await builder.refresh();
});

test("failed multi-file resource edits preserve an external deletion and restore remaining files", async () => {
  const history = service.history();
  const plan = await service.plan(intent({ group: "providers" }), revision(), "dev");
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  assert.equal(plan.changes.length, 2);
  const refresh = builder.refresh.bind(builder);
  let fail = true;
  builder.refresh = async () => {
    if (fail) {
      fail = false;
      rmSync(route);
    }
    throw new Error("Simulated verification failure after an external deletion");
  };
  try {
    const result = await service.apply(plan.planId);
    assert.equal(result.status, "unconfirmed", result.message);
    assert.match(result.message, /snapshot could not be refreshed/);
    assert.equal(readFileSync(catalog, "utf8"), original, "one failed restoration cannot skip another file");
    assert.equal(existsSync(route), false, "the external deletion remains intact");
    assert.deepEqual(service.history(), history, "a failed edit is never recorded as applied");
  } finally {
    builder.refresh = refresh;
    writeFileSync(catalog, original);
    writeFileSync(route, http);
    await builder.refresh();
    const journal = new SourceJournal(fixture), pending = journal.pending();
    assert.equal(pending.length, 1, "conflicted source restoration requires explicit completion");
    journal.keepCurrent(pending[0]!.id, pending[0]!.fingerprint, "KEEP CURRENT SOURCE");
  }
});

test("resource API rejects malformed policies and secret values never enter any preview", () => {
  assert.throws(() => readResourceIntent({ intent: { ...intent(), required: "yes" } }));
  assert.throws(() => readResourceIntent({ intent: { ...intent(), requirements: { bad: "unknown" } } }));
  assert.deepEqual(readResourceIntent({ intent: intent() }), intent());
  assert.ok(existsSync(path.join(fixture, "cdk-app/.env.dev")));
});

test("catalog required flags persist through review and can be removed without rewriting consumers", async () => {
  for (const resource of ["resource:setting", "resource:key"]) {
    const secret = resource === "resource:key";
    const change = intent({ resource, kind: secret ? "secret" : "input", default: secret ? null : "initial", required: true });
    const plan = await service.plan(change, revision(), "dev");
    assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
    assert.equal(readFileSync(catalog, "utf8"), original, "review does not write");
    await service.apply(plan.planId);
    assert.equal(builder.current!.snapshot.models.dev.resources.find((item) => item.id === resource)?.required, true);
    assert.ok(builder.current!.snapshot.models.dev.targets.some((target) => target.requirementRules?.some((rule) => !rule.when && rule.require.includes(resource))));
    const remove = await service.plan({ ...change, required: false }, revision(), "dev");
    assert.equal(remove.ok, true);
    await service.apply(remove.planId);
    assert.equal(readFileSync(catalog, "utf8"), original);
    assert.equal(readFileSync(route, "utf8"), http);
  }
});

test("a secret flag can be changed when consumers support the new kind", async () => {
  const plan = await service.plan(intent({ resource: "resource:key", kind: "input", default: null }), revision(), "dev");
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  await service.apply(plan.planId);
  assert.equal(builder.current!.snapshot.models.dev.resources.find((resource) => resource.id === "resource:key")?.kind, "input");
  assert.ok(!readFileSync(route, "utf8").includes(".key.arn"));
  await service.replay("undo");
  assert.equal(readFileSync(catalog, "utf8"), original);
  assert.equal(readFileSync(route, "utf8"), http);
  const secret = await service.plan(intent({ resource: "resource:group.derived", kind: "secret", group: "group", default: null }), revision(), "dev");
  assert.equal(secret.ok, true, JSON.stringify(secret.diagnostics));
  await service.apply(secret.planId);
  assert.equal(builder.current!.snapshot.models.dev.resources.find((resource) => resource.id === "resource:group.derived")?.kind, "secret");
  await service.replay("undo");
});
