import assert from "./support/assert";
import { createRequire } from "node:module";
import path from "node:path";
import { after, afterEach, before, mock, test } from "node:test";
import { createElement as h, type FunctionComponent } from "react";
import type { SnapshotResponse } from "../shared/api";
import type { CognitoObservation, IdentityPoolsObservation, IdentitySource } from "../shared/identity";
import type { DeployOverview } from "../shared/deploy";
import type { IdentityPolicySource } from "../shared/identity-policy";
import { SnapshotBuilder } from "../server/snapshot";
import { STUDIO_PROTOCOL_VERSION } from "../shared/protocol";

const require = createRequire(import.meta.url);
let dom: { window: Window & typeof globalThis };
let ui: typeof import("@testing-library/react");
let router: typeof import("@tanstack/react-router");
let query: typeof import("@tanstack/react-query");
let studio: typeof import("../src/studio");
let dialogs: typeof import("../src/views/DraftControls");
let builder: SnapshotBuilder;
let response: SnapshotResponse;
let context: ReturnType<typeof import("../src/studio").useStudio>;
let queryClient: import("@tanstack/react-query").QueryClient;

before(async () => {
  const { JSDOM } = require("jsdom");
  dom = new JSDOM(`<!doctype html><html><head><meta name="studio-protocol" content="${STUDIO_PROTOCOL_VERSION}"></head><body></body></html>`, { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of ["window", "self", "document", "navigator", "HTMLElement", "HTMLDialogElement", "Element", "Node", "MutationObserver", "getComputedStyle"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: class { addEventListener() {} removeEventListener() {} close() {} } });
  Object.defineProperty(globalThis, "scrollTo", { configurable: true, value: () => {} });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  require.extensions[".css"] = () => {};
  ui = require("@testing-library/react"); router = require("@tanstack/react-router"); query = require("@tanstack/react-query");
  ui.configure({ getElementError: message => new Error(message ?? "Element not found") });
  studio = await import("../src/studio"); dialogs = await import("../src/views/DraftControls");
  builder = new SnapshotBuilder(path.resolve(__dirname, "../.."));
  response = { snapshot: (await builder.refresh()).snapshot, evaluating: false, commands: {}, history: {}, busy: null };
});
afterEach(() => { ui.cleanup(); mock.restoreAll(); });
after(async () => { await builder?.dispose(); dom.window.close(); });

async function mount(Component: FunctionComponent = () => h("p", null, "Authentication test panel"), initial = "/cognito/user-pools", select: (id: string | undefined) => void = () => {}) {
  const previousContext = context;
  function Root() {
    return h(studio.StudioProvider, { response, selected: undefined, select, children: h(Capture) });
  }
  function Capture() { context = studio.useStudio(); return h("div", null, h(router.Outlet), h(dialogs.UnsavedChangesDialog)); }
  const root = router.createRootRoute({ component: Root });
  const parent = router.createRoute({ getParentRoute: () => root, path: "/cognito", component: Component });
  const children = ["user-pools", "identity-pools", "providers", "permissions"].map(path => router.createRoute({ getParentRoute: () => parent, path, component: () => null }));
  const outside = router.createRoute({ getParentRoute: () => root, path: "/deploy", component: () => h("p", null, "Other workspace") });
  const app = router.createRouter({ history: router.createMemoryHistory({ initialEntries: [initial] }), routeTree: root.addChildren([parent.addChildren(children), outside]) });
  queryClient = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  ui.render(h(query.QueryClientProvider, { client: queryClient }, h(router.RouterProvider, { router: app })));
  await ui.waitFor(() => assert.ok(context && context !== previousContext));
  return app;
}

test("shared draft survives Cognito routes and history while leaving workspace still requires an explicit decision", { timeout: 20_000 }, async () => {
  const app = await mount();
  ui.act(() => context.draft.beginCreation("auth-provider"));
  const entry = context.draft.creation();
  assert.ok(entry);
  ui.act(() => { void app.navigate({ to: "/cognito/providers" }); });
  await ui.waitFor(() => assert.equal(app.state.location.pathname, "/cognito/providers"));
  assert.equal(context.draft.creation(), entry);
  assert.ok(ui.screen.queryByRole("dialog", { name: "Unsaved changes" }) === null, "subsection navigation must retain the draft without a departure dialog");
  ui.act(() => { void app.navigate({ to: "/cognito/identity-pools" }); });
  await ui.waitFor(() => assert.equal(app.state.location.pathname, "/cognito/identity-pools"));
  ui.act(() => { app.history.back(); });
  await ui.waitFor(() => assert.equal(app.state.location.pathname, "/cognito/providers"));
  assert.equal(context.draft.creation(), entry);
  ui.act(() => { void app.navigate({ to: "/deploy" }); });
  await ui.screen.findByRole("dialog", { name: "Unsaved changes" });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Keep Editing" }));
  await ui.waitFor(() => assert.equal(context.draft.getSnapshot().pendingNavigation, false));
  assert.equal(app.state.location.pathname, "/cognito/providers");
  assert.equal(context.draft.creation(), entry);
});

for (const status of ["applied", "reverted"] as const) test(`${status} federation source keeps Providers open without selecting the returned secret`, async () => {
  const { api } = await import("../src/api");
  const selections: (string | undefined)[] = [];
  mock.method(api, "planBatch", async () => ({ planId: "qa-federation", ok: true, summaries: ["Create federation source"], changes: [], impact: [], preflight: { dev: { mode: "dev", ok: true, diagnostics: [] }, prod: { mode: "prod", ok: true, diagnostics: [] } } }));
  mock.method(api, "applyBatch", async () => ({ status, message: status === "applied" ? "Created federation source." : "Source did not match the reviewed result; draft retained.", revision: response.snapshot.revision, select: "resource:qaFederationClientSecret" }));
  mock.method(api, "snapshot", async () => response);
  const app = await mount(undefined, "/cognito/providers", id => selections.push(id));
  ui.act(() => {
    context.draft.beginCreation("auth-provider");
    context.draft.setCreation("auth-provider", { ...context.draft.creation()!.form, id: "qa-federation", description: "A reviewed federation provider" });
  });
  await ui.act(async () => { await context.draft.review(); });
  assert.ok(context.draft.getSnapshot().review?.plan.ok, `federation source must be reviewed before apply: ${context.draft.getSnapshot().error ?? context.draft.creation()?.error ?? "review unavailable"}`);
  await ui.act(async () => { await context.applyDraft(); });
  assert.equal(context.draft.dirty, status !== "applied");
  assert.equal(app.state.location.pathname, "/cognito/providers");
  assert.deepEqual(selections, status === "applied" ? [undefined] : [], "only a successful federation apply may clear selection; the returned secret must never open implicitly");
  assert.equal(context.created, undefined);
});

async function workspaceApi(policy = false, simulate?: () => Promise<Response>) {
  const policies: { sources: IdentityPolicySource[] } = { sources: policy ? [{ target: "resource:qaAccess", file: "cdk-app/lib/app/qa-access-stack.ts", statements: [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: ["arn:aws:s3:::qa-fixture/tenant/*"] }], allowUnauthenticated: false }] : [] };
  const workspace = await import("../src/views/AuthenticationWorkspace");
  const identity = await import("../src/views/IdentityWorkspace");
  const deploy = await import("../src/deploy/api");
  const management = await import("../src/views/CognitoManagement");
  mock.method(identity.identityApi, "source", async (mode: "dev" | "prod"): Promise<IdentitySource> => ({ mode, file: `cdk-app/.env.${mode}`, hash: `hash-${mode}`, exists: true, inputs: {}, google: { clientIdPresent: false, authoredSecretPresent: false }, providers: ["Google", "Oidc", "Saml"], declaredProviders: [], identityPools: "not-declared", problems: [] }));
  mock.method(deploy.deployApi, "preferences", async () => ({ profiles: {} }));
  mock.method(management.cognitoManagementApi, "history", async () => []);
  mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/identity-policy/sources")) return Response.json({ revision: response.snapshot.revision, sources: policies.sources });
    if (url.endsWith("/identity-policy/simulate") && simulate) return simulate();
    throw new Error(`Unexpected request in offline workspace test: ${url}`);
  });
  const overview = { targets: [{ name: "qa-dev", mode: "dev", origin: "personal", account: "111122223333", region: "us-east-1" }, { name: "qa-prod", mode: "prod", origin: "declared", account: "444455556666", region: "us-west-2" }], preferences: { profile: "dev", deployment: "qa-dev", profiles: { "qa-prod": "production-readonly" } }, profiles: [{ name: "dev", kind: "login", region: "us-east-1" }] } as unknown as DeployOverview;
  return { workspace, identity, deploy, overview, policies };
}

