import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, afterEach, before, test } from "node:test";
import { createElement as h, type ReactNode } from "react";
import type { DeployOverview, DiscoveryView, DiscoveredDeploymentView, PlanSummaryView, PlanView, TeardownPlanView } from "../shared/deploy";
import { STUDIO_PROTOCOL_VERSION } from "../shared/protocol";
import { DEFAULT_FRONTEND_RELEASE } from "../shared/frontend-release";

/**
 * The Deploy & Run page in a DOM, against scripted /api/deploy answers: what it
 * offers for each state, and the exact operation each click asks the server for.
 */

let dom: { window: Window & typeof globalThis };
let ui: typeof import("@testing-library/react");
let query: typeof import("@tanstack/react-query");
let page: typeof import("../src/views/Deploy");
let dialogs: typeof import("../src/views/deploy/Teardown");
const clients: import("@tanstack/react-query").QueryClient[] = [];
let answers: Record<string, unknown>;
let posted: { path: string; body: any }[];
const requested: string[] = [];
const sources: { listeners: Map<string, ((event: { data: string }) => void)[]> }[] = [];
function emit(name: string, data: unknown) {
  for (const source of sources) for (const listener of source.listeners.get(name) ?? []) listener({ data: JSON.stringify(data) });
}

const context = { profile: "dev", account: "734849394764", region: "us-east-1", arn: "arn:aws:sts::734849394764:assumed-role/Dev/matthew" };
const stack = (name: string, deployment: string, mode: "dev" | "prod") => ({ name, status: "UPDATE_COMPLETE", health: "complete" as const, evidence: "tags" as const, identity: { deployment, mode, contract: 2 as const } });

function deployed(name: string, mode: "dev" | "prod"): DiscoveredDeploymentView {
  const stacks = [stack(`${name}-CognitoStack`, name, mode)];
  return { name, mode, account: context.account, region: context.region, contracts: [2], state: { kind: "ready", stacks }, stacks };
}

function overview(patch: Partial<DeployOverview> = {}): DeployOverview {
  return {
    targets: [{ name: "my-aws-app", mode: "dev", origin: "personal", inputs: "cdk-app/.env.dev" }, { name: "my-aws-app-prod", mode: "prod", origin: "declared", account: context.account, region: context.region }],
    prerequisites: [{ id: "docker", label: "Docker", status: "ok", summary: "Engine running." }],
    local: { project: "matts-aws-framework-new", docker: { engine: "running", desktop: true }, services: [], watch: { running: false }, client: { running: false }, exported: { client: false }, startedBy: "none", restartNeeded: [] },
    jobs: [], preferences: { profiles: {}, profile: "dev", deployment: "my-aws-app" },
    profiles: [{ name: "dev", region: "us-east-1", kind: "sso" }],
    ...patch,
  };
}

function discovery(deployments: DiscoveredDeploymentView[] = []): DiscoveryView {
  return {
    context, deployments, unrecognized: [], records: {}, unreadable: [], observedAt: "2026-10-17T12:00:00Z",
    targets: ["my-aws-app", "my-aws-app-prod"].map((name) => ({ name, mode: name.endsWith("prod") ? "prod" as const : "dev" as const, origin: "declared" as const, status: deployments.some((entry) => entry.name === name) ? "deployed" as const : "absent" as const })),
  };
}

const job = (kind: string, params: Record<string, unknown>) => ({ id: `job-${posted.length}`, kind, title: kind, params, status: "running", startedAt: "2026-10-17T12:00:00Z", lastSeq: 0 });

