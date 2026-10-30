import assert from "./support/assert";
import { test } from "node:test";
import type { Mode, ModeModel, ModelEdge, ModelResource, Snapshot } from "../shared/model";
import { namingEntityRemap } from "../server/naming-continuity";
import { aggregateConnections } from "../src/connections";
import { NamingHistory } from "../src/naming";

const resource = (id: string, parent?: string, kind: ModelResource["kind"] = "input"): ModelResource => ({ id, path: id.slice("resource:".length).split("."), kind, absent: false, ...(parent ? { parent } : {}) });
const edge = (id: string, to: string, label = "FEATURE", extra: Partial<ModelEdge> = {}): ModelEdge => ({ id, from: "lambda:consumer", to, relation: "env", label, provenance: "declared", ...extra });
function snapshot(resources: readonly ModelResource[], edges: readonly ModelEdge[], prodEdges = edges): Snapshot {
  const model = (mode: Mode): ModeModel => ({ mode, status: "ok", resources, edges: mode === "dev" ? edges : prodEdges, targets: [], routes: [], workflows: [], fields: {}, diagnostics: [], evaluatedInMs: 0 });
  return { models: { dev: model("dev"), prod: model("prod") } } as Snapshot;
}
const group = (state: Snapshot) => aggregateConnections(state.models.dev, Object.values(state.models))[0]!;

test("confirmed resource rename maps raw relationships by semantics despite changed source offsets and ordinals", () => {
  const from = "resource:flag", to = "resource:enabled";
  const previous = edge(`env:lambda:consumer->${from}#0`, from);
  const current = edge(`env:lambda:consumer->${to}#3`, to);
  const location = (start: number) => ({ file: "cdk-app/lib/consumer.ts", line: 9, column: 3, start, end: start + 5 });
  const sourceBefore = edge(`grant:lambda:consumer->${from}#consumer.ts:40:read`, from, "read", { relation: "grant", provenance: "source", source: location(40), attachment: from });
  const sourceAfter = edge(`grant:lambda:consumer->${to}#consumer.ts:55:read`, to, "read", { relation: "grant", provenance: "source", source: location(55), attachment: to });
  const before = snapshot([resource(from)], [previous, sourceBefore]);
  const after = snapshot([resource(to)], [current, sourceAfter]);
  const remap = namingEntityRemap(before, after, { [from]: to });
  assert.equal(remap[from], to);
  assert.equal(remap[previous.id], current.id);
  assert.equal(remap[sourceBefore.id], sourceAfter.id);
  const history = new NamingHistory();
  history.selection("historical-edge", previous.id);
  history.accept(remap);
  assert.equal(history.selection("historical-edge", previous.id), current.id);
  assert.equal(history.selection("fresh-entry", previous.id), previous.id);
});

test("group rename maps encoded aggregate IDs and all member edges across the two-mode union", () => {
  const from = "resource:settings", to = "resource:features";
  const beforeResources = [resource(from, undefined, "group"), resource(`${from}.one`, from), resource(`${from}.two`, from)];
  const afterResources = [resource(to, undefined, "group"), resource(`${to}.one`, to), resource(`${to}.two`, to)];
  const one = edge(`env:consumer->${from}.one#0`, `${from}.one`, "ONE");
  const two = edge(`env:consumer->${from}.two#0`, `${from}.two`, "TWO");
  const nextOne = edge(`env:consumer->${to}.one#0`, `${to}.one`, "ONE");
  const nextTwo = edge(`env:consumer->${to}.two#0`, `${to}.two`, "TWO");
  const before = snapshot(beforeResources, [one], [two]);
  const after = snapshot(afterResources, [nextOne], [nextTwo]);
  const oldGroup = group(before), newGroup = group(after);
  assert.equal(oldGroup.members.length, 2);
  assert.match(oldGroup.id, /resource%3Asettings/);
  const remap = namingEntityRemap(before, after, { [from]: to });
  assert.equal(remap[oldGroup.id], newGroup.id);
  assert.equal(remap[one.id], nextOne.id);
  assert.equal(remap[two.id], nextTwo.id);
  const history = new NamingHistory();
  history.selection("bundle-visit", oldGroup.id);
  history.accept(remap);
  assert.equal(history.selection("bundle-visit", oldGroup.id), newGroup.id);
});

test("a surviving relationship carries selection through singleton and bundle transitions", () => {
  const from = "resource:settings", to = "resource:features";
  const beforeResources = [resource(from, undefined, "group"), resource(`${from}.one`, from), resource(`${from}.two`, from)];
  const afterResources = [resource(to, undefined, "group"), resource(`${to}.one`, to), resource(`${to}.two`, to)];
  const one = edge("old-one", `${from}.one`, "ONE"), two = edge("old-two", `${from}.two`, "TWO");
  const nextOne = edge("new-one", `${to}.one`, "ONE"), nextTwo = edge("new-two", `${to}.two`, "TWO");
  const singleton = snapshot(beforeResources, [one]);
  const bundle = snapshot(afterResources, [nextOne, nextTwo]);
  assert.equal(namingEntityRemap(singleton, bundle, { [from]: to })[one.id], group(bundle).id);
  const previousBundle = snapshot(beforeResources, [one, two]);
  const nextSingleton = snapshot(afterResources, [nextOne]);
  assert.equal(namingEntityRemap(previousBundle, nextSingleton, { [from]: to })[group(previousBundle).id], nextOne.id);
});

test("ambiguous or semantically different wiring is never assigned an arbitrary new edge", () => {
  const from = "resource:flag", to = "resource:enabled";
  const previous = edge("old", from);
  const before = snapshot([resource(from)], [previous]);
  const after = snapshot([resource(to)], [edge("new-one", to), edge("new-two", to)]);
  assert.equal(namingEntityRemap(before, after, { [from]: to })[previous.id], undefined);
  const changed = snapshot([resource(to)], [edge("changed", to, "ANOTHER_VARIABLE")]);
  assert.equal(namingEntityRemap(before, changed, { [from]: to })[previous.id], undefined);
  const duplicateBefore = snapshot([resource(from)], [previous, edge("old-duplicate", from)]);
  assert.equal(namingEntityRemap(duplicateBefore, snapshot([resource(to)], [edge("single-new", to)]), { [from]: to })[previous.id], undefined);
});

test("parallel scoped grants retain their own semantics when ordinals change", () => {
  const from = "resource:bucket", to = "resource:uploads";
  const grant = (id: string, resource: string, scope: string) => edge(id, resource, "Read objects", { relation: "grant", permissionContext: { kind: "native", method: "grantRead", arguments: [scope] } });
  const before = snapshot([resource(from)], [grant("old-a", from, "a/*"), grant("old-b", from, "b/*")]);
  const after = snapshot([resource(to)], [grant("new-b", to, "b/*"), grant("new-a", to, "a/*")]);
  const remap = namingEntityRemap(before, after, { [from]: to });
  assert.equal(remap["old-a"], "new-a");
  assert.equal(remap["old-b"], "new-b");
});
