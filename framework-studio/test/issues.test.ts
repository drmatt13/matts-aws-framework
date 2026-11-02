import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import assert from "./support/assert";
import { CDK_ENVIRONMENT_ID, type InputRequirement } from "../shared/deployment-inputs";
import type { ModeModel, ModelEdge, ModelResource, ModelTarget, Snapshot } from "../shared/model";
import { SnapshotBuilder } from "../server/snapshot";
import { aggregateConnections } from "../src/connections";
import { connectionIssues, presentConnectionHover } from "../src/connection-presentation";
import { catalogAvailability } from "../src/deployment";
import { ICONS } from "../src/icons";
import { requirementIssue, resourceIssues, targetIssues, type EntityIssue } from "../src/issues";
import { indexModel } from "../src/lookup";
import { buildScene, cornerBadges, type Scene } from "../src/scene/build";
import { connectionVisible } from "../src/scene/connections";
import { ICON_TINT, ISSUE_COLOR } from "../src/scene/look";
import { buildIconShape } from "../src/scene/shapes";

/**
 * One producer (`src/issues.ts`) says what is wrong with an entity, and every surface reads it:
 * the map's corner badge and caption, the hover card, the Resources row and the inspector notice.
 * These sweep every node of the real repository, and a copy of it broken in every way an issue can be.
 */

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");
const studio = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(studio, "..");
const applicationDom = new JSDOM("<!doctype html><html><body></body></html>");
let builder: SnapshotBuilder;
let snapshot: Snapshot;
let views: {
  HoverContent: typeof import("../src/views/ResourceHoverContent").HoverContent;
  ConnectionTooltipContent: typeof import("../src/views/ConnectionHoverContent").ConnectionTooltipContent;
  IssueNotice: typeof import("../src/views/IssueNotice").IssueNotice;
  IssueChips: typeof import("../src/views/ResourceStatus").IssueChips;
};

before(async () => {
  Object.defineProperty(globalThis, "document", { configurable: true, value: applicationDom.window.document });
  views = {
    ...(await import("../src/views/ResourceHoverContent")),
    ...(await import("../src/views/ConnectionHoverContent")),
    ...(await import("../src/views/IssueNotice")),
    ...(await import("../src/views/ResourceStatus")),
  };
  builder = new SnapshotBuilder(repositoryRoot);
  snapshot = (await builder.refresh()).snapshot;
});
after(async () => {
  await builder.dispose();
  applicationDom.window.close();
  Reflect.deleteProperty(globalThis, "document");
});

const documentOf = (element: Parameters<typeof renderToStaticMarkup>[0]): Document =>
  new JSDOM(renderToStaticMarkup(element)).window.document;

/** Every kind of issue at once: missing files, an unattached stack, broken and misconfigured workloads. */
function broken(model: ModeModel): ModeModel {
  const event = model.targets.find(target => target.role === "event");
  const warned = model.targets.find(target => target.ref !== event?.ref && target.kind === "lambda");
  const stack = model.resources.find(resource => resource.kind === "stack");
  return {
    ...model,
    resources: model.resources.map(resource => resource.deploymentFile
      ? { ...resource, deploymentFile: { ...resource.deploymentFile, exists: false } }
      : resource.id === stack?.id ? { ...resource, stackUsage: { status: "unreferenced" as const, sites: [] } } : resource),
    targets: model.targets.map(target => target.ref === event?.ref
      ? { ...target, implementation: { ready: false, problems: ["Configured handler index.ts is missing."] } } : target),
    diagnostics: [
      ...model.diagnostics,
      ...(event ? [{ severity: "error" as const, stage: "validate" as const, entity: event.ref, message: "Configured handler index.ts is missing." }] : []),
      ...(warned ? [{ severity: "warning" as const, stage: "validate" as const, entity: warned.ref, message: "Synthetic validation warning." }] : []),
    ],
  };
}

function scenes(models: Snapshot["models"]): readonly { readonly model: ModeModel; readonly scene: Scene }[] {
  const resourceAvailability = catalogAvailability(models);
  return (["dev", "prod"] as const).map(mode => ({ model: models[mode], scene: buildScene(models[mode], { resourceAvailability, layoutModels: Object.values(models) }) }));
}