before(async () => {
  const require = createRequire(import.meta.url);
  // The page imports its stylesheet; Node has nothing to do with it.
  (require as unknown as { extensions: Record<string, unknown> }).extensions[".css"] = () => {};
  const { JSDOM } = require("jsdom");
  dom = new JSDOM(`<!doctype html><html><head><meta name="studio-token" content="t"><meta name="studio-protocol" content="${STUDIO_PROTOCOL_VERSION}"></head><body></body></html>`, { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of ["window", "self", "document", "navigator", "HTMLElement", "Node", "MutationObserver", "getComputedStyle"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  // The studio's event stream, which a test can speak through: emit(event, data).
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: class {
    readonly listeners = new Map<string, ((event: { data: string }) => void)[]>();
    constructor() { sources.push(this); }
    addEventListener(name: string, listener: (event: { data: string }) => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
    removeEventListener(name: string, listener: (event: { data: string }) => void) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter(candidate => candidate !== listener)); }
    close() { sources.splice(sources.indexOf(this), 1); }
  } });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string, init?: { method?: string; body?: string }) => {
      const url = new URL(input, "http://localhost");
      const path = url.pathname.replace(/^\/api/, "");
      requested.push(`${path}${url.search}`);
      if (init?.method === "POST") {
        const body = init.body ? JSON.parse(init.body) : {};
        posted.push({ path, body });
        const reply = path === "/deploy/operations" ? job(body.kind, body.params) : path === "/deploy/preferences" ? { profiles: {}, ...body } : {};
        return new Response(JSON.stringify(reply), { status: 200 });
      }
      const key = Object.keys(answers).find((candidate) => path === candidate || path.startsWith(`${candidate}?`)) ?? path;
      const answer = typeof answers[key] === "function" ? await answers[key](url) : answers[key];
      return answer instanceof Response ? answer : key in answers ? new Response(JSON.stringify(answer), { status: 200 }) : new Response(JSON.stringify({ error: `unscripted ${path}` }), { status: 404 });
    },
  });
  ui = require("@testing-library/react");
  query = require("@tanstack/react-query");
  page = await import("../src/views/Deploy");
  dialogs = await import("../src/views/deploy/Teardown");
});
after(() => dom.window.close());
afterEach(() => { ui.cleanup(); clients.splice(0).forEach((client) => client.clear()); });

function render(scripted: Record<string, unknown>, content?: ReactNode) {
  posted = [];
  answers = { "/deploy/plans": [], "/deploy/drift": null,
    "/frontend-release/settings": { settings: DEFAULT_FRONTEND_RELEASE, hash: "settings-review-hash" },
    "/frontend-release/history": [],
    "/frontend-release/identities": { hash: "target-review-hash", authority: "Names are source-owned deployment selections.", targets: overview().targets },
    ...scripted };
  if (Array.isArray(answers["/deploy/plans"])) answers["/deploy/plans"] = (answers["/deploy/plans"] as PlanSummaryView[]).map((plan) => ({ account: context.account, region: context.region, ...plan }));
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  return ui.render(h(query.QueryClientProvider, { client }, content ?? h(page.Deploy)));
}

const operations = () => posted.filter((entry) => entry.path === "/deploy/operations").map((entry) => entry.body);

test("unapplied frontend settings block env generation and builds with a source-review explanation", async () => {
  render({ "/deploy/overview": overview(), "/deploy/discover": { ok: true, value: discovery() }, "/deploy/status": { ok: true, value: { ...discovery(), deployment: "my-aws-app" } } });
  ui.fireEvent.click(await ui.screen.findByText("Client environment & frontend release", { exact: true }));
  ui.fireEvent.click(await ui.screen.findByText("Frontend project and publication settings", { exact: true }));
  const build = () => ui.screen.getByRole("button", { name: "Build & review release" }) as HTMLButtonElement;
  const generate = () => ui.screen.getByRole("button", { name: "Generate / refresh client env" }) as HTMLButtonElement;
  // Destination resolution deliberately remounts this panel to clear old approvals.
  await ui.waitFor(() => assert.equal(build().disabled, false));
  ui.fireEvent.change(ui.screen.getByLabelText("Bucket prefix (blank or ending in /)"), { target: { value: "unapplied/" } });
  assert.equal(build().disabled, true); assert.equal(generate().disabled, true);
  assert.ok(ui.screen.getByText(/settings have unapplied changes/));
  assert.equal(posted.length, 0, "changing a field neither saves source nor starts a release");
});

