import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { after, afterEach, before, mock, test } from "node:test";
import { createElement as h } from "react";
import type { SnapshotResponse } from "../shared/api";
import type { DeployOverview } from "../shared/deploy";
import type { DomainsObservation, IdentitySource } from "../shared/identity";
import { STUDIO_PROTOCOL_VERSION } from "../shared/protocol";
import { SnapshotBuilder } from "../server/snapshot";

const require = createRequire(import.meta.url);
let dom: { window: Window & typeof globalThis };
let ui: typeof import("@testing-library/react");
let router: typeof import("@tanstack/react-router");
let query: typeof import("@tanstack/react-query");
let studio: typeof import("../src/studio");
let view: typeof import("../src/views/IdentityWorkspace");
let deploy: typeof import("../src/deploy/api");
let builder: SnapshotBuilder;
let response: SnapshotResponse;
let context: ReturnType<typeof import("../src/studio").useStudio>;
let queryClient: import("@tanstack/react-query").QueryClient;

const source: IdentitySource = {
  mode: "prod", file: "cdk-app/.env.prod", hash: "production-domain-source", exists: true,
  inputs: { USE_COGNITO_CUSTOM_DOMAIN: "false", USE_FRONTEND_CUSTOM_DOMAIN: "false" },
  google: { clientIdPresent: false, authoredSecretPresent: false },
  providers: [], declaredProviders: [], identityPools: "not-declared", problems: [],
};
const overview = {
  targets: [
    { name: "qa-dev", mode: "dev", origin: "personal", account: "111122223333", region: "us-east-1" },
    { name: "qa-prod", mode: "prod", origin: "declared", account: "444455556666", region: "us-west-2" },
  ],
  preferences: { profile: "dev", deployment: "qa-dev", profiles: {} },
  profiles: [{ name: "dev", kind: "login", region: "us-east-1" }],
} as unknown as DeployOverview;

before(async () => {
  const { JSDOM } = require("jsdom");
  dom = new JSDOM(`<!doctype html><html><head><meta name="studio-protocol" content="${STUDIO_PROTOCOL_VERSION}"></head><body></body></html>`, { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of ["window", "self", "document", "navigator", "HTMLElement", "HTMLDialogElement", "Element", "Node", "MutationObserver", "getComputedStyle"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: class { addEventListener() {} removeEventListener() {} close() {} } });
  Object.defineProperty(globalThis, "scrollTo", { configurable: true, value: () => {} });
  require.extensions[".css"] = () => {};
  ui = require("@testing-library/react"); router = require("@tanstack/react-router"); query = require("@tanstack/react-query");
  ui.configure({ getElementError: message => new Error(message ?? "Element not found") });
  studio = await import("../src/studio"); view = await import("../src/views/IdentityWorkspace"); deploy = await import("../src/deploy/api");
  builder = new SnapshotBuilder(path.resolve(__dirname, "../.."));
  response = { snapshot: (await builder.refresh()).snapshot, evaluating: false, commands: {}, history: {}, busy: null };
});
afterEach(() => { ui.cleanup(); queryClient?.clear(); mock.restoreAll(); });
after(async () => { await builder?.dispose(); dom.window.close(); });

async function mount() {
  const previousContext = context;
  function Root() { return h(studio.StudioProvider, { response, selected: undefined, select: () => {}, children: h(Capture) }); }
  function Capture() { context = studio.useStudio(); return h(router.Outlet); }
  const root = router.createRootRoute({ component: Root });
  const domains = router.createRoute({ getParentRoute: () => root, path: "/domains", component: view.Domains });
  const app = router.createRouter({ history: router.createMemoryHistory({ initialEntries: ["/domains"] }), routeTree: root.addChildren([domains]) });
  queryClient = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  ui.render(h(query.QueryClientProvider, { client: queryClient }, h(router.RouterProvider, { router: app })));
  await ui.waitFor(() => assert.ok(context && context !== previousContext));
}

function forbidOperations() {
  const inspect = mock.method(view.identityApi, "inspect", async () => { throw new Error("Inspection must require an explicit action."); });
  const requests: { url: string; method?: string }[] = [];
  mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    requests.push({ url, method: init?.method });
    if (url === "/api/identity/domain-dns/history" && init?.method === "GET") return Response.json([]);
    throw new Error(`Unexpected request in offline Domains test: ${init?.method} ${url}`);
  });
  return () => {
    assert.equal(inspect.mock.callCount(), 0, "mounting or retrying local reads must not inspect AWS");
    assert.ok(requests.every(request => request.url === "/api/identity/domain-dns/history" && request.method === "GET"), "only the local saved-receipt history may load automatically; no live probes or source/DNS mutations");
  };
}

