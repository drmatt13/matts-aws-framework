import assert from "./support/assert";
import { test } from "node:test";
import { defineFrameworkConfig, defineResources, deployInputsFrom, resource, type FrameworkConfig, type ResourceDeclarationGroup, type ResourceReference } from "@repo/framework/config";
import { defaults } from "../../framework-config/defaults";
import { renameEquivalenceSignature } from "../server/naming-equivalence";
import { projectModel } from "../server/model/project";
import type { Mode, ModeModel } from "../shared/model";

const remap = { "resource:settings": "resource:tuning" };
const before = defineResources({ settings: {
  flag: resource.value("true", { tags: { area: "realtime" } }).enum("true", "false").note("Keep settings.flag as prose"),
  key: resource.secret("API_KEY").required(),
} });
const after = defineResources({ tuning: {
  flag: resource.value("true", { tags: { area: "realtime" } }).enum("true", "false").note("Keep settings.flag as prose"),
  key: resource.secret("API_KEY", { bindingPath: ["settings", "key"] }).required(),
} });

function model(catalog: ResourceDeclarationGroup, flag: ResourceReference<"string">, keyArn: ResourceReference<"string">, mode: Mode): ModeModel {
  const config = defineFrameworkConfig({ resources: catalog, defaults,
    http: [{ "/worker": { directory: "/lambda_functions/worker", methods: ["POST"], auth: false,
      deploy: { when: { resource: flag, equals: "true" } },
      environment: { FLAG: flag, KEY_ARN: keyArn, LITERAL: "resource:settings.flag" },
      cloud: { constructId: "StableWorker", access: [{ actions: ["s3:GetObject"], resources: ["arn:{partition}:s3:::settings.flag/*"] }] },
    } }],
    webSocket: [], events: [], tasks: [], services: [], workflows: [],
  } as never) as FrameworkConfig;
  return projectModel(config, { mode, inputs: { dev: deployInputsFrom({ env: {} }), prod: deployInputsFrom({ env: {} }) } });
}
const previous = (mode: Mode = "dev") => model(before, before.settings.flag, before.settings.key.arn, mode);
const candidate = (mode: Mode = "dev") => model(after, after.tuning.flag, after.tuning.key.arn, mode);

test("identity-only input group renames preserve both-mode declaration semantics including effective secret bindings", () => {
  for (const mode of ["dev", "prod"] as const) {
    assert.equal(renameEquivalenceSignature(previous(mode), remap), renameEquivalenceSignature(candidate(mode)));
    assert.notEqual(renameEquivalenceSignature(previous(mode)), renameEquivalenceSignature(candidate(mode)));
  }
});

test("approved reparenting ignores synthetic groups while retaining leaf values and binding identities", () => {
  const top = defineResources({ flag: resource.value("true", { tags: { area: "realtime" } }).enum("true", "false").note("Keep settings.flag as prose"), key: resource.secret("API_KEY", { bindingPath: ["settings", "key"] }).required() });
  const moved = defineResources({ providers: {
    flag: resource.value("true", { tags: { area: "realtime" } }).enum("true", "false").note("Keep settings.flag as prose"), key: resource.secret("API_KEY", { bindingPath: ["settings", "key"] }).required(),
  } });
  const previous = model(top, top.flag, top.key.arn, "dev"), candidate = model(moved, moved.providers.flag, moved.providers.key.arn, "dev");
  const movedIds = { "resource:flag": "resource:providers.flag", "resource:key": "resource:providers.key" };
  assert.notEqual(renameEquivalenceSignature(previous, movedIds), renameEquivalenceSignature(candidate));
  const signature = renameEquivalenceSignature(previous, movedIds, { reparent: true });
  assert.equal(signature, renameEquivalenceSignature(candidate, {}, { reparent: true }));
  const changed = { ...candidate, resources: candidate.resources.map(item => item.kind === "input" ? { ...item, authoredValue: "false" } : item) };
  assert.notEqual(signature, renameEquivalenceSignature(changed, {}, { reparent: true }));
  const badKey = { ...candidate, resources: candidate.resources.map(item => item.kind === "secret" ? { ...item, bindingPath: ["providers", "key"] } : item) };
  assert.notEqual(signature, renameEquivalenceSignature(badKey, {}, { reparent: true }));
});