test("passed machine checks are available on demand while issues and their remedies stay visible", async () => {
  render({
    "/deploy/overview": overview({ prerequisites: [
      { id: "node", label: "Node.js", status: "ok", summary: "Node 24.1.0" },
      { id: "npm", label: "npm", status: "ok", summary: "npm 11.4.0" },
      { id: "docker", label: "Docker", status: "warn", summary: "Docker Desktop is not running.", remedy: { kind: "docker-start", params: {} } },
    ] }),
    "/deploy/discover": { ok: true, value: discovery() }, "/deploy/status": { ok: true, value: { ...discovery(), deployment: "my-aws-app" } },
  });
  const checks = await ui.screen.findByRole("button", { name: "This machine · 2 checks passed" });
  assert.equal(checks.getAttribute("aria-expanded"), "false");
  assert.equal(ui.screen.queryByRole("list", { name: "Passed machine checks" }), null);
  const issues = ui.screen.getByRole("list", { name: "Machine issues" });
  assert.ok(ui.within(issues).getByText("Docker Desktop is not running."));
  ui.fireEvent.click(checks);
  assert.equal(checks.getAttribute("aria-expanded"), "true");
  const ready = ui.screen.getByRole("list", { name: "Passed machine checks" });
  assert.ok(ui.within(ready).getByText("Node 24.1.0"));
  assert.ok(ui.within(ready).getByText("npm 11.4.0"));
  ui.fireEvent.click(checks);
  assert.equal(ui.screen.queryByRole("list", { name: "Passed machine checks" }), null);
  assert.equal(operations().length, 0, "reading tool checks starts no operation");
  ui.fireEvent.click(ui.within(issues).getByRole("button", { name: "Start" }));
  await ui.waitFor(() => assert.deepEqual(operations()[0], { kind: "docker-start", params: {} }));
});

test("the empty profile state can refresh and discover a newly configured profile", async () => {
  render({
    "/deploy/overview": overview({ targets: [], profiles: [], preferences: { profiles: {} } }),
    "/deploy/discover": { ok: true, value: discovery() }, "/deploy/status": { ok: true, value: { ...discovery(), deployment: "my-aws-app" } },
  });
  await ui.screen.findByRole("heading", { name: "No AWS profiles on this machine" });
  const refresh = ui.screen.getByRole("button", { name: "Refresh" });
  assert.equal((refresh as HTMLButtonElement).disabled, false);
  answers["/deploy/overview"] = overview();
  ui.fireEvent.click(refresh);
  await ui.screen.findByRole("heading", { name: /my-aws-app Dev/ });
  assert.equal((ui.screen.getByLabelText("AWS profile") as HTMLSelectElement).value, "dev");
  assert.equal(operations().length, 0);
});

test("a failed refresh keeps deployment evidence visible, reports the error and supports retry", async () => {
  render({ "/deploy/overview": overview(), "/deploy/discover": { ok: true, value: discovery() }, "/deploy/status": { ok: true, value: { ...discovery(), deployment: "my-aws-app" } } });
  await ui.screen.findByRole("heading", { name: /my-aws-app Dev/ });
  const refresh = ui.screen.getByRole("button", { name: "Refresh" });
  await ui.waitFor(() => assert.equal((refresh as HTMLButtonElement).disabled, false));
  let finish!: (response: Response) => void;
  answers["/deploy/overview"] = () => new Promise<Response>((resolve) => { finish = resolve; });
  ui.fireEvent.click(refresh);
  await ui.waitFor(() => assert.equal(refresh.getAttribute("aria-busy"), "true"));
  assert.equal((refresh as HTMLButtonElement).disabled, true);
  finish(new Response(JSON.stringify({ error: "Machine probes timed out." }), { status: 503 }));
  const error = await ui.screen.findByRole("alert");
  assert.match(error.textContent ?? "", /Machine probes timed out/);
  assert.ok(ui.screen.getByRole("heading", { name: /my-aws-app Dev/ }), "last successful overview remains visible");
  await ui.waitFor(() => assert.equal((refresh as HTMLButtonElement).disabled, false));
  answers["/deploy/overview"] = overview();
  ui.fireEvent.click(refresh);
  await ui.waitFor(() => assert.equal(Boolean(ui.screen.queryByRole("alert")), false));
  assert.equal(operations().length, 0);
});

