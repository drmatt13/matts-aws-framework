import assert from "./support/assert";
import { createRequire } from "node:module";
import { after, afterEach, before, test } from "node:test";
import { createElement as h, type ReactNode } from "react";
import type { DeployOverview, DiscoveryView, DiscoveredDeploymentView, PlanSummaryView, PlanView, TeardownPlanView } from "../shared/deploy";
import { STUDIO_PROTOCOL_VERSION } from "../shared/protocol";
import { DEFAULT_FRONTEND_RELEASE } from "../shared/frontend-release";
import { snapshot as snapshotFixture } from "./browser/support/scenarios";
import { connectionCatalogFixture } from "./browser/support/aws-connections";

/**
 * The Deploy & Run page in a DOM, against scripted /api/deploy answers: what it
 * offers for each state, and the exact operation each click asks the server for.
 */

let dom: { window: Window & typeof globalThis };
let ui: typeof import("@testing-library/react");
let query: typeof import("@tanstack/react-query");
let page: typeof import("../src/views/Deploy");
let dialogs: typeof import("../src/views/deploy/Teardown");
let activity: typeof import("../src/views/GlobalActivity");
let studio: typeof import("../src/studio");
let observations: typeof import("../src/deploy/observations");
let router: typeof import("@tanstack/react-router");
let activeStudio: ReturnType<typeof import("../src/studio").useStudio>;
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
    targets: [{ name: "my-aws-app", mode: "dev", origin: "implicit", inputs: "cdk-app/.env.dev" }, { name: "my-aws-app-prod", mode: "prod", origin: "declared", account: context.account, region: context.region }],
    prerequisites: [{ id: "docker", label: "Docker", status: "ok", summary: "Engine running." }],
    local: { project: "matts-aws-framework-new", docker: { engine: "running", desktop: true }, services: [], watch: { running: false }, client: { running: false }, exported: { client: false }, startedBy: "none", restartNeeded: [] },
    jobs: [], preferences: { profiles: {}, profile: "dev", deployment: "my-aws-app" },
    profiles: [{ name: "dev", region: "us-east-1", kind: "sso" }, { name: "prod", region: "us-east-1", kind: "sso" }],
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
  Object.defineProperty(globalThis, "scrollTo", { configurable: true, value: () => {} });
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
      let answer = typeof answers[key] === "function" ? await answers[key](url) : answers[key];
      if (path === "/deploy/status" && answer?.ok && answer.value) answer = { ...answer, value: {
        ...answer.value, deployment: url.searchParams.get("deployment"),
        context: { ...answer.value.context, profile: url.searchParams.get("profile") },
        detail: answer.value.detail?.name === url.searchParams.get("deployment") ? answer.value.detail : undefined,
      } };
      return answer instanceof Response ? answer : key in answers ? new Response(JSON.stringify(answer), { status: 200 }) : new Response(JSON.stringify({ error: `unscripted ${path}` }), { status: 404 });
    },
  });
  ui = require("@testing-library/react");
  query = require("@tanstack/react-query");
  router = require("@tanstack/react-router");
  studio = await import("../src/studio");
  observations = await import("../src/deploy/observations");
  page = await import("../src/views/Deploy");
  dialogs = await import("../src/views/deploy/Teardown");
  activity = await import("../src/views/GlobalActivity");
});
after(() => dom.window.close());
afterEach(async () => { ui.cleanup(); for (const client of clients.splice(0)) { await client.cancelQueries(); client.clear(); } dom.window.localStorage.clear(); });