test("every node's issues come from the one producer, and its icon corners follow one rule", () => {
  const painted = new Set<string>();
  for (const models of [snapshot.models, { dev: broken(snapshot.models.dev), prod: broken(snapshot.models.prod) }]) {
    for (const { model, scene } of scenes(models)) {
      const resources = new Map(model.resources.map(resource => [resource.id, resource]));
      const targets = new Map(model.targets.map(target => [target.ref, target]));
      for (const node of scene.nodes) {
        const resource = node.entity === "resource" ? resources.get(node.id) : undefined;
        const target = node.entity === "target" ? targets.get(node.id) : undefined;
        const expected = resource ? resourceIssues(resource, model.resources) : target ? targetIssues(target, model.diagnostics) : [];
        assert.deepEqual(node.issues ?? [], expected, `${model.mode}: ${node.id}`);
        const badges = cornerBadges(node);
        const issue = node.issues?.[0];
        if (issue) {
          painted.add(issue.badge);
          assert.equal(badges.right, issue.badge, `${model.mode}: ${node.id} wears its worst issue at the right corner`);
          assert.notEqual(badges.left, "managed", `${model.mode}: ${node.id}'s issue reads without an ownership lock`);
          if (node.roleIcon && node.roleIcon !== "managed") assert.equal(badges.left, node.roleIcon, `${model.mode}: ${node.id} keeps its role badge on the left`);
          assert.ok(node.issues!.every((item, at) => !at || item.severity === "warning" || node.issues![at - 1]!.severity === "error"), "errors first");
        } else {
          assert.equal(badges.right, node.roleIcon, `${model.mode}: ${node.id}`);
          assert.equal(badges.left, node.frameworkManaged && node.roleIcon !== "managed" ? "managed" : undefined, `${model.mode}: ${node.id}`);
        }
        assert.equal(node.geometry.hull.length, buildIconShape(0, 0, !!badges.right, !!badges.left).hull.length, `${model.mode}: ${node.id} is picked by exactly the corners it paints`);
      }
    }
  }
  assert.deepEqual([...painted].sort(), ["error", "unattached", "warning"], "the broken copy exercises every issue badge");
});

const file = (exists: boolean, problem?: string): ModelResource => ({
  id: "envfile:dev", path: ["cdk-app/.env.dev"], kind: "envFile", absent: false,
  deploymentFile: { mode: "dev", path: "cdk-app/.env.dev", template: "cdk-app/.env.dev.template", exists, entries: [], ...(problem ? { problem } : {}) },
});

test("a missing environment file shows one red cross and keeps its ownership for the card and inspector", () => {
  const issues = resourceIssues(file(false));
  assert.deepEqual(issues.map(issue => [issue.severity, issue.title, issue.badge]), [["error", ".env.dev is missing", "error"]]);
  assert.equal(issues[0]!.details[0]!, "Development synthesis reads cdk-app/.env.dev. Create it from cdk-app/.env.dev.template in CDK environment.");
  assert.deepEqual(cornerBadges({ roleIcon: "managed", frameworkManaged: true, issues }), { right: "error" });
  assert.deepEqual(cornerBadges({ roleIcon: "managed", frameworkManaged: true }), { right: "managed" }, "a healthy file keeps its lock");
  assert.deepEqual(resourceIssues(file(true, "EACCES: cdk-app/.env.dev")).map(issue => [issue.title, ...issue.details]), [[".env.dev could not be read", "EACCES: cdk-app/.env.dev"]]);
  assert.deepEqual(resourceIssues(file(true)), []);
});

test("the logical CDK environment reports setup errors only from the selected source mode", () => {
  const environment: ModelResource = { id: CDK_ENVIRONMENT_ID, path: ["CDK environment"], kind: "envFile", absent: false,
    deploymentFiles: { dev: "envfile:dev", prod: "envfile:prod" } };
  for (const mode of ["dev", "prod"] as const) {
    const files: ModelResource[] = (["dev", "prod"] as const).map(fileMode => ({
      id: `envfile:${fileMode}`, path: [`cdk-app/.env.${fileMode}`], kind: "envFile", absent: fileMode !== mode,
      deploymentFile: { mode: fileMode, path: `cdk-app/.env.${fileMode}`, template: `cdk-app/.env.${fileMode}.template`,
        exists: false, entries: [], setupProblem: `Could not initialize cdk-app/.env.${fileMode} (EACCES).` },
    }));
    const active = files.find(resource => !resource.absent)!;
    assert.deepEqual(resourceIssues(environment, [environment, ...files]), resourceIssues(active));
    assert.equal(resourceIssues(environment, files)[0]!.title, `.env.${mode} could not be created`);
    const healthyActive = files.map(resource => resource.absent ? resource : {
      ...resource, deploymentFile: { ...resource.deploymentFile!, exists: true, setupProblem: undefined },
    });
    assert.deepEqual(resourceIssues(environment, healthyActive), [], "the other file's setup error does not mark this source mode");
  }
});