test("an absent development deployment prepares a review without automatic application", async () => {
  render({ "/deploy/overview": overview(), "/deploy/discover": { ok: true, value: discovery() }, "/deploy/status": { ok: true, value: { ...discovery(), deployment: "my-aws-app" } } });
  const primary = await ui.screen.findByRole("button", { name: "Compare AWS templates" }, { timeout: 3000 });
  assert.ok(await ui.screen.findByText("Not deployed here"));
  ui.fireEvent.click(primary);
  await ui.waitFor(() => assert.equal(operations().length, 1));
  assert.deepEqual(operations()[0], { kind: "deploy-plan", params: { deployment: "my-aws-app", profile: "dev", review: "template" } });
});

test("an expired session offers Sign in, which signs in that profile", async () => {
  const expired = { ok: false, problem: { kind: "expired", message: "The selected profile's session has expired." } };
  render({ "/deploy/overview": overview(), "/deploy/discover": expired, "/deploy/status": expired });
  const buttons = await ui.screen.findAllByRole("button", { name: /Sign in/ }, { timeout: 3000 });
  ui.fireEvent.click(buttons[0]!);
  await ui.waitFor(() => assert.deepEqual(operations()[0], { kind: "aws-login", params: { profile: "dev" } }));
});

test("a production plan is applied only with its name typed", async () => {
  const waiting: PlanSummaryView = { key: "my-aws-app-prod-abc123", deployment: "my-aws-app-prod", mode: "prod", status: "ready", createdAt: "2026-10-17T12:00:00Z", expired: false };
  const plan: PlanView = {
    key: waiting.key, planId: "plan-abc-123456", createdAt: waiting.createdAt, expiresAt: "2099-01-01T00:00:00Z", expired: false, status: "ready", review: "change-set", profile: "dev",
    identity: { deployment: "my-aws-app-prod", mode: "prod", account: context.account, region: context.region }, guard: "absent",
    stacks: [{ name: "my-aws-app-prod-CognitoStack", fingerprint: { exists: false }, changes: [{ logicalId: "Pool", type: "AWS::Cognito::UserPool", action: "add", replacement: "False", stateful: true }], exportsInUse: [], noChanges: false }],
    secrets: [{ name: "my-aws-app-prod/secret/OPENAI_API_KEY", variable: "OPENAI_API_KEY", action: "unchanged" }], dockerImages: [], iamBroadening: false,
    confirmation: { level: "name", reasons: ["the first deployment of this target"] }, uncertainties: ["Runtime effects of custom resources are not predicted."],
  };
  render({
    "/deploy/overview": overview({ preferences: { profiles: {}, profile: "dev", deployment: "my-aws-app-prod" } }),
    "/deploy/discover": { ok: true, value: discovery() }, "/deploy/status": { ok: true, value: { ...discovery(), deployment: "my-aws-app-prod" } },
    "/deploy/plans": [waiting], [`/deploy/plans/${waiting.key}`]: plan,
  });
  ui.fireEvent.click(await ui.screen.findByRole("button", { name: "Review plan" }, { timeout: 3000 }));
  const apply = await ui.screen.findByRole("button", { name: `Apply to ${context.account}` });
  assert.equal((apply as HTMLButtonElement).disabled, true, "no name, no apply");
  assert.ok(ui.screen.getByText(/OPENAI_API_KEY/), "secrets are listed by name");
  const disclosure = ui.screen.getByRole("button", { name: /CognitoStack/ });
  assert.equal(disclosure.getAttribute("aria-expanded"), "false");
  ui.fireEvent.click(disclosure);
  assert.equal(disclosure.getAttribute("aria-expanded"), "true");
  const changes = ui.screen.getByRole("table", { name: "Resource changes in CognitoStack" });
  assert.deepEqual(ui.within(changes).getAllByRole("columnheader").map((cell) => cell.textContent), ["Action", "Resource", "Type", "Impact"]);
  ui.fireEvent.change(ui.screen.getByLabelText("Type my-aws-app-prod to apply"), { target: { value: "my-aws-app" } });
  assert.equal((apply as HTMLButtonElement).disabled, true, "a different name does not count");
  ui.fireEvent.change(ui.screen.getByLabelText("Type my-aws-app-prod to apply"), { target: { value: "my-aws-app-prod" } });
  assert.equal((apply as HTMLButtonElement).disabled, false);
  ui.fireEvent.click(apply);
  await ui.waitFor(() => assert.deepEqual(operations()[0], { kind: "deploy-apply", params: { plan: waiting.key, profile: "dev", confirm: "my-aws-app-prod" } }));
});

