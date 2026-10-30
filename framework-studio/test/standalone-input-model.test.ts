import assert from "./support/assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defineFrameworkConfig, defineResources, resource } from "@repo/framework/config";
import { projectModel } from "../server/model/project";
import { SourceFiles } from "../server/source";
import { locateTagSites, readTagSite } from "../server/source/tags";
import { inputRequirements } from "../server/input-requirements";
import { withDeploymentInputs } from "../server/deployment-inputs";
import { withClientEnvironment } from "../server/client-environment";
import { validateClientMappings } from "../server/client-environment-source";
import { previewClientBinding } from "../shared/client-environment-preview";
import { creationDefaults, readCreationRequest } from "../shared/creation";
import { inputModeIntents, sameInputModes } from "../shared/resources";
import type { ModeModel, ModelResource, ModelTarget } from "../shared/model";

const model: ModeModel = { mode: "dev", status: "ok", targets: [], routes: [], workflows: [], diagnostics: [], fields: {}, evaluatedInMs: 0, edges: [], resources: [
  { id: "resource:standalone", path: ["standalone"], kind: "input", authoredValue: "enabled", values: ["enabled", "disabled"], absent: false },
  { id: "resource:key", path: ["key"], kind: "secret", fromEnv: "KEY", absent: false },
] };

test("creation distinguishes an optional environment default from a required standalone value", () => {
  const linked = readCreationRequest({ kind: "input", id: "linked", envName: "LINKED" });
  assert.equal(linked.kind === "input" && linked.linkedToEnv, true, "older requests retain environment-linked behavior");
  assert.equal(linked.kind === "input" && linked.defaultValue, "");
  const standalone = readCreationRequest({ kind: "input", ...creationDefaults("input"), id: "standalone", linkedToEnv: false, envName: "RETAINED_HIDDEN_NAME", value: "enabled", choices: "enabled,disabled" });
  assert.equal(standalone.kind === "input" && standalone.envName, "", "a hidden name never establishes a file link");
  assert.equal(standalone.kind === "input" && standalone.value, "enabled");
  assert.throws(() => readCreationRequest({ kind: "input", id: "standalone", linkedToEnv: false }), /standalone value/);
  assert.throws(() => readCreationRequest({ kind: "input", id: "standalone", linkedToEnv: false, value: "enabled", defaultValue: "fallback" }), /without a default/);
  assert.throws(() => readCreationRequest({ kind: "input", id: "standalone", linkedToEnv: false, value: "other", choices: "enabled,disabled" }), /allowed values/);
  assert.throws(() => readCreationRequest({ kind: "input", id: "linked", envName: "LINKED", value: "enabled" }), /optional default/);
  for (const setting of [{ linkedToEnv: false }, { value: "do-not-echo-this" }]) assert.throws(() => readCreationRequest({ kind: "secret", id: "secret", envName: "SECRET", ...setting }), error => error instanceof Error && /unsupported/.test(error.message) && !error.message.includes("do-not-echo-this"));
});

test("source value policy remains distinct from environment fallbacks in resource drafts", () => {
  const entry: ModelResource = { ...model.resources[0]!, modes: { dev: { present: true, required: false, value: "enabled" }, prod: { present: true, required: false, value: "disabled" } } };
  const intent = inputModeIntents(entry);
  assert.deepEqual(intent.dev, { present: true, required: false, default: null, value: "enabled" });
  assert.deepEqual(intent.prod, { present: true, required: false, default: null, value: "disabled" });
  assert.equal(sameInputModes(intent, { ...intent, prod: { ...intent.prod, value: "enabled" } }), false);
  assert.equal(sameInputModes(intent, inputModeIntents(entry)), true);
});

test("catalog projection preserves standalone values and mode policies without a file origin", () => {
  const resources = defineResources({ standalone: resource.value({ dev: "enabled", prod: "disabled" }, { tags: { Area: "Feature flags" } }).enum("enabled", "disabled") }, { mode: "dev" });
  const config = defineFrameworkConfig({ resources, defaults: { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: {} } }, http: [], webSocket: [], events: [], services: [] });
  const projected = projectModel(config, { mode: "dev" });
  const entry = projected.resources.find(entry => entry.id === "resource:standalone")!;
  assert.equal(entry.kind, "input");
  assert.equal(entry.authoredValue, "enabled");
  assert.equal(entry.fromEnv, undefined);
  assert.equal(entry.default, undefined);
  assert.equal(entry.modes!.prod.value, "disabled");
  assert.equal(projected.tagging?.[entry.id]?.effective.Area, "Feature flags");
});