test("undeclared assignments in either file mark the CDK environment as an error in both source modes", () => {
  const environment: ModelResource = { id: CDK_ENVIRONMENT_ID, path: ["CDK environment"], kind: "envFile", absent: false,
    deploymentFiles: { dev: "envfile:dev", prod: "envfile:prod" } };
  const dev = file(true);
  const prod: ModelResource = { ...file(true), id: "envfile:prod", absent: true,
    deploymentFile: { ...file(true).deploymentFile!, mode: "prod", path: "cdk-app/.env.prod", entries: [
      { name: "UNKNOWN_BLANK", status: "empty", counterpart: "missing", sensitive: false, defaulted: false, targets: [] },
      { name: "DECLARED", status: "configured", counterpart: "missing", sensitive: false, defaulted: false, targets: ["resource:declared"] },
      { name: "MIRRORED", status: "missing", counterpart: "configured", sensitive: false, defaulted: false, targets: [] },
    ] } };
  const expected = resourceIssues(prod);
  assert.equal(expected[0]!.severity, "error");
  assert.equal(expected[0]!.title, "UNKNOWN_BLANK is undeclared");
  assert.deepEqual(expected[0]!.details, ["Used in .env.prod. Create an input parameter or secret, or remove this variable in CDK environment."]);
  assert.deepEqual(resourceIssues(environment, [dev, prod]), expected, "an undeclared production line is visible from Development");
  assert.deepEqual(resourceIssues(environment, [{ ...dev, absent: true }, { ...prod, absent: false }]), expected);
  assert.deepEqual(cornerBadges({ roleIcon: "managed", frameworkManaged: true, issues: expected }), { right: "error" });
  const both = { ...dev, deploymentFile: { ...dev.deploymentFile!, entries: prod.deploymentFile!.entries } };
  const combined = resourceIssues(environment, [both, prod]);
  assert.equal(combined.length, 1, "one variable is one issue even when both files write it");
  assert.equal(combined[0]!.variable, "UNKNOWN_BLANK");
  assert.match(combined[0]!.details[0]!, /\.env.dev and \.env.prod/);
});

test("a group with a missing required value is an error, in names and files only", () => {
  const SECRET = "PRIVATE_REASON_MUST_NOT_SHOW";
  const entry = (name: string, kind: "input" | "secret", status: InputRequirement["status"], absent = false): ModelResource => ({
    id: `resource:client.${name}`, parent: "resource:client", path: ["client", name], kind, absent,
    inputRequirement: { resource: `resource:client.${name}`, name: name.toUpperCase(), mode: "dev", file: "cdk-app/.env.dev", required: status === "missing", status, reasons: [SECRET] },
  });
  const group: ModelResource = { id: "resource:client", path: ["client"], kind: "group", absent: false };
  const entries = [entry("apiPort", "input", "missing"), entry("wsPort", "input", "missing"), entry("token", "secret", "configured"), entry("prodOnly", "input", "missing", true)];
  const [issue] = resourceIssues(group, [group, ...entries]);
  assert.deepEqual([issue!.severity, issue!.title, issue!.badge, ...issue!.details], ["error", "Required values missing", "error",
    "2 inputs have no value: cdk-app/.env.dev leaves them unset and no default stands in.", "Set them in cdk-app/.env.dev, or give them defaults."], "an entry absent from this graph is not counted; the file and a default are both named as remedies");
  assert.ok(!JSON.stringify(issue).includes(SECRET), "private reasons never reach previews");
  assert.deepEqual(cornerBadges({ issues: [issue!] }), { right: "error" });
  assert.deepEqual(resourceIssues(group), [], "without the catalog a group has nothing to read");
  const [own] = resourceIssues(entries[0]!);
  assert.deepEqual(own!.details, ["APIPORT has no value for Development: cdk-app/.env.dev leaves it unset and no default stands in.", "Set it in cdk-app/.env.dev, or give the parameter a default."]);
  const secret = entry("apiKey", "secret", "missing");
  assert.deepEqual(resourceIssues(secret)[0]!.details, ["APIKEY has no value for Development: cdk-app/.env.dev leaves it unset.", "Set it in cdk-app/.env.dev; a secret never takes a source default."], "a secret is never offered a default");
  const mixed = resourceIssues(group, [group, entries[0]!, secret])[0]!;
  assert.deepEqual(mixed.details, ["1 input and 1 secret have no value: cdk-app/.env.dev leaves them unset and no default stands in.", "Set them in cdk-app/.env.dev, or give the inputs defaults."]);
  assert.deepEqual(resourceIssues(entries[2]!), []);
  assert.deepEqual(resourceIssues(entries[3]!), [], "absent in this graph, so nothing is missing here");
});