test("deleting shows what AWS holds and what stays, and needs the typed name", async () => {
  const teardown: TeardownPlanView = {
    key: "delete-review-abc123", expiresAt: "2099-01-01T00:00:00Z", digest: "reviewed", blockers: [],
    deployment: "my-aws-app", mode: "dev", account: context.account, region: context.region,
    stacks: [{ name: "my-aws-app-CognitoStack", status: "UPDATE_COMPLETE", terminationProtection: false, importedBy: [] }],
    leftInPlace: [], remains: [{ stack: "my-aws-app-CognitoStack", logicalId: "Pool", type: "AWS::Cognito::UserPool", policy: "Retain" }], secrets: [], record: true,
  };
  render({
    "/deploy/overview": overview(), "/deploy/discover": { ok: true, value: discovery([deployed("my-aws-app", "dev")]) },
    "/deploy/status": { ok: true, value: { ...discovery([deployed("my-aws-app", "dev")]), deployment: "my-aws-app", detail: { ...deployed("my-aws-app", "dev"), events: [], changeSets: [], local: { compatible: true, exported: { client: false, fresh: false } } } } },
    "/deploy/teardown": { ok: true, value: teardown },
  });
  ui.fireEvent.click(await ui.screen.findByRole("menuitem", { name: "Delete deployment…" }, { timeout: 3000 }));
  assert.ok(await ui.screen.findByText("Kept after deletion"));
  assert.ok(ui.screen.getByText("Pool"));
  const remove = ui.screen.getByRole("button", { name: "Delete my-aws-app" });
  assert.equal((remove as HTMLButtonElement).disabled, true);
  ui.fireEvent.change(ui.screen.getByLabelText("Type my-aws-app to delete it"), { target: { value: "my-aws-app" } });
  ui.fireEvent.click(remove);
  await ui.waitFor(() => assert.deepEqual(operations()[0], { kind: "destroy", params: { deployment: "my-aws-app", mode: "dev", profile: "dev", confirm: "my-aws-app", review: "delete-review-abc123" } }));
});