test("the signature preserves authored values, notes, variables, permissions and deployed identities", () => {
  const baseline = candidate();
  const signature = renameEquivalenceSignature(baseline);
  const changes: Readonly<Record<string, (value: ModeModel) => ModeModel>> = {
    "source value": value => ({ ...value, resources: value.resources.map(item => item.id === "resource:tuning.flag" ? { ...item, authoredValue: "false" } : item) }),
    "note prose": value => ({ ...value, resources: value.resources.map(item => item.id === "resource:tuning.flag" ? { ...item, note: "Keep tuning.flag as prose" } : item) }),
    "binding identity": value => ({ ...value, resources: value.resources.map(item => item.id === "resource:tuning.key" ? { ...item, bindingPath: ["tuning", "key"] } : item) }),
    "environment origin": value => ({ ...value, resources: value.resources.map(item => item.id === "resource:tuning.key" ? { ...item, fromEnv: "NEW_API_KEY" } : item) }),
    "construct identity": value => ({ ...value, targets: value.targets.map(item => ({ ...item, constructId: "OtherWorker" })) }),
    "workload directory": value => ({ ...value, targets: value.targets.map(item => ({ ...item, directory: "/lambda_functions/other" })) }),
    "environment name": value => ({ ...value, targets: value.targets.map(item => ({ ...item, environment: item.environment.map(entry => ({ ...entry, name: `OTHER_${entry.name}` })) })) }),
    "literal reference-shaped string": value => ({ ...value, targets: value.targets.map(item => ({ ...item, environment: item.environment.map(entry => entry.value.kind === "literal" ? { ...entry, value: { kind: "literal", value: "resource:tuning.flag" } } : entry) })) }),
    "ARN scope": value => ({ ...value, targets: value.targets.map(item => ({ ...item, access: [{ actions: ["s3:GetObject"], resources: ["arn:{partition}:s3:::tuning.flag/*"] }] })) }),
    "IAM action": value => ({ ...value, targets: value.targets.map(item => ({ ...item, access: [{ actions: ["s3:PutObject"], resources: item.access[0]!.resources }] })) }),
    "delivery projection": value => ({ ...value, targets: value.targets.map(item => ({ ...item, environment: item.environment.map(entry => entry.value.kind === "reference" && entry.name === "KEY_ARN" ? { ...entry, value: { ...entry.value, display: "resources.tuning.key" } } : entry) })) }),
    "required presence": value => ({ ...value, resources: value.resources.map(item => item.id === "resource:tuning.key" ? { ...item, required: false } : item) }),
  };
  for (const [name, change] of Object.entries(changes)) assert.notEqual(renameEquivalenceSignature(change(baseline)), signature, name);
});

test("only formatter-owned reference displays and explicit workflow resource markers are remapped", () => {
  const workflow = (renamed: boolean) => ({ ref: "workflow:fixture", id: "fixture", type: "standard" as const, timeoutSeconds: 60, names: { one: "StableState" }, targets: [],
    integrations: [{ key: "stable-key", resource: renamed ? "resource:tuning.flag" : "resource:settings.flag", operations: ["get"], awaitsCallback: false }],
    root: { literal: "resource:settings.flag", nested: { $resource: renamed ? "tuning.flag" : "settings.flag" },
      reference: { $resource: "@repo/framework/resource", path: [renamed ? "tuning" : "settings", "key"], bindingPath: ["settings", "key"],
        arn: { $resource: "@repo/framework/resource", path: [renamed ? "tuning" : "settings", "key"], secretArn: true } } },
  });
  const left = { ...previous(), workflows: [workflow(false)] }, right = { ...candidate(), workflows: [workflow(true)] };
  assert.equal(renameEquivalenceSignature(left, remap), renameEquivalenceSignature(right));
  const changed = { ...right, workflows: [{ ...right.workflows[0]!, root: { ...right.workflows[0]!.root, literal: "resource:tuning.flag" } }] };
  assert.notEqual(renameEquivalenceSignature(left, remap), renameEquivalenceSignature(changed));
});

test("source evidence, UI titles, timing and object insertion order do not affect equivalence", () => {
  const baseline = candidate();
  const enriched = { ...baseline, evaluatedInMs: baseline.evaluatedInMs + 100,
    targets: baseline.targets.map(target => ({ ...target, title: "A display name", origins: ["Different formatting"], implementation: { ready: false, problems: ["Source evidence only"] } })),
    edges: baseline.edges.map(edge => ({ ...edge, id: "different-order-id", detail: "Different source spelling", evidence: [] })),
    resources: baseline.resources.map(item => ({ ...item, typeText: "A source-only alias", memberSource: "class" as const })),
    tagging: Object.fromEntries(Object.entries(baseline.tagging ?? {}).reverse()),
  };
  assert.equal(renameEquivalenceSignature(enriched), renameEquivalenceSignature(baseline));
});