function render(scripted: Record<string, unknown>, content?: ReactNode, associations: { dev?: string; prod?: string } = { dev: "dev", prod: "prod" }) {
  posted = [];
  requested.length = 0;
  answers = { "/operations": { jobs: [] }, "/deploy/plans": [], "/deploy/drift": null,
    "/frontend-release/settings": { settings: DEFAULT_FRONTEND_RELEASE, hash: "settings-review-hash" },
    "/frontend-release/history": [],
    ...scripted };
  const machineOverview = scripted["/deploy/overview"] as DeployOverview | undefined;
  answers["/aws-connections"] ??= () => connectionCatalogFixture(
    typeof answers["/deploy/overview"] === "object" ? (answers["/deploy/overview"] as DeployOverview).profiles : machineOverview?.profiles ?? [],
  );
  answers["/machine/docker"] ??= { docker: machineOverview?.local.docker ?? overview().local.docker,
    checks: machineOverview?.prerequisites.filter(item => item.id === "docker" || item.id === "compose") ?? overview().prerequisites,
    observedAt: "2026-11-04T00:00:00.000Z" };
  if (Array.isArray(answers["/deploy/plans"])) answers["/deploy/plans"] = (answers["/deploy/plans"] as PlanSummaryView[]).map((plan) => ({ account: context.account, region: context.region, profile: plan.mode === "prod" ? "prod" : "dev", ...plan }));
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  const response = snapshotFixture();
  dom.window.localStorage.setItem(`aws-studio:mode-profiles:v1:${response.snapshot.repositoryRoot}`, JSON.stringify(associations));
  function Workbench() { activeStudio = studio.useStudio(); return h("div", null, h(observations.GlobalDeploymentObservations), content ?? h("div", null, h(page.Deploy), h(activity.GlobalActivity))); }
  const root = router.createRootRoute({ component: () => h(studio.StudioProvider, { response, selected: undefined, select: () => {}, children: h(Workbench) }) });
  const app = router.createRouter({ history: router.createMemoryHistory({ initialEntries: ["/"] }), routeTree: root.addChildren([router.createRoute({ getParentRoute: () => root, path: "/", component: () => null })]) });
  return ui.render(h(query.QueryClientProvider, { client }, h(router.RouterProvider, { router: app })));
}

const operations = () => posted.filter((entry) => entry.path === "/deploy/operations").map((entry) => { const { requestKey, ...intent } = entry.body; assert.equal(typeof requestKey, "string"); return intent; });

test("unapplied frontend settings block env generation and builds with a source-review explanation", async () => {
  const { FrontendRelease } = await import("../src/views/deploy/FrontendRelease");
  render({}, h(FrontendRelease, { deployment: "my-aws-app", profile: "dev", region: context.region }));
  ui.fireEvent.click(await ui.screen.findByText("Client environment & frontend release", { exact: true }));
  ui.fireEvent.click(await ui.screen.findByText("Frontend project and publication settings", { exact: true }));
  const build = () => ui.screen.getByRole("button", { name: "Build & review release" }) as HTMLButtonElement;
  const generate = () => ui.screen.getByRole("button", { name: "Generate / refresh client env" }) as HTMLButtonElement;
  await ui.waitFor(() => assert.equal(build().disabled, false));
  ui.fireEvent.change(ui.screen.getByLabelText("Bucket prefix (blank or ending in /)"), { target: { value: "unapplied/" } });
  assert.equal(build().disabled, true); assert.equal(generate().disabled, true);
  assert.ok(ui.screen.getByText(/settings have unapplied changes/));
  assert.equal(posted.length, 0, "changing a field neither saves source nor starts a release");
});

test("machine issues keep their explicit remedies beside the checks summary", async () => {
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
  // Native popover disclosure, dismissal and focus are covered in browser/deploy.spec.ts.
  ui.fireEvent.click(checks);
  assert.equal(operations().length, 0, "reading tool checks starts no operation");
  ui.fireEvent.click(ui.within(issues).getByRole("button", { name: "Start" }));
  await ui.waitFor(() => assert.deepEqual(operations()[0], { kind: "docker-start", params: {} }));
  assert.equal(ui.within(ui.screen.getByRole("region", { name: "Activity" }))
    .getByRole("button", { name: /^Activity/ }).getAttribute("aria-expanded"), "true");
});

test("the empty profile state discovers a newly configured profile in the background", async () => {
  render({
    "/deploy/overview": overview({ targets: [], profiles: [], preferences: { profiles: {} } }),
    "/deploy/discover": { ok: true, value: discovery() }, "/deploy/status": { ok: true, value: { ...discovery(), deployment: "my-aws-app" } },
  });
  await ui.screen.findByRole("heading", { name: "No AWS profiles on this machine" });
  assert.equal(ui.screen.queryByRole("button", { name: "Refresh" }), null);
  answers["/deploy/overview"] = overview();
  ui.act(() => emit("aws-connections", { profiles: [] }));
  await ui.screen.findByRole("heading", { name: /my-aws-app Dev/ });
  assert.ok(ui.screen.getByRole("region", { name: "Machine readiness" }));
  assert.equal(ui.screen.queryByRole("combobox", { name: "AWS profile" }), null);
  assert.equal(operations().length, 0);
});