test("a plan job finishing while another plan is under review does not replace it", async () => {
  const plan = (key: string, stackName: string): PlanView => ({
    key, planId: `plan-${key}`, createdAt: "2026-10-17T12:00:00Z", expiresAt: "2099-01-01T00:00:00Z", expired: false, status: "ready", review: "change-set", profile: "dev",
    identity: { deployment: "my-aws-app-prod", mode: "prod", account: context.account, region: context.region }, guard: "ready",
    stacks: [{ name: `my-aws-app-prod-${stackName}`, fingerprint: { exists: true }, changes: [{ logicalId: "Thing", type: "AWS::SQS::Queue", action: "modify", replacement: "False", stateful: false }], exportsInUse: [], noChanges: false }],
    secrets: [], dockerImages: [], iamBroadening: false, confirmation: { level: "click", reasons: [] }, uncertainties: [],
  });
  const reviewed: PlanSummaryView = { key: "my-aws-app-prod-yyyyyy", deployment: "my-aws-app-prod", mode: "prod", status: "ready", createdAt: "2026-10-17T12:00:00Z", expired: false };
  render({
    "/deploy/overview": overview({ preferences: { profiles: {}, profile: "dev", deployment: "my-aws-app-prod" } }),
    "/deploy/discover": { ok: true, value: discovery([deployed("my-aws-app-prod", "prod")]) },
    "/deploy/status": { ok: true, value: { ...discovery([deployed("my-aws-app-prod", "prod")]), deployment: "my-aws-app-prod" } },
    "/deploy/plans": [reviewed],
    [`/deploy/plans/${reviewed.key}`]: plan(reviewed.key, "CognitoStack"),
    "/deploy/plans/my-aws-app-prod-xxxxxx": plan("my-aws-app-prod-xxxxxx", "RdsStack"),
  });
  // A second plan is started from this page; then the waiting one is opened for review.
  const planItem = await ui.screen.findByRole("menuitem", { name: "Compare AWS templates (read-only)…" }, { timeout: 3000 });
  await ui.waitFor(() => assert.equal((planItem as HTMLButtonElement).disabled, false), { timeout: 3000 });
  ui.fireEvent.click(planItem);
  await ui.waitFor(() => assert.equal(operations().length, 1));
  const started = `job-${posted.findIndex((entry) => entry.path === "/deploy/operations") + 1}`;
  ui.fireEvent.click(await ui.screen.findByRole("button", { name: "Review plan" }));
  const review = () => ui.within(document.querySelector("dialog.plan-review") as HTMLElement);
  await ui.waitFor(() => assert.ok(review().queryByText("CognitoStack")));
  // The second plan finishes while the first is under review.
  ui.act(() => emit("deploy-job", { id: started, kind: "deploy-plan", title: "Plan my-aws-app-prod", params: {}, status: "succeeded", startedAt: "2026-10-17T12:00:00Z", endedAt: "2026-10-17T12:01:00Z", lastSeq: 3, planId: "my-aws-app-prod-xxxxxx", deployment: "my-aws-app-prod", steps: [{ label: "Plan", status: "done" }] }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(review().queryByText("CognitoStack"), "the plan under review stays");
  assert.equal(review().queryByText("RdsStack"), null, "the other plan does not take its place");
});

test("a target pinned to another region is read, and shown, from that region", async () => {
  const west = { ...context, region: "us-west-2" };
  const westDeployment: DiscoveredDeploymentView = { ...deployed("my-aws-app", "dev"), region: "us-west-2" };
  const westDiscovery: DiscoveryView = { ...discovery([westDeployment]), context: west, targets: [{ name: "my-aws-app", mode: "dev", origin: "personal", region: "us-west-2", status: "deployed" }] };
  render({
    "/deploy/overview": overview({ targets: [{ name: "my-aws-app", mode: "dev", origin: "personal", region: "us-west-2" }] }),
    "/deploy/discover": { ok: true, value: { ...discovery(), targets: [{ name: "my-aws-app", mode: "dev", origin: "personal", region: "us-west-2", status: "elsewhere", detail: "Pinned elsewhere." }] } },
    "/deploy/status": { ok: true, value: { ...westDiscovery, deployment: "my-aws-app", detail: { ...westDeployment, events: [], changeSets: [], local: { compatible: true, exported: { client: false, fresh: false } } } } },
  });
  assert.ok(await ui.screen.findByText("Deployed · 1 stack", {}, { timeout: 3000 }));
  assert.equal(ui.screen.queryByText("Not deployed here"), null);
  assert.ok(requested.some((url) => url.startsWith("/deploy/status") && url.includes("region=us-west-2")), requested.join(" "));
});

test("named staging remains a production-mode destination with its own resolved region", async () => {
  const staging = { name: "my-aws-app-staging", mode: "prod" as const, origin: "declared" as const, account: context.account, region: "us-west-2", inputs: "cdk-app/.env.staging" };
  const targets = [...overview().targets, staging];
  const west = { ...context, region: staging.region };
  render({
    "/deploy/overview": overview({ targets, preferences: { profiles: {}, profile: "dev", deployment: staging.name } }),
    "/deploy/discover": { ok: true, value: discovery() },
    "/deploy/status": { ok: true, value: { ...discovery(), context: west, deployment: staging.name, targets: targets.map(target => ({ ...target, status: "absent" })) } },
  });
  const rail = await ui.screen.findByRole("navigation", { name: "Deployments" });
  for (const target of targets) assert.ok(ui.within(rail).getByTitle(target.name).closest("button"));
  const selected = ui.within(rail).getByTitle(staging.name).closest("button")!;
  await ui.waitFor(() => assert.equal(selected.getAttribute("aria-current"), "true"));
  assert.ok(selected.textContent?.includes("Prod"));
  const header = ui.screen.getByRole("banner", { name: "AWS account" });
  await ui.waitFor(() => assert.ok(ui.within(header).getByText(staging.region)));
  assert.equal(ui.within(header).queryByText(context.region), null, "profile defaults are not presented as the selected deployment region");
  const profile = ui.within(header).getByRole("combobox", { name: "AWS profile" }) as HTMLSelectElement;
  assert.equal(profile.selectedOptions[0]?.text, "dev", "credential profile names are independent of deployment mode");
  assert.match(profile.title, /Profile default region: us-east-1/);
  assert.equal(operations().length, 0);
});

test("the deployment actions menu supports arrow navigation, Escape and outside dismissal", async () => {
  const value = { ...discovery([deployed("my-aws-app", "dev")]), deployment: "my-aws-app", detail: { ...deployed("my-aws-app", "dev"), events: [], changeSets: [], local: { compatible: true, exported: { client: false, fresh: false } } } };
  render({ "/deploy/overview": overview(), "/deploy/discover": { ok: true, value: value }, "/deploy/status": { ok: true, value } });
  const first = await ui.screen.findByRole("menuitem", { name: "Compare AWS templates (read-only)…" });
  await ui.waitFor(() => assert.equal((first as HTMLButtonElement).disabled, false));
  const trigger = ui.screen.getByLabelText("More actions");
  trigger.focus();
  ui.fireEvent.keyDown(trigger, { key: "ArrowDown" });
  await ui.waitFor(() => assert.equal(trigger.getAttribute("aria-expanded"), "true"));
  assert.equal(document.activeElement, first);
  ui.fireEvent.keyDown(first, { key: "End" });
  assert.equal(document.activeElement, ui.screen.getByRole("menuitem", { name: "Delete deployment…" }));
  ui.fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await ui.waitFor(() => assert.equal(trigger.getAttribute("aria-expanded"), "false"));
  assert.equal(document.activeElement, trigger);
  ui.fireEvent.keyDown(trigger, { key: "ArrowDown" });
  await ui.waitFor(() => assert.equal(trigger.getAttribute("aria-expanded"), "true"));
  ui.fireEvent.pointerDown(document.body);
  await ui.waitFor(() => assert.equal(trigger.getAttribute("aria-expanded"), "false"));
  assert.equal(operations().length, 0, "menu navigation never starts an operation");
});

test("a failed plan read offers retry without keeping its loading message", async () => {
  const waiting: PlanSummaryView = { key: "my-aws-app-prod-abc123", deployment: "my-aws-app-prod", mode: "prod", status: "ready", createdAt: "2026-10-17T12:00:00Z", expired: false };
  render({
    "/deploy/overview": overview({ preferences: { profiles: {}, profile: "dev", deployment: "my-aws-app-prod" } }),
    "/deploy/discover": { ok: true, value: discovery() }, "/deploy/status": { ok: true, value: { ...discovery(), deployment: "my-aws-app-prod" } },
    "/deploy/plans": [waiting],
  });
  ui.fireEvent.click(await ui.screen.findByRole("button", { name: "Review plan" }));
  assert.ok(await ui.screen.findByRole("alert"));
  assert.equal(ui.screen.queryByText("Reading the plan…"), null);
  assert.ok(ui.screen.getByRole("button", { name: "Try again" }));
  assert.equal(ui.screen.queryByRole("button", { name: /Apply to/ }), null);
});

test("refreshing container logs preserves a reader's position until they return to the bottom", async () => {
  render({ "/deploy/local/logs": { text: "first log" } }, h(dialogs.ServiceLogs, { service: "example", onClose: () => {} }));
  await ui.screen.findByText("first log");
  const log = ui.screen.getByLabelText("Logs for example");
  Object.defineProperties(log, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 100 } });
  log.scrollTop = 100;
  ui.fireEvent.scroll(log);
  ui.act(() => clients.at(-1)!.setQueryData(["deploy", "service-logs", "example"], { text: "second log" }));
  await ui.waitFor(() => assert.equal(log.textContent, "second log"));
  assert.equal(log.scrollTop, 100, "refresh does not jump away from earlier lines");
  log.scrollTop = 900;
  ui.fireEvent.scroll(log);
  ui.act(() => clients.at(-1)!.setQueryData(["deploy", "service-logs", "example"], { text: "third log" }));
  await ui.waitFor(() => assert.equal(log.textContent, "third log"));
  assert.equal(log.scrollTop, 1000, "following resumes at the bottom");
  assert.equal(log.getAttribute("tabindex"), "0", "keyboard users can scroll the log");
});