test("Domains preserves source failure detail and retries production source without inspecting or mutating AWS", async () => {
  const assertNoOperations = forbidOperations();
  const failure = "Studio returned an invalid API response. Restart npm run studio in this checkout, reload the page, and retry the operation.";
  const modes: string[] = [];
  let resolve!: (value: IdentitySource) => void;
  mock.method(view.identityApi, "source", async (mode: "dev" | "prod") => {
    modes.push(mode);
    if (modes.length === 1) throw new Error(failure);
    return new Promise<IdentitySource>(done => { resolve = done; });
  });
  const overviewRead = mock.method(deploy.deployApi, "overview", async () => overview);
  await mount();
  const retry = await ui.screen.findByRole("button", { name: "Retry source" }) as HTMLButtonElement;
  assert.ok(ui.screen.getAllByRole("alert").some(alert => alert.textContent?.includes(failure)), "the source error must keep its actionable server detail");
  assert.equal(context.mode, "dev", "Domains must select production inputs independently of the graph environment");
  assert.deepEqual(modes, ["prod"]);
  assert.equal(ui.screen.queryByRole("heading", { name: "Production domain intent" }), null);
  assertNoOperations();

  ui.fireEvent.click(retry);
  await ui.waitFor(() => {
    const pendingRetry = ui.screen.queryByRole("button", { name: "Retry source" }) as HTMLButtonElement | null;
    assert.ok(!pendingRetry || pendingRetry.disabled, "a pending source read must not expose another enabled retry");
  });
  assert.ok(ui.screen.getAllByRole("status").some(status => status.textContent?.includes("Loading source declaration")), "source retry must communicate pending progress");
  assert.deepEqual(modes, ["prod", "prod"], "the pending retry must not issue duplicate source reads");
  await ui.act(async () => resolve(source));
  await ui.screen.findByRole("heading", { name: "Production domain intent" });
  assert.equal(ui.screen.queryByRole("button", { name: "Retry source" }), null);
  assert.ok(!ui.screen.queryAllByRole("alert").some(alert => alert.textContent?.includes(failure)));
  assert.equal((ui.screen.getByLabelText("Identity deployment") as HTMLSelectElement).value, "qa-prod");
  assert.equal(overviewRead.mock.callCount(), 1, "source retry must leave successful deployment discovery alone");
  assert.equal(context.draft.dirty, false);
  assertNoOperations();
});