test("warnings and workload errors take the right corner and move a role badge left", () => {
  const stack: ModelResource = { id: "framework-stack:Detached", path: ["Detached"], kind: "stack", absent: false, frameworkStack: true, stackUsage: { status: "unreferenced", sites: [] } };
  const [unattached] = resourceIssues(stack);
  assert.deepEqual([unattached!.severity, unattached!.title, unattached!.badge], ["warning", "Not added to CDK app", "unattached"]);
  assert.deepEqual(cornerBadges({ roleIcon: "managed", frameworkManaged: true, issues: [unattached!] }), { right: "unattached" });
  const target = { ref: "lambda:events", implementation: { ready: false, problems: ["Configured handler index.ts is missing."] } } as unknown as ModelTarget;
  const issues = targetIssues(target, [
    { severity: "error", stage: "validate", entity: target.ref, message: "Configured handler index.ts is missing." },
    { severity: "warning", stage: "validate", entity: target.ref, message: "Retries exceed the queue's visibility timeout." },
    { severity: "error", stage: "validate", entity: "lambda:other", message: "Not this workload." },
  ]);
  assert.deepEqual(issues.map(issue => [issue.severity, issue.title, issue.details]), [
    ["error", "Implementation needs attention", ["Configured handler index.ts is missing."]],
    ["warning", "Configuration warning", ["Retries exceed the queue's visibility timeout."]],
  ], "a validation message that repeats a missing artifact is said once");
  assert.deepEqual(cornerBadges({ roleIcon: "event", issues }), { right: "error", left: "event" });
});

const caller = { ref: "lambda:consumer", kind: "lambda", role: "http", id: "consumer", title: "consumer", lanes: { deploy: "both", origin: "declared", local: true, cloud: true, dev: true, prod: true } } as unknown as ModelTarget;
const requirement = (name: string, status: InputRequirement["status"]): InputRequirement => ({
  resource: `resource:settings.${name}`, name: name.toUpperCase(), mode: "dev", file: "cdk-app/.env.dev", required: true, status, reasons: ["Read by consumer at startup."],
});
function bundle(statuses: readonly InputRequirement["status"][]) {
  const names = statuses.map((_, at) => `value${at}`);
  const resources: ModelResource[] = [{ id: "resource:settings", path: ["settings"], kind: "group", absent: false },
    ...names.map(name => ({ id: `resource:settings.${name}`, parent: "resource:settings", path: ["settings", name], kind: "input" as const, absent: false }))];
  const edges: ModelEdge[] = names.map((name, at) => ({ id: `env:${name}`, relation: "env", from: caller.ref, to: `resource:settings.${name}`, label: name.toUpperCase(), provenance: "declared", inputRequirement: requirement(name, statuses[at]!) }));
  const model: ModeModel = { mode: "dev", status: "ok", targets: [caller], routes: [], resources, edges, workflows: [], fields: {}, diagnostics: [], evaluatedInMs: 0 };
  const other: ModeModel = { ...model, mode: "prod", edges: [] };
  const connection = aggregateConnections(model, [other])[0]!;
  return { connection, index: indexModel(model), hover: presentConnectionHover(connection, { dev: indexModel(model), prod: indexModel(other) }) };
}

