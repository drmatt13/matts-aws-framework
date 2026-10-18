import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, afterEach, before, test } from "node:test";
import { createElement as h } from "react";
import type { DeployOverview, DiscoveryView, DiscoveredDeploymentView, PlanSummaryView, PlanView, TeardownPlanView } from "../shared/deploy";

/**
 * The Deploy & Run page in a DOM, against scripted /api/deploy answers: what it
 * offers for each state, and the exact operation each click asks the server for.
 */

let dom: { window: Window & typeof globalThis };
let ui: typeof import("@testing-library/react");
let query: typeof import("@tanstack/react-query");
let page: typeof import("../src/views/Deploy");
const clients: import("@tanstack/react-query").QueryClient[] = [];
let answers: Record<string, unknown>;
let posted: { path: string; body: any }[];

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
  dom = new JSDOM("<!doctype html><html><head><meta name=\"studio-token\" content=\"t\"></head><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of ["window", "self", "document", "navigator", "HTMLElement", "Node", "MutationObserver", "getComputedStyle"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: class { addEventListener() {} close() {} } });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string, init?: { method?: string; body?: string }) => {
      const url = new URL(input, "http://localhost");
      const path = url.pathname.replace(/^\/api/, "");
      if (init?.method === "POST") {
        const body = init.body ? JSON.parse(init.body) : {};
        posted.push({ path, body });
        const reply = path === "/deploy/operations" ? job(body.kind, body.params) : path === "/deploy/preferences" ? { profiles: {}, ...body } : {};
        return new Response(JSON.stringify(reply), { status: 200 });
      }
      const key = Object.keys(answers).find((candidate) => path === candidate || path.startsWith(`${candidate}?`)) ?? path;
      return key in answers ? new Response(JSON.stringify(answers[key]), { status: 200 }) : new Response(JSON.stringify({ error: `unscripted ${path}` }), { status: 404 });
    },
  });
  ui = require("@testing-library/react");
  query = require("@tanstack/react-query");
  page = await import("../src/views/Deploy");
});
after(() => dom.window.close());
afterEach(() => { ui.cleanup(); clients.splice(0).forEach((client) => client.clear()); });

function render(scripted: Record<string, unknown>) {
  posted = [];
  answers = { "/deploy/plans": [], "/deploy/drift": null, ...scripted };
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  return ui.render(h(query.QueryClientProvider, { client }, h(page.Deploy)));
}

const operations = () => posted.filter((entry) => entry.path === "/deploy/operations").map((entry) => entry.body);

test("an absent development deployment is deployed with one click, as a plan that applies itself", async () => {
  render({ "/deploy/overview": overview(), "/deploy/discover": { ok: true, value: discovery() }, "/deploy/status": { ok: true, value: { ...discovery(), deployment: "my-aws-app" } } });
  const primary = await ui.screen.findByRole("button", { name: "Deploy development" }, { timeout: 3000 });
  assert.ok(await ui.screen.findByText("Not deployed here"));
  ui.fireEvent.click(primary);
  await ui.waitFor(() => assert.equal(operations().length, 1));
  assert.deepEqual(operations()[0], { kind: "deploy-plan", params: { deployment: "my-aws-app", profile: "dev", autoApply: true } });
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
  ui.fireEvent.change(ui.screen.getByLabelText("Type my-aws-app-prod to apply"), { target: { value: "my-aws-app" } });
  assert.equal((apply as HTMLButtonElement).disabled, true, "a different name does not count");
  ui.fireEvent.change(ui.screen.getByLabelText("Type my-aws-app-prod to apply"), { target: { value: "my-aws-app-prod" } });
  assert.equal((apply as HTMLButtonElement).disabled, false);
  ui.fireEvent.click(apply);
  await ui.waitFor(() => assert.deepEqual(operations()[0], { kind: "deploy-apply", params: { plan: waiting.key, profile: "dev", confirm: "my-aws-app-prod" } }));
});

test("deleting shows what AWS holds and what stays, and needs the typed name", async () => {
  const teardown: TeardownPlanView = {
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
  await ui.waitFor(() => assert.deepEqual(operations()[0], { kind: "destroy", params: { deployment: "my-aws-app", mode: "dev", profile: "dev", confirm: "my-aws-app" } }));
});