test("Domains recovers deployment discovery independently while keeping available production source visible", async () => {
  const assertNoOperations = forbidOperations();
  const sourceRead = mock.method(view.identityApi, "source", async () => source);
  const failure = "Deployment configuration could not be read. Fix cdk-app/cdk.json and retry.";
  let attempts = 0;
  let resolve!: (value: DeployOverview) => void;
  mock.method(deploy.deployApi, "overview", async () => {
    if (++attempts === 1) throw new Error(failure);
    return new Promise<DeployOverview>(done => { resolve = done; });
  });
  await mount();
  const retry = await ui.screen.findByRole("button", { name: "Retry deployments" }) as HTMLButtonElement;
  await ui.screen.findByRole("heading", { name: "Production domain intent" });
  assert.ok(ui.screen.getAllByRole("alert").some(alert => alert.textContent?.includes(failure)));
  assert.equal(ui.screen.queryByRole("button", { name: "Retry source" }), null);
  const inspect = ui.screen.getByRole("button", { name: "Inspect deployed settings" }) as HTMLButtonElement;
  assert.equal(inspect.disabled, true, "inspection needs a declared deployment");
  assertNoOperations();

  ui.fireEvent.click(retry);
  await ui.waitFor(() => {
    const pendingRetry = ui.screen.queryByRole("button", { name: "Retry deployments" }) as HTMLButtonElement | null;
    assert.ok(!pendingRetry || pendingRetry.disabled, "pending deployment discovery must not expose another enabled retry");
  });
  assert.ok(ui.screen.getAllByRole("status").some(status => status.textContent?.includes("Loading deployment context")), "deployment retry must communicate pending progress");
  assert.equal(attempts, 2, "the pending retry must not issue duplicate deployment reads");
  await ui.act(async () => resolve(overview));
  await ui.waitFor(() => assert.equal(inspect.disabled, false));
  assert.equal(ui.screen.queryByRole("button", { name: "Retry deployments" }), null);
  assert.ok(!ui.screen.queryAllByRole("alert").some(alert => alert.textContent?.includes(failure)));
  assert.equal((ui.screen.getByLabelText("Identity deployment") as HTMLSelectElement).value, "qa-prod");
  assert.equal((ui.screen.getByLabelText("Identity AWS region") as HTMLInputElement).value, "us-west-2");
  assert.equal(sourceRead.mock.callCount(), 1, "deployment retry must preserve available production inputs");
  assert.equal(sourceRead.mock.calls[0]?.arguments[0], "prod");
  assert.equal(context.draft.dirty, false);
  assertNoOperations();
});

test("Domains transport failures explain connection recovery, retain prior evidence and retry only on inspection", async () => {
  mock.method(view.identityApi, "source", async () => source);
  mock.method(deploy.deployApi, "overview", async () => overview);
  const observation: DomainsObservation = {
    context: { profile: "dev", deployment: "qa-prod", region: "us-west-2", account: "444455556666", observedAt: "2026-10-23T12:00:00Z" },
    certificates: [], dns: [], records: [], health: [], warnings: [],
  };
  let offline = false;
  const inspections: { url: string; method?: string }[] = [];
  mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (url === "/api/identity/domain-dns/history" && init?.method === "GET") return Response.json([]);
    assert.ok(url.startsWith("/api/identity/domains?"), `unexpected request: ${url}`);
    inspections.push({ url, method: init?.method });
    if (offline) throw new TypeError("Failed to fetch");
    return Response.json(observation);
  });
  await mount();
  const inspect = await ui.screen.findByRole("button", { name: "Inspect deployed settings" }) as HTMLButtonElement;
  await ui.waitFor(() => assert.equal(inspect.disabled, false));
  assert.equal(inspections.length, 0, "mounting must not inspect AWS");
  ui.fireEvent.click(inspect);
  const observed = await ui.screen.findByText(/Observed 2026-10-23T12:00:00Z/);
  offline = true;
  ui.fireEvent.click(inspect);
  await ui.waitFor(() => assert.ok(ui.screen.queryAllByRole("alert").some(alert => alert.textContent?.includes("Check the Studio connection, then retry inspection"))));
  const alert = ui.screen.getAllByRole("alert").find(element => element.textContent?.includes("Failed to fetch"))!;
  assert.doesNotMatch(alert.textContent!, /credentials/i);
  assert.equal(inspections.length, 2, "transport failure must not automatically retry a read");
  assert.ok(observed.isConnected, "previous destination-bound metadata must remain visible");
  assert.equal((ui.screen.getByLabelText("Identity deployment") as HTMLSelectElement).value, "qa-prod");
  assert.equal((ui.screen.getByLabelText("Identity AWS region") as HTMLInputElement).value, "us-west-2");
  assert.ok(ui.screen.getByRole("heading", { name: "Production domain intent" }), "inspection failure must preserve source intent");

  offline = false;
  await ui.waitFor(() => assert.equal(inspect.disabled, false));
  ui.fireEvent.click(inspect);
  await ui.waitFor(() => assert.ok(!ui.screen.queryAllByRole("alert").some(element => element.textContent?.includes("Failed to fetch"))));
  assert.equal(inspections.length, 3);
  assert.ok(inspections.every(request => request.method === "GET"), "recovery must issue read-only requests");
  assert.equal(context.draft.dirty, false);
});