test("standalone factory metadata stays source-linked and independently tag-editable", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "standalone-source-"));
  mkdirSync(path.join(root, "framework-config"));
  try {
    writeFileSync(path.join(root, "framework-config/resources.ts"), 'import { defineResources, resource } from "@repo/framework/config";\nexport const resources = defineResources({ standalone: resource.value("enabled", { tags: { Area: "Feature flags" } }).enum("enabled", "disabled") });\n');
    writeFileSync(path.join(root, "framework.config.ts"), 'import { defineFrameworkConfig } from "@repo/framework/config";\nimport { resources } from "./framework-config/resources";\nexport default defineFrameworkConfig({ resources, defaults: {}, http: [], webSocket: [], events: [], services: [] });\n');
    const sites = locateTagSites(root, model, new SourceFiles(), "resource:standalone");
    assert.equal(sites.length, 1);
    assert.equal(sites[0]!.file, path.join(root, "framework-config/resources.ts"));
    assert.deepEqual({ ...readTagSite(sites[0]!).value }, { Area: "Feature flags" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("standalone selectors evaluate conditional requirements without needing readable input files", () => {
  const target = { ref: "lambda:consumer", title: "Consumer", lanes: { local: true, dev: false, prod: false }, requirementRules: [{ when: { resource: "resource:standalone", equals: "enabled" }, require: ["resource:key"] }] } as unknown as ModelTarget;
  const requirements = inputRequirements({ ...model, targets: [target] }, {}, "dev", "cdk-app/.env.dev", false);
  assert.equal(requirements.get("resource:key")!.required, true);
  assert.equal(requirements.has("resource:standalone"), false, "there is no file requirement for a source value");
});

test("file projections exclude standalone parameters while client recipes retain their identity", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "standalone-projection-"));
  mkdirSync(path.join(root, "cdk-app"));
  try {
    const projected = withDeploymentInputs(root, model, undefined, [{ input: "resource:standalone", equals: "enabled" }]);
    const entry = projected.resources.find(entry => entry.id === "resource:standalone")!;
    assert.equal(entry.inputState, "supplied");
    assert.equal(entry.inputComparisons?.enabled, "holds");
    assert.equal(entry.inputSources, undefined);
    assert.equal(entry.inputRequirement, undefined);
    assert.ok(!projected.resources.flatMap(entry => entry.deploymentFile?.entries ?? []).some(entry => entry.targets.includes("resource:standalone")));
    assert.ok(!projected.edges.some(edge => edge.relation === "supplies" && edge.to === "resource:standalone"));
    const mappings = { VITE_FLAG: { kind: "input" as const, name: "resource:standalone" } };
    validateClientMappings(mappings, [projected]);
    const client = withClientEnvironment(projected, { mappings });
    const file = client.resources.find(entry => entry.clientEnvironment)!.clientEnvironment!;
    assert.ok(file.options.some(option => option.binding.kind === "input" && option.binding.name === "resource:standalone"));
    assert.equal(file.entries[0]!.status, "mapped");
    assert.equal(file.entries[0]!.sources[0]!.entity, "resource:standalone");
    const preview = previewClientBinding("VITE_FLAG", mappings.VITE_FLAG, projected);
    assert.match(preview.sources[0]!.label, /standalone value/);
    assert.ok(!preview.note.includes(".env"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("canonical client recipes preserve linked input aliases without bypassing sensitive source names", () => {
  const linked: ModelResource = { id: "resource:linked", path: ["linked"], kind: "input", fromEnv: "PUBLIC_SETTING", default: "fallback", absent: false };
  const sensitive: ModelResource = { id: "resource:ordinary", path: ["ordinary"], kind: "input", fromEnv: "PRIVATE_TOKEN", default: "not-exported", absent: false };
  const current = { ...model, resources: [...model.resources, linked, sensitive] };
  for (const name of ["resource:linked", "PUBLIC_SETTING"]) {
    const mapping = { VITE_SETTING: { kind: "input" as const, name } };
    validateClientMappings(mapping, [current]);
    assert.equal(previewClientBinding("VITE_SETTING", mapping.VITE_SETTING, current).sources[0]!.entity, linked.id);
  }
  const options = withClientEnvironment(current).resources.find(entry => entry.clientEnvironment)!.clientEnvironment!.options;
  assert.ok(options.some(option => option.binding.kind === "input" && option.binding.name === linked.id));
  assert.ok(!options.some(option => option.binding.kind === "input" && option.binding.name === sensitive.id));
  for (const name of ["resource:key", "resource:ordinary"]) assert.throws(() => validateClientMappings({ VITE_KEY: { kind: "input", name } }, [current]), /secret inputs/);
});