test("a connection's inspector notice uses the hover card's own sentence", () => {
  const all = bundle(["missing", "missing", "missing"]);
  const [issue] = connectionIssues(all.connection, "dev", all.index);
  const hoverError = all.hover.details.find(detail => detail.tone === "error");
  assert.equal(issue!.title, "Required values missing");
  assert.equal(issue!.details[0], hoverError?.text);
  assert.equal(issue!.details[0], "Every environment value is missing its required value.");
  assert.equal(issue!.details[1], "Set non-blank values in cdk-app/.env.dev, or define defaults on the parameters.");
  const some = bundle(["missing", "configured", "missing"]);
  assert.deepEqual(connectionIssues(some.connection, "dev", some.index)[0]!.details[0], "VALUE0 and VALUE2 are missing their required values.");
  assert.deepEqual(connectionIssues(bundle(["configured", "default"]).connection, "dev", bundle(["configured", "default"]).index), []);
  const single = bundle(["missing"]);
  assert.deepEqual(connectionIssues(single.connection, "dev", single.index), [requirementIssue(requirement("value0", "missing"))]);
  assert.equal(requirementIssue(requirement("value0", "default")), undefined);
  assert.equal(requirementIssue({ ...requirement("value0", "missing"), required: false }), undefined);
});

test("the Errors filter keeps a missing-input wire visible whatever its category filter says", () => {
  const { connection } = bundle(["missing", "configured"]);
  assert.deepEqual(connection.categories, ["inputs"]);
  assert.equal(connectionVisible(connection, new Set()), false, "its category is off");
  assert.equal(connectionVisible(connection, new Set(), undefined, true), true, "the Errors filter pins it");
  const healthy = bundle(["configured", "default"]).connection;
  assert.equal(connectionVisible(healthy, new Set(), undefined, true), false, "a healthy wire still follows its category");
});

test("cards and inspectors show an issue's same words, and problems lead what they describe", () => {
  const issues: readonly EntityIssue[] = resourceIssues(file(false));
  const text = (root: ParentNode, selector: string) => [...root.querySelectorAll(selector)].map(element => element.textContent);
  const card = documentOf(createElement(views.HoverContent, { title: "cdk-app/.env.dev", lines: [], issues, description: "Development CDK input file editor." })).body;
  const inspector = documentOf(createElement(views.IssueNotice, { issues })).body;
  assert.deepEqual(text(card, "[data-ui~=\"landscape-hover-issue\"] > *"), text(inspector, "[data-issue] > *"));
  assert.equal(inspector.querySelector("[data-issue=\"error\"]")?.getAttribute("role"), "alert");
  const chips = documentOf(createElement(views.IssueChips, { issues, placement: "inline" })).body;
  assert.deepEqual(text(chips, "[data-resource-status]"), [issues[0]!.title], "island lists use the same title as a chip");
  const order = [...card.querySelectorAll("[data-ui]")].map(element => element.getAttribute("data-ui"));
  assert.ok(order.indexOf("landscape-hover-issues") < order.indexOf("landscape-hover-description"), "the issue reads before the description");
  const { hover } = bundle(Array.from({ length: 12 }, () => "missing" as const));
  const tooltip = documentOf(createElement(views.ConnectionTooltipContent, { content: hover })).body;
  const shared = tooltip.querySelector("[data-ui~=\"landscape-hover-detail\"]");
  assert.equal(shared?.textContent, "Every environment value is missing its required value.");
  assert.ok(shared!.compareDocumentPosition(tooltip.querySelector("ul[aria-label=\"Connection members\"]")!) & applicationDom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    "a shared error is above a long member list, not below it");
});

test("issue colours are one palette across canvas, theme tokens and badge artwork", () => {
  const theme = readFileSync(path.join(studio, "src/styles/theme.css"), "utf8");
  assert.ok(theme.includes(`--color-map-error: ${ISSUE_COLOR.error};`));
  assert.ok(theme.includes(`--color-map-warning: ${ISSUE_COLOR.warning};`));
  assert.equal(ICON_TINT.error, ISSUE_COLOR.error);
  assert.equal(ICON_TINT.warning, ISSUE_COLOR.warning);
  assert.equal(ICON_TINT.unattached, ISSUE_COLOR.warning);
  const stroke = (key: keyof typeof ICONS) => readFileSync(path.join(studio, "public/icons", `${ICONS[key][0]}.svg`), "utf8").match(/stroke="(#[0-9a-f]{6})"/i)?.[1];
  assert.equal(stroke("error"), ISSUE_COLOR.error);
  assert.equal(stroke("warning"), ISSUE_COLOR.warning);
  assert.equal(stroke("unattached"), ISSUE_COLOR.warning);
});