test("a failed refresh keeps deployment evidence visible, reports the error and supports retry", async () => {
  render({ "/deploy/overview": overview(), "/deploy/discover": { ok: true, value: discovery() }, "/deploy/status": { ok: true, value: { ...discovery(), deployment: "my-aws-app" } } });
  await ui.screen.findByRole("heading", { name: /my-aws-app Dev/ });
  let finish!: (response: Response) => void;
  answers["/deploy/overview"] = () => new Promise<Response>((resolve) => { finish = resolve; });
  ui.act(() => emit("deploy-changed", {}));
  await ui.waitFor(() => assert.ok(finish));
  finish(new Response(JSON.stringify({ error: "Machine probes timed out." }), { status: 503 }));
  const error = await ui.screen.findByRole("alert");
  assert.match(error.textContent ?? "", /Machine probes timed out/);
  assert.ok(ui.screen.getByRole("heading", { name: /my-aws-app Dev/ }), "last successful overview remains visible");
  const retry = ui.screen.getByRole("button", { name: "Try again" });
  await ui.waitFor(() => assert.equal((retry as HTMLButtonElement).disabled, false));
  answers["/deploy/overview"] = overview();
  ui.fireEvent.click(retry);
  await ui.waitFor(() => assert.equal(Boolean(ui.screen.queryByRole("alert")), false));
  assert.equal(operations().length, 0);
});

test("an absent development deployment omits the removed panels and planning entry points", async () => {
  render({ "/deploy/overview": overview(), "/deploy/discover": { ok: true, value: discovery() }, "/deploy/status": { ok: true, value: { ...discovery(), deployment: "my-aws-app" } } });
  assert.ok(await ui.screen.findByText("Not deployed here"));
  assert.equal(ui.screen.queryByRole("navigation", { name: "Deployments" }), null);
  assert.equal(ui.screen.queryByRole("region", { name: "Repository" }), null);
  assert.equal(ui.screen.queryByRole("region", { name: "AWS" }), null);
  assert.equal(ui.screen.queryByRole("region", { name: "This machine" }), null);
  assert.equal(ui.screen.queryByText("Client environment & frontend release"), null);
  assert.equal(ui.screen.queryByText("Stateful retention and retained-resource references"), null);
  assert.equal(requested.some(path => path.startsWith("/frontend-release/")), false);
  assert.equal(ui.screen.queryByRole("button", { name: /Compare AWS templates/ }), null);
  assert.equal(ui.screen.queryByLabelText("More actions"), null);
  assert.equal(ui.screen.queryByText("Default development stage"), null);
  assert.equal(ui.screen.queryByText("Add a deployment stage"), null);
  assert.equal(requested.some(path => path.startsWith("/frontend-release/identities")), false);
  assert.equal(operations().length, 0);
});

for (const kind of ["expired", "no-credentials"] as const) test(`${kind} credentials use the account line to open connection management without starting a login job`, async () => {
  const expired = { ok: false, problem: { kind, message: "The selected profile's session has expired." } };
  render({ "/deploy/overview": overview(), "/deploy/discover": expired, "/deploy/status": expired });
  const error = await ui.screen.findByRole("button", { name: "AWS sign-in required. Open AWS profile configuration" }, { timeout: 3000 });
  assert.ok(error.closest('[data-slot="deployment-context"]'));
  assert.equal(ui.screen.queryByRole("button", { name: "Sign in" }), null);
  assert.equal(ui.screen.queryByText("Sign in to dev", { exact: true }), null);
  assert.equal(ui.screen.queryByText(expired.problem.message, { exact: true }), null);
  let opened = 0; const onOpen = () => { opened++; };
  dom.window.addEventListener("studio:aws-profile-configuration", onOpen);
  try {
    ui.fireEvent.click(error);
    assert.equal(opened, 1);
    assert.deepEqual(operations(), []);
  } finally { dom.window.removeEventListener("studio:aws-profile-configuration", onOpen); }
});