test("selected destination owns the header and survives unrelated discovery denial", async () => {
  const west = { ...context, region: "us-west-2" };
  const target = { name: "my-aws-app", mode: "dev" as const, origin: "declared" as const, account: context.account, region: west.region };
  const deployment = { ...deployed("my-aws-app", "dev"), region: west.region };
  render({
    "/deploy/overview": overview({ targets: [target] }),
    "/deploy/discover": { ok: false, problem: { kind: "denied", message: "Default region is denied" } },
    "/deploy/status": { ok: true, value: { ...discovery([deployment]), context: west, deployment: target.name, targets: [{ ...target, status: "deployed" }], detail: { ...deployment, events: [], changeSets: [] } } },
  });
  const header = await ui.screen.findByRole("banner", { name: "AWS account" });
  await ui.waitFor(() => assert.ok(header.textContent?.includes("us-west-2")));
  assert.ok(await ui.screen.findByText("Deployed · 1 stack"));
  assert.equal(ui.screen.queryByText("Not readable with this profile."), null);
  assert.ok(ui.screen.getByText(/selected deployment's observation below is separate/));
});

test("incomplete security analysis stays inside review and cannot be applied", async () => {
  const summary = { key: "blocked-review-abc123", deployment: "my-aws-app", mode: "dev" as const, account: context.account, region: context.region, status: "blocked" as const, createdAt: "2026-10-22T00:00:00Z", expired: false };
  const plan: PlanView = { key: summary.key, planId: "plan-abc-123456", createdAt: summary.createdAt, expiresAt: "2099-01-01T00:00:00Z", expired: false, status: "blocked", review: "template", identity: { deployment: summary.deployment, mode: "dev", account: context.account, region: context.region }, guard: "ready", stacks: [], secrets: [], dockerImages: [], iamBroadening: false, confirmation: { level: "click", reasons: [] }, uncertainties: [], reviewEvidence: { security: "AccessDenied while inspecting IAM", templates: "Template comparison", problems: ["Security analysis failed"] } };
  render({ "/deploy/overview": overview(), "/deploy/discover": { ok: true, value: discovery() }, "/deploy/status": { ok: true, value: { ...discovery(), deployment: summary.deployment } }, "/deploy/plans": [summary], [`/deploy/plans/${summary.key}`]: plan });
  ui.fireEvent.click(await ui.screen.findByRole("button", { name: "Review plan" }));
  assert.ok(await ui.screen.findByText("AccessDenied while inspecting IAM"));
  assert.equal(ui.screen.queryByRole("button", { name: `Apply to ${context.account}` }), null);
  assert.equal(operations().length, 0);
});