test("context controls wait for Deploy authority instead of silently replacing a profile typed during loading", async () => {
  const api = await workspaceApi();
  let resolve!: (overview: DeployOverview) => void;
  mock.method(api.deploy.deployApi, "overview", () => new Promise<DeployOverview>(done => { resolve = done; }));
  await mount(api.workspace.AuthenticationWorkspace);
  assert.equal((ui.screen.getByLabelText("Identity AWS profile") as HTMLInputElement).disabled, true);
  assert.equal((ui.screen.getByRole("button", { name: "Inspect authentication" }) as HTMLButtonElement).disabled, true);
  await ui.act(async () => resolve(api.overview));
  await ui.waitFor(() => assert.equal((ui.screen.getByLabelText("Identity AWS profile") as HTMLInputElement).value, "dev"));
  assert.equal((ui.screen.getByLabelText("Identity deployment") as HTMLSelectElement).value, "qa-dev");
  assert.equal((ui.screen.getByLabelText("Identity AWS region") as HTMLInputElement).readOnly, true);
});

test("source failures keep a local retry action across panels and recovery preserves entered values without inspecting AWS", async () => {
  const api = await workspaceApi();
  const source = await api.identity.identityApi.source("dev");
  let sourceReads = 0, inspections = 0;
  mock.method(api.deploy.deployApi, "overview", async () => api.overview);
  mock.method(api.identity.identityApi, "source", async () => {
    if (++sourceReads === 1) throw new Error("Studio returned an invalid API response. Reload the page and retry the operation.");
    return source;
  });
  mock.method(api.identity.identityApi, "inspect", async () => { inspections++; throw new Error("Unexpected AWS inspection"); });
  const app = await mount(api.workspace.AuthenticationWorkspace);
  const retry = await ui.screen.findByRole("button", { name: "Retry source" });
  assert.match(retry.closest('[role="alert"]')?.textContent ?? "", /Studio returned an invalid API response/);
  ui.fireEvent.change(ui.screen.getByLabelText("Search Cognito users"), { target: { value: "retained-search" } });
  ui.fireEvent.click(ui.within(ui.screen.getByRole("navigation", { name: "Cognito sections" })).getByRole("link", { name: "Identity Pools" }));
  await ui.waitFor(() => assert.equal(app.state.location.pathname, "/cognito/identity-pools"));
  assert.ok(ui.screen.getByRole("button", { name: "Create identity pool source", description: /Reviewed native source connects the application pool\/client/ }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Retry source" }));
  await ui.waitFor(() => assert.ok(ui.screen.queryByRole("button", { name: "Retry source" }) === null));
  assert.equal(sourceReads, 2);
  assert.equal(inspections, 0, "recovering a source read must not trigger a cloud inspection");
  ui.fireEvent.click(ui.within(ui.screen.getByRole("navigation", { name: "Cognito sections" })).getByRole("link", { name: "User Pools" }));
  await ui.waitFor(() => assert.equal((ui.screen.getByLabelText("Search Cognito users") as HTMLInputElement).value, "retained-search"));
});

test("source input context avoids duplicate paths while retaining custom-target mismatch evidence", async () => {
  const api = await workspaceApi();
  const standard = { ...api.overview, targets: api.overview.targets.map(target => target.mode === "dev" ? { ...target, inputs: "./cdk-app/.env.dev" } : target) };
  mock.method(api.deploy.deployApi, "overview", async () => standard);
  await mount(api.workspace.AuthenticationWorkspace);
  await ui.waitFor(() => assert.equal((ui.screen.getByLabelText("Identity deployment") as HTMLSelectElement).value, "qa-dev"));
  const provenance = ui.screen.getByText("Source inputs").parentElement!;
  assert.equal(provenance.querySelectorAll("code").length, 1, "the same normalized input path should be shown once");
  assert.doesNotMatch(provenance.textContent!, /Deployment inputs/);
  ui.act(() => queryClient.setQueryData(["deploy", "overview"], { ...standard, targets: standard.targets.map(target => target.mode === "dev" ? { ...target, inputs: "cdk-app/.env.qa" } : target) }));
  await ui.screen.findByText(/This deployment uses different inputs/);
  assert.match(provenance.textContent!, /Source inputs.*cdk-app\/\.env.dev.*Deployment inputs.*cdk-app\/\.env.qa/);
  assert.ok(ui.screen.getByText(/Retention editing is unavailable for this deployment’s custom inputs/));
});

test("local scoped-policy edits survive panel navigation, cannot follow a changed environment, and remain discardable", async () => {
  const api = await workspaceApi(true);
  mock.method(api.deploy.deployApi, "overview", async () => api.overview);
  const app = await mount(api.workspace.AuthenticationWorkspace, "/cognito/permissions");
  const resources = await ui.screen.findByLabelText("Policy resources 1") as HTMLTextAreaElement;
  ui.fireEvent.change(resources, { target: { value: "arn:aws:s3:::qa-fixture/tenant/narrow/*" } });
  ui.act(() => { void app.navigate({ to: "/cognito/providers" }); });
  await ui.waitFor(() => assert.equal(app.state.location.pathname, "/cognito/providers"));
  ui.act(() => { void app.navigate({ to: "/cognito/permissions" }); });
  await ui.waitFor(() => assert.equal(app.state.location.pathname, "/cognito/permissions"));
  assert.equal((ui.screen.getByLabelText("Policy resources 1") as HTMLTextAreaElement).value, "arn:aws:s3:::qa-fixture/tenant/narrow/*");
  ui.act(() => context.setMode("prod"));
  await ui.waitFor(() => assert.ok(ui.screen.getAllByRole("alert").some(element => /Unsaved policy edits belong to dev.*No proposal was transferred/.test(element.textContent!))));
  assert.equal((ui.screen.getByRole("button", { name: "Review reader policy source" }) as HTMLButtonElement).disabled, true);
  const discard = ui.screen.getByRole("button", { name: "Discard local policy edits" }) as HTMLButtonElement;
  assert.equal(discard.disabled, false);
  ui.fireEvent.click(discard);
  assert.equal((ui.screen.getByLabelText("Policy resources 1") as HTMLTextAreaElement).value, "arn:aws:s3:::qa-fixture/tenant/*");
  assert.equal(context.draft.dirty, false);
});

test("discarding rejected local policy edits clears validation errors and restores the saved source without a proposal", async () => {
  const api = await workspaceApi(true);
  mock.method(api.deploy.deployApi, "overview", async () => api.overview);
  const saved = JSON.stringify(api.policies.sources);
  await mount(api.workspace.AuthenticationWorkspace, "/cognito/permissions");
  const actions = await ui.screen.findByLabelText("Policy actions 1") as HTMLTextAreaElement;
  ui.fireEvent.change(actions, { target: { value: "s3:*" } });
  ui.fireEvent.change(ui.screen.getByLabelText("Policy resources 1"), { target: { value: "*" } });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review reader policy source" }));
  await ui.waitFor(() => assert.ok(ui.screen.queryAllByRole("alert").some(element => /Name concrete IAM actions without wildcards/.test(element.textContent!))));
  assert.equal(context.draft.dirty, false, "rejected policy must not become a source proposal");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Discard local policy edits" }));
  await ui.waitFor(() => assert.ok(!ui.screen.queryAllByRole("alert").some(element => /Name concrete IAM actions without wildcards/.test(element.textContent!)), "discard must clear the rejected edits' validation error"));
  assert.equal((ui.screen.getByLabelText("Policy actions 1") as HTMLTextAreaElement).value, "s3:GetObject");
  assert.equal((ui.screen.getByLabelText("Policy resources 1") as HTMLTextAreaElement).value, "arn:aws:s3:::qa-fixture/tenant/*");
  assert.equal(ui.screen.queryByRole("button", { name: "Discard local policy edits" }), null);
  assert.equal(context.draft.dirty, false);
  assert.equal(JSON.stringify(api.policies.sources), saved, "discard must preserve saved policy bytes rather than stage or apply a change");
});

test("leaving Cognito protects unproposed local policy edits and cancelled departure retains their exact values", async () => {
  const api = await workspaceApi(true);
  mock.method(api.deploy.deployApi, "overview", async () => api.overview);
  const app = await mount(api.workspace.AuthenticationWorkspace, "/cognito/permissions");
  const actions = await ui.screen.findByLabelText("Policy actions 1");
  ui.fireEvent.change(actions, { target: { value: "s3:GetObject\ns3:GetObjectVersion" } });
  ui.act(() => { void app.navigate({ to: "/deploy" }); });
  const departure = await ui.screen.findByRole("dialog", { name: "Unsaved policy edits" });
  ui.fireEvent.click(ui.within(departure).getByRole("button", { name: "Keep editing policy" }));
  await ui.waitFor(() => assert.ok(ui.screen.queryByRole("dialog", { name: "Unsaved policy edits" }) === null, "cancelled departure must dismiss the policy dialog"));
  assert.equal(app.state.location.pathname, "/cognito/permissions");
  assert.equal((actions as HTMLTextAreaElement).value, "s3:GetObject\ns3:GetObjectVersion");
});

for (const surviving of [false, true]) test(`discard recovers removed policy source with ${surviving ? "a surviving stack" : "no remaining stacks"}`, async () => {
  const api = await workspaceApi(true);
  mock.method(api.deploy.deployApi, "overview", async () => api.overview);
  await mount(api.workspace.AuthenticationWorkspace, "/cognito/permissions");
  const resources = await ui.screen.findByLabelText("Policy resources 1") as HTMLTextAreaElement;
  ui.fireEvent.change(resources, { target: { value: "arn:aws:s3:::qa-fixture/tenant/narrow/*" } });
  api.policies.sources = surviving ? [{ ...api.policies.sources[0]!, target: "resource:otherAccess", file: "cdk-app/lib/app/other-access-stack.ts" }] : [];
  await ui.act(async () => { await queryClient.invalidateQueries({ queryKey: ["identity-policy"] }); });
  await ui.waitFor(() => assert.ok(ui.screen.queryAllByRole("alert").some(element => /Saved policy source changed while local edits were open/.test(element.textContent!)), "source removal must retain unsaved values behind an explicit mismatch warning"));
  if (surviving) assert.equal(resources.value, "arn:aws:s3:::qa-fixture/tenant/narrow/*");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Discard local policy edits" }));
  await ui.waitFor(() => assert.ok(!ui.screen.queryAllByRole("alert").some(element => /Saved policy source changed/.test(element.textContent!))));
  assert.ok(ui.screen.queryByRole("button", { name: "Discard local policy edits" }) === null, "discard must clear all local edits");
  if (surviving) {
    assert.equal((ui.screen.getByLabelText("Identity policy stack") as HTMLSelectElement).value, "resource:otherAccess");
    assert.equal((ui.screen.getByLabelText("Policy resources 1") as HTMLTextAreaElement).value, "arn:aws:s3:::qa-fixture/tenant/*");
  } else assert.match(document.body.textContent!, /No editable generated identity-pool stack was found/);
  assert.equal(context.draft.dirty, false);
});

test("a delayed policy simulation never appears under another profile or an inactive panel", async () => {
  let resolve!: (response: Response) => void;
  const api = await workspaceApi(true, () => new Promise<Response>(done => { resolve = done; }));
  mock.method(api.deploy.deployApi, "overview", async () => api.overview);
  const app = await mount(api.workspace.AuthenticationWorkspace, "/cognito/permissions");
  const details = (await ui.screen.findByText("Simulate saved policy (read-only AWS IAM)")).closest("details")!;
  ui.fireEvent.click(details.querySelector("summary")!);
  const simulate = await ui.screen.findByRole("button", { name: "Simulate saved policy" });
  await ui.waitFor(() => assert.equal((simulate as HTMLButtonElement).disabled, false));
  ui.fireEvent.click(simulate);
  ui.fireEvent.change(ui.screen.getByLabelText("Identity AWS profile"), { target: { value: "other-profile" } });
  ui.act(() => { void app.navigate({ to: "/cognito/providers" }); });
  await ui.act(async () => resolve(Response.json({ engine: "aws-iam", profile: "dev", account: "111122223333", region: "us-east-1", role: "reader", observedAt: "2026-10-23T00:00:00Z", results: [{ action: "s3:GetObject", resource: "arn:aws:s3:::qa-fixture/tenant/example.json", decision: "allowed", missingContext: [] }], limitations: ["late-simulation-sentinel"] })));
  ui.act(() => { void app.navigate({ to: "/cognito/permissions" }); });
  await ui.waitFor(() => assert.equal(app.state.location.pathname, "/cognito/permissions"));
  assert.doesNotMatch(document.body.textContent!, /late-simulation-sentinel/);
});

for (const failure of [new Error("Credentials expired. Sign in to profile dev and retry."), new TypeError("Failed to fetch")]) test(`partial inspection notes and ${failure instanceof TypeError ? "connection" : "server"} errors retain evidence across panels without claiming sign-in`, async () => {
  const api = await workspaceApi();
  mock.method(api.deploy.deployApi, "overview", async () => api.overview);
  let fail = false;
  const inspections = mock.method(api.identity.identityApi, "inspect", async (kind: string): Promise<CognitoObservation | IdentityPoolsObservation> => {
    if (fail) throw failure;
    const context = { profile: "dev", deployment: "qa-dev", region: "us-east-1", account: "111122223333", observedAt: "2020-01-01T00:00:00Z" };
    return kind === "cognito" ? { context, poolId: "fixture-pool", pool: { name: "Observed QA pool" }, clients: [], providers: [], groups: [], users: [], warnings: ["Provider details could not be read; this is partial metadata."] } : { context, pools: [], warnings: ["Role mappings unverified."] };
  });
  const app = await mount(api.workspace.AuthenticationWorkspace);
  const inspect = await ui.screen.findByRole("button", { name: "Inspect authentication" });
  await ui.waitFor(() => assert.equal((inspect as HTMLButtonElement).disabled, false));
  ui.fireEvent.click(inspect);
  await ui.screen.findByRole("heading", { name: "Observed QA pool" });
  assert.match(document.body.textContent!, /Inspection is more than five minutes old/);
  assert.match(document.body.textContent!, /Provider details could not be read/);
  assert.match(document.body.textContent!, /Sign-in \/ effective access.*Unverified/);
  ui.act(() => { void app.navigate({ to: "/cognito/providers" }); });
  await ui.waitFor(() => assert.equal(app.state.location.pathname, "/cognito/providers"));
  assert.equal(ui.screen.getByRole("navigation", { name: "Cognito sections" }).querySelector('[aria-current="page"]')?.textContent, "Providers");
  fail = true;
  ui.fireEvent.click(inspect);
  await ui.waitFor(() => assert.ok(ui.screen.getAllByRole("alert").some(element => element.textContent?.includes(failure.message) && /Previous metadata remains visible/.test(element.textContent))));
  assert.equal(inspections.mock.callCount(), 4, "a failed inspection must not automatically retry either read");
  if (failure instanceof TypeError) {
    const alert = ui.screen.getAllByRole("alert").find(element => element.textContent?.includes("Failed to fetch"))!;
    assert.match(alert.textContent!, /Check the Studio connection, then retry inspection/);
    assert.doesNotMatch(alert.textContent!, /credentials/i, "offline transport failures must not blame AWS credentials");
  }
  ui.act(() => { void app.navigate({ to: "/cognito/user-pools" }); });
  await ui.screen.findByRole("heading", { name: "Observed QA pool" });
  fail = false;
  ui.fireEvent.click(inspect);
  await ui.waitFor(() => assert.ok(!ui.screen.queryAllByRole("alert").some(element => element.textContent?.includes(failure.message))));
  assert.equal(inspections.mock.callCount(), 6, "only the explicit retry may start another pair of AWS reads");
});

test("changing environment keeps the source draft in its original target until explicitly discarded", async () => {
  await mount();
  ui.act(() => context.draft.beginCreation("stack"));
  const entry = context.draft.creation();
  ui.act(() => context.setMode("prod"));
  await ui.screen.findByRole("dialog", { name: "Unsaved changes" });
  assert.equal(context.mode, "dev");
  assert.equal(context.draft.creation(), entry);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Keep Editing" }));
  assert.equal(context.mode, "dev");
  ui.act(() => context.setMode("prod"));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Discard and Continue" }));
  await ui.waitFor(() => assert.equal(context.mode, "prod"));
  assert.equal(context.draft.dirty, false);
});