test("a production plan is applied only with its name typed", async () => {
  const waiting: PlanSummaryView = { key: "my-aws-app-prod-abc123", deployment: "my-aws-app-prod", mode: "prod", status: "ready", createdAt: "2026-10-17T12:00:00Z", expired: false };
  const plan: PlanView = {
    key: waiting.key, planId: "plan-abc-123456", createdAt: waiting.createdAt, expiresAt: "2099-01-01T00:00:00Z", expired: false, status: "ready", review: "change-set", profile: "prod",
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
  await ui.screen.findByRole("heading", { name: /my-aws-app Dev/ });
  ui.act(() => activeStudio.setMode("prod"));
  ui.fireEvent.click(await ui.screen.findByRole("button", { name: "Review plan" }, { timeout: 3000 }));
  const apply = await ui.screen.findByRole("button", { name: /Deploy (development|production)/ });
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
  await ui.waitFor(() => assert.deepEqual(operations()[0], { kind: "deploy-apply", params: { plan: waiting.key, profile: "prod", confirm: "my-aws-app-prod" } }));
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
    "/deploy/status": { ok: true, value: { ...discovery([deployed("my-aws-app", "dev")]), deployment: "my-aws-app", detail: { ...deployed("my-aws-app", "dev"), state: { kind: "failed", deployable: false, stacks: [{ ...stack("my-aws-app-CognitoStack", "my-aws-app", "dev"), status: "UPDATE_ROLLBACK_FAILED", health: "failed" }] }, events: [], changeSets: [], local: { compatible: true, exported: { client: false, fresh: false } } } } },
    "/deploy/teardown": { ok: true, value: teardown },
  });
  ui.fireEvent.click(await ui.screen.findByRole("button", { name: "Delete…" }, { timeout: 3000 }));
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
    "/deploy/plans": [reviewed, { ...reviewed, key: "my-aws-app-prod-replan", status: "blocked" }],
    "/deploy/plans/my-aws-app-prod-replan": { ...plan("my-aws-app-prod-replan", "OtherStack"), result: { status: "failed", deferred: [], verification: { verified: false, stacks: [] } } },
    [`/deploy/plans/${reviewed.key}`]: plan(reviewed.key, "CognitoStack"),
    "/deploy/plans/my-aws-app-prod-xxxxxx": plan("my-aws-app-prod-xxxxxx", "RdsStack"),
  });
  await ui.screen.findByRole("heading", { name: /my-aws-app Dev/ });
  ui.act(() => activeStudio.setMode("prod"));
  ui.fireEvent.click((await ui.screen.findAllByRole("button", { name: "Review plan" }))[1]!);
  ui.fireEvent.click(await ui.screen.findByRole("button", { name: "Synthesize again" }));
  await ui.waitFor(() => assert.equal(operations().length, 1));
  const started = `job-${posted.findIndex((entry) => entry.path === "/deploy/operations") + 1}`;
  ui.fireEvent.click(ui.screen.getAllByRole("button", { name: "Review plan" })[0]!);
  const review = () => ui.within(document.querySelector('dialog[data-ui="plan-review"]') as HTMLElement);
  await ui.waitFor(() => assert.ok(review().queryByText("CognitoStack")));
  assert.ok(review().getByText(/previously saved templates and assets/), "the existing review explicitly permits saved-artifact recovery");
  assert.equal((review().getByRole("button", { name: "Deploy production" }) as HTMLButtonElement).disabled, false);
  // The second plan finishes while the first is under review.
  ui.act(() => emit("deploy-job", { id: started, kind: "deploy-plan", title: "Plan my-aws-app-prod", params: {}, status: "succeeded", startedAt: "2026-10-17T12:00:00Z", endedAt: "2026-10-17T12:01:00Z", lastSeq: 3, planId: "my-aws-app-prod-xxxxxx", deployment: "my-aws-app-prod", steps: [{ label: "Plan", status: "done" }] }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(review().queryByText("CognitoStack"), "the plan under review stays");
  assert.equal(review().queryByText("RdsStack"), null, "the other plan does not take its place");
  assert.equal((review().getByRole("button", { name: "Deploy production" }) as HTMLButtonElement).disabled, false,
    "completion cannot change the existing review's source policy or applicability");
  ui.fireEvent.click(review().getByRole("button", { name: "Deploy production" }));
  await ui.waitFor(() => assert.deepEqual(operations()[1], { kind: "deploy-apply", params: { plan: reviewed.key, profile: "prod" } }));
});

test("a target pinned to another region is read, and shown, from that region", async () => {
  const west = { ...context, region: "us-west-2" };
  const westDeployment: DiscoveredDeploymentView = { ...deployed("my-aws-app", "dev"), region: "us-west-2" };
  const westDiscovery: DiscoveryView = { ...discovery([westDeployment]), context: west, targets: [{ name: "my-aws-app", mode: "dev", origin: "implicit", region: "us-west-2", status: "deployed" }] };
  render({
    "/deploy/overview": overview({ targets: [{ name: "my-aws-app", mode: "dev", origin: "implicit", region: "us-west-2" }] }),
    "/deploy/discover": { ok: true, value: { ...discovery(), targets: [{ name: "my-aws-app", mode: "dev", origin: "implicit", region: "us-west-2", status: "elsewhere", detail: "Pinned elsewhere." }] } },
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
  await ui.screen.findByRole("heading", { name: /my-aws-app Dev/ });
  ui.act(() => activeStudio.setMode("prod"));
  await ui.screen.findByRole("heading", { name: /my-aws-app-staging Prod/ });
  const header = document.getElementById("deployment-heading")!.parentElement!;
  await ui.waitFor(() => assert.ok(header.textContent?.includes(staging.region)));
  assert.equal(header.textContent?.includes(context.region), false, "profile defaults are not presented as the selected deployment region");
  assert.equal(ui.within(header).queryByRole("combobox", { name: "AWS profile" }), null);
  assert.equal(activeStudio.mode, "prod");
  assert.equal(activeStudio.awsProfile, "prod");
  assert.equal(operations().length, 0);
});

test("a failed plan read offers retry without keeping its loading message", async () => {
  const waiting: PlanSummaryView = { key: "my-aws-app-prod-abc123", deployment: "my-aws-app-prod", mode: "prod", status: "ready", createdAt: "2026-10-17T12:00:00Z", expired: false };
  render({
    "/deploy/overview": overview({ preferences: { profiles: {}, profile: "dev", deployment: "my-aws-app-prod" } }),
    "/deploy/discover": { ok: true, value: discovery() }, "/deploy/status": { ok: true, value: { ...discovery(), deployment: "my-aws-app-prod" } },
    "/deploy/plans": [waiting],
  });
  await ui.screen.findByRole("heading", { name: /my-aws-app Dev/ });
  ui.act(() => activeStudio.setMode("prod"));
  ui.fireEvent.click(await ui.screen.findByRole("button", { name: "Review plan" }));
  assert.ok(await ui.screen.findByRole("alert"));
  assert.equal(ui.screen.queryByText("Reading the plan…"), null);
  assert.ok(ui.screen.getByRole("button", { name: "Try again" }));
  assert.equal(ui.screen.queryByRole("button", { name: /Deploy (development|production)/ }), null);
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

test("selected destination owns the detail heading without redundant discovery in the default region", async () => {
  const west = { ...context, region: "us-west-2" };
  const target = { name: "my-aws-app", mode: "dev" as const, origin: "declared" as const, account: context.account, region: west.region };
  const deployment = { ...deployed("my-aws-app", "dev"), region: west.region };
  render({
    "/deploy/overview": overview({ targets: [target] }),
    "/deploy/discover": { ok: false, problem: { kind: "denied", message: "Default region is denied" } },
    "/deploy/status": { ok: true, value: { ...discovery([deployment]), context: west, deployment: target.name, targets: [{ ...target, status: "deployed" }], detail: { ...deployment, events: [], changeSets: [] } } },
  });
  await ui.screen.findByRole("heading", { name: /my-aws-app Dev/ });
  const header = document.getElementById("deployment-heading")!.parentElement!;
  await ui.waitFor(() => assert.ok(header.textContent?.includes("us-west-2")));
  assert.ok(await ui.screen.findByText("Deployed · 1 stack"));
  assert.equal(ui.screen.queryByText("Not readable with this profile."), null);
  assert.equal(requested.some(path => path.startsWith("/deploy/discover") && new URL(path, "http://localhost").searchParams.get("profile") === "dev"), false);
  assert.equal(ui.screen.queryByText(/Default region is denied/), null);
});

test("incomplete security analysis stays inside review and cannot be applied", async () => {
  const summary = { key: "blocked-review-abc123", deployment: "my-aws-app", mode: "dev" as const, account: context.account, region: context.region, status: "blocked" as const, createdAt: "2026-10-22T00:00:00Z", expired: false };
  const plan: PlanView = { key: summary.key, planId: "plan-abc-123456", createdAt: summary.createdAt, expiresAt: "2099-01-01T00:00:00Z", expired: false, status: "blocked", review: "template", identity: { deployment: summary.deployment, mode: "dev", account: context.account, region: context.region }, guard: "ready", stacks: [], secrets: [], dockerImages: [], iamBroadening: false, confirmation: { level: "click", reasons: [] }, uncertainties: [], reviewEvidence: { security: "AccessDenied while inspecting IAM", templates: "Template comparison", problems: ["Security analysis failed"] } };
  render({ "/deploy/overview": overview(), "/deploy/discover": { ok: true, value: discovery() }, "/deploy/status": { ok: true, value: { ...discovery(), deployment: summary.deployment } }, "/deploy/plans": [summary], [`/deploy/plans/${summary.key}`]: plan });
  ui.fireEvent.click(await ui.screen.findByRole("button", { name: "Review plan" }));
  assert.ok(await ui.screen.findByText("AccessDenied while inspecting IAM"));
  assert.equal(ui.screen.queryByRole("button", { name: /Deploy (development|production)/ }), null);
  assert.equal(operations().length, 0);
});

test("global mode switches the deployment and its association without restoring legacy profiles", async () => {
  render({
    "/deploy/overview": overview({ preferences: { deployment: "my-aws-app", profile: "legacy", profiles: { "my-aws-app-prod": "legacy-production" } } }),
    "/deploy/discover": { ok: true, value: discovery() },
    "/deploy/status": (url: URL) => ({ ok: true, value: { ...discovery(), deployment: url.searchParams.get("deployment") } }),
  });
  await ui.screen.findByRole("heading", { name: /my-aws-app Dev/ });
  ui.act(() => activeStudio.setMode("prod"));
  await ui.screen.findByRole("heading", { name: /my-aws-app-prod Prod/ });
  assert.equal(activeStudio.awsProfile, "prod"); assert.equal(activeStudio.mode, "prod");
  await ui.waitFor(() => assert.ok(requested.some(url => url.startsWith("/deploy/status") && url.includes("deployment=my-aws-app-prod") && url.includes("profile=prod"))));
  assert.ok(requested.every(url => !url.includes("profile=legacy")));
  assert.ok(posted.filter(entry => entry.path === "/deploy/preferences").every(entry => !Object.hasOwn(entry.body, "profile")));
  assert.equal(operations().length, 0);
});

test("a missing global association prevents AWS reads and never adopts a legacy preference", async () => {
  render({ "/deploy/overview": overview() }, undefined, {});
  await ui.screen.findByRole("button", { name: "Choose connection" });
  assert.equal(ui.screen.queryByRole("region", { name: "AWS" }), null);
  assert.equal(activeStudio.awsProfile, undefined);
  assert.equal(requested.some(url => /^\/deploy\/(?:discover|status)/.test(url)), false);
  assert.equal(operations().length, 0);
  assert.equal(ui.screen.queryByRole("combobox", { name: "AWS profile" }), null);
});

test("switching a deployment waits for the existing unsaved-source guard", async () => {
  render({
    "/deploy/overview": overview(),
    "/deploy/discover": { ok: true, value: discovery() },
    "/deploy/status": (url: URL) => ({ ok: true, value: { ...discovery(), deployment: url.searchParams.get("deployment") } }),
  });
  await ui.screen.findByRole("heading", { name: /my-aws-app Dev/ });
  ui.act(() => activeStudio.draft.setField("lambda:fixture-0", activeStudio.model.fields["lambda:fixture-0"]![0]!, 512));
  ui.act(() => activeStudio.setMode("prod"));
  assert.equal(activeStudio.draftState.pendingNavigation, true);
  assert.equal(activeStudio.mode, "dev");
  assert.equal(posted.filter(entry => entry.path === "/deploy/preferences").length, 0);
  ui.act(() => activeStudio.draft.keepEditing());
  assert.equal(activeStudio.mode, "dev");
  ui.act(() => activeStudio.setMode("prod"));
  ui.act(() => activeStudio.draft.discardAndContinue());
  await ui.screen.findByRole("heading", { name: /my-aws-app-prod Prod/ });
  assert.equal(activeStudio.awsProfile, "prod");
  assert.equal(operations().length, 0);
});

test("mode changes clear a pending operation review and refresh the matching target in the background", async () => {
  const summary: PlanSummaryView = { key: "actor-review", deployment: "my-aws-app", mode: "dev", account: context.account, region: context.region, status: "ready", createdAt: "2026-10-22T00:00:00Z", expired: false };
  const plan: PlanView = { key: summary.key, planId: "plan-actor-review", profile: "dev", createdAt: summary.createdAt, expiresAt: "2099-01-01T00:00:00Z", expired: false, status: "ready", review: "template", identity: { deployment: summary.deployment, mode: "dev", account: context.account, region: context.region }, guard: "ready", stacks: [], secrets: [], dockerImages: [], iamBroadening: false, confirmation: { level: "click", reasons: [] }, uncertainties: [] };
  render({ "/deploy/overview": overview(), "/deploy/discover": { ok: true, value: discovery() }, "/deploy/status": { ok: true, value: { ...discovery(), deployment: summary.deployment } }, "/deploy/plans": [summary], [`/deploy/plans/${summary.key}`]: plan });
  ui.fireEvent.click(await ui.screen.findByRole("button", { name: "Review plan" }));
  await ui.screen.findByRole("button", { name: /Deploy (development|production)/ });
  ui.act(() => activeStudio.setMode("prod"));
  await ui.waitFor(() => assert.equal(ui.screen.queryByRole("button", { name: /Deploy (development|production)/ }), null));
  assert.equal(activeStudio.awsProfile, "prod");
  await ui.waitFor(() => assert.ok(requested.some(url => url.startsWith("/deploy/status") && url.includes("deployment=my-aws-app-prod") && url.includes("profile=prod"))));
  assert.equal(operations().length, 0);
});

function synthesizedPlan(): PlanView {
  return {
    key: "synthesized-dev", planId: "plan-synthesized-dev", profile: "dev",
    createdAt: "2026-11-05T12:00:00Z", expiresAt: "2099-01-01T00:00:00Z", expired: false,
    status: "ready", review: "template", synthesis: { current: true },
    identity: { deployment: "my-aws-app", mode: "dev", account: context.account, region: context.region },
    guard: "absent", stacks: [{ name: "my-aws-app-CognitoStack", fingerprint: { exists: false },
      changes: [{ logicalId: "Pool", type: "AWS::Cognito::UserPool", action: "add", replacement: "False", stateful: true }],
      exportsInUse: [], noChanges: false }],
    secrets: [], dockerImages: [], iamBroadening: false,
    confirmation: { level: "click", reasons: [] }, uncertainties: [],
  };
}

function synthesisSummary(plan: PlanView): PlanSummaryView {
  return { key: plan.key, deployment: plan.identity.deployment, mode: plan.identity.mode,
    profile: plan.profile, account: plan.identity.account, region: plan.identity.region,
    status: plan.status, createdAt: plan.createdAt, expired: false, synthesis: plan.synthesis };
}

function deploymentAnswers() {
  return { "/deploy/overview": overview(), "/deploy/discover": { ok: true, value: discovery() },
    "/deploy/status": { ok: true, value: { ...discovery(), deployment: "my-aws-app" } } };
}

test("synthesis produces a plan card whose review deploys the prepared assembly", async () => {
  const plan = synthesizedPlan();
  render({ ...deploymentAnswers(), [`/deploy/plans/${plan.key}`]: plan });
  const synthesize = await ui.screen.findByRole("button", { name: "Synthesize" });
  await ui.waitFor(() => assert.equal((synthesize as HTMLButtonElement).disabled, false));
  ui.fireEvent.click(synthesize);
  await ui.waitFor(() => assert.deepEqual(operations(), [{ kind: "deploy-plan", params: {
    deployment: "my-aws-app", profile: "dev", review: "template",
  } }]));
  answers["/deploy/plans"] = [synthesisSummary(plan)];
  ui.act(() => {
    emit("deploy-job", { ...job("deploy-plan", {}), id: "job-1", deployment: "my-aws-app", status: "succeeded", planId: plan.key });
    emit("deploy-changed", { profile: "dev", deployment: "my-aws-app" });
  });
  await ui.screen.findByText("Plan ready for review");
  assert.equal(ui.screen.queryByRole("dialog"), null, "synthesis never asks to deploy automatically");
  assert.equal(ui.screen.queryByRole("button", { name: "Deploy" }), null, "deployment is offered only inside the review");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review plan" }));
  const confirm = await ui.screen.findByRole("button", { name: "Deploy development" });
  assert.equal(operations().length, 1, "a current prepared assembly is reused without another synthesis");
  ui.fireEvent.click(confirm);
  await ui.waitFor(() => assert.deepEqual(operations()[1], { kind: "deploy-apply", params: {
    plan: plan.key, profile: "dev", currentSource: true,
  } }));
});

test("repeated clicks synthesize once and completion waits for an explicit plan review", async () => {
  const plan = synthesizedPlan();
  render({ ...deploymentAnswers(), [`/deploy/plans/${plan.key}`]: plan });
  const synthesize = await ui.screen.findByRole("button", { name: "Synthesize" });
  await ui.waitFor(() => assert.equal((synthesize as HTMLButtonElement).disabled, false));
  ui.fireEvent.click(synthesize);
  ui.fireEvent.click(synthesize);
  await ui.waitFor(() => assert.equal(operations().length, 1));
  assert.equal(operations()[0]!.kind, "deploy-plan");
  answers["/deploy/plans"] = [synthesisSummary(plan)];
  ui.act(() => {
    emit("deploy-job", { ...job("deploy-plan", {}), id: "job-1", deployment: "my-aws-app", status: "succeeded", planId: plan.key });
    emit("deploy-changed", { profile: "dev", deployment: "my-aws-app" });
  });
  await ui.screen.findByRole("button", { name: "Review plan" });
  assert.equal(ui.screen.queryByRole("dialog"), null, "a generated plan never opens or applies itself");
  assert.equal(operations().length, 1);
});

test("a current plan from older source remains inspectable but requires synthesis before deployment", async () => {
  const plan = { ...synthesizedPlan(), synthesis: { current: false, reason: "Source changed." } };
  render({ ...deploymentAnswers(), "/deploy/plans": [synthesisSummary(plan)], [`/deploy/plans/${plan.key}`]: plan });
  await ui.screen.findByText("Plan needs synthesis");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review plan" }));
  await ui.screen.findByRole("button", { name: "Synthesize again" });
  assert.equal(ui.screen.queryByRole("button", { name: "Deploy development" }), null);
  assert.ok(ui.screen.getAllByText(/Source changed/).length);
  assert.equal(operations().length, 0, "reviewing a stale artifact neither resynthesizes nor applies it");
});

test("only the newest plan is current and every older plan keeps its own review and discard in history", async () => {
  const older = { ...synthesizedPlan(), key: "older-dev", createdAt: "2026-11-05T11:00:00Z" };
  const current = { ...synthesizedPlan(), key: "current-dev" };
  const foreign = { ...synthesizedPlan(), key: "other-profile", profile: "prod", createdAt: "2026-11-05T13:00:00Z" };
  render({ ...deploymentAnswers(), "/deploy/plans": [synthesisSummary(older), synthesisSummary(foreign), synthesisSummary(current)],
    [`/deploy/plans/${older.key}`]: older, [`/deploy/plans/${current.key}`]: current });
  await ui.screen.findByText("Earlier plans (1)");
  const heading = document.getElementById("deployment-heading")!.closest("header")!;
  assert.deepEqual(ui.within(heading).getAllByRole("button").map(button => button.textContent), ["This machine · 1 check passed", "Synthesize"]);
  const history = document.querySelector('details[aria-label="Earlier plans"]')!;
  assert.equal(history.hasAttribute("open"), false);
  const currentCard = [...document.querySelectorAll("article")].find(card => !history.contains(card) && card.textContent?.includes("Plan ready for review"))!;
  assert.deepEqual(ui.within(currentCard as HTMLElement).getAllByRole("button").map(button => button.textContent), ["Review plan", "Discard"]);
  ui.fireEvent.click(history.querySelector("summary")!);
  const olderReview = ui.within(history as HTMLElement).getByRole("button", { name: "Review plan" });
  ui.fireEvent.click(olderReview);
  const deploy = await ui.screen.findByRole("button", { name: "Deploy development" });
  ui.fireEvent.click(deploy);
  await ui.waitFor(() => assert.deepEqual(operations()[0], { kind: "deploy-apply", params: { plan: older.key, profile: "dev" } }));
});

test("a no-change synthesis still has one inspectable plan card without a deployment action", async () => {
  const plan = { ...synthesizedPlan(), status: "no-changes" as const, stacks: [] };
  render({ ...deploymentAnswers(), "/deploy/plans": [synthesisSummary(plan)], [`/deploy/plans/${plan.key}`]: plan });
  await ui.screen.findByText("No deployment changes");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review plan" }));
  await ui.screen.findByText(/Nothing to apply/);
  assert.equal(ui.screen.queryByRole("button", { name: "Deploy development" }), null);
  assert.equal(operations().length, 0);
});
