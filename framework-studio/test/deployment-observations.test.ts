import assert from "./support/assert";
import { after, afterEach, before, test } from "node:test";
import { createRequire } from "node:module";
import { createElement as h } from "react";
import { resolveDeploymentTarget, type DeploymentScope } from "../src/deploy/context";
import { snapshot, overview, discovery } from "./browser/support/scenarios";
import { connectionCatalogFixture } from "./browser/support/aws-connections";

const repository = { repository: "/studio-fixture", sourceRevision: "source-1" };
const scope: DeploymentScope = { ...repository, mode: "dev", profile: "dev", generation: "0:0", deployment: "browser-dev" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("target resolution never borrows a remembered target from another declaration mode", () => {
  const metadata = overview();
  const staging = { name: "staging", mode: "prod" as const, origin: "declared" as const, account: "123456789012", region: "us-west-2" };
  const data = { ...metadata, targets: [...metadata.targets, staging], preferences: { profiles: { staging: "dev" }, deployment: staging.name } };
  assert.equal(resolveDeploymentTarget("dev", data)?.name, "browser-dev");
  assert.deepEqual(resolveDeploymentTarget("prod", data), staging);
  assert.equal(resolveDeploymentTarget("prod", { ...data, targets: metadata.targets.filter(target => target.mode === "dev") }), undefined);
  assert.equal(resolveDeploymentTarget("dev", undefined), undefined);
});

let dom: { window: Window & typeof globalThis };
let query: typeof import("@tanstack/react-query");
let queries: typeof import("../src/deploy/queries");
let observations: typeof import("../src/deploy/observations");
let live: typeof import("../src/deploy/live");
let ui: typeof import("@testing-library/react");
let studio: typeof import("../src/studio");
let router: typeof import("@tanstack/react-router");
const clients: import("@tanstack/react-query").QueryClient[] = [];
let handler: (url: URL) => Promise<unknown> | unknown;
const requests: string[] = [];

before(async () => {
  const require = createRequire(import.meta.url);
  const { JSDOM } = require("jsdom");
  dom = new JSDOM('<!doctype html><html><head><meta name="studio-token" content="fixture"></head><body></body></html>', { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of ["window", "self", "document", "navigator", "HTMLElement", "Node", "MutationObserver", "getComputedStyle"] as const)
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  Object.defineProperty(globalThis, "scrollTo", { configurable: true, value: () => {} });
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: class extends EventTarget { close() {} } });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: string) => {
    const url = new URL(input, "http://localhost"); requests.push(url.pathname + url.search);
    return new Response(JSON.stringify(await handler(url)), { status: 200 });
  } });
  query = require("@tanstack/react-query");
  router = require("@tanstack/react-router");
  ui = require("@testing-library/react");
  queries = await import("../src/deploy/queries");
  observations = await import("../src/deploy/observations");
  live = await import("../src/deploy/live");
  studio = await import("../src/studio");
});
afterEach(() => { ui.cleanup(); clients.splice(0).forEach(client => client.clear()); dom.window.localStorage.clear(); requests.length = 0; });
after(() => dom.window.close());
function client() {
  const value = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(value); return value;
}
function mount(associations: { dev?: string; prod?: string }) {
  const response = snapshot();
  dom.window.localStorage.setItem(`aws-studio:mode-profiles:v1:${response.snapshot.repositoryRoot}`, JSON.stringify(associations));
  function Root() {
    return h(studio.StudioProvider, { response, selected: undefined, select: () => {}, children: h("div", null,
      h(observations.GlobalDeploymentObservations), h("p", null, "Source workspace")) });
  }
  const root = router.createRootRoute({ component: Root });
  const app = router.createRouter({ history: router.createMemoryHistory({ initialEntries: ["/"] }), routeTree: root.addChildren([router.createRoute({ getParentRoute: () => root, path: "/", component: () => null })]) });
  ui.render(h(query.QueryClientProvider, { client: client() }, h(router.RouterProvider, { router: app })));
}
function fixtures(url: URL): unknown {
  if (url.pathname === "/api/deploy/overview") return overview();
  if (url.pathname === "/api/aws-connections") return connectionCatalogFixture();
  if (url.pathname === "/api/deploy/status") return { ok: true, value: { ...discovery(), context: { ...discovery().context, profile: url.searchParams.get("profile"), region: url.searchParams.get("region") ?? "us-east-1" }, deployment: url.searchParams.get("deployment") } };
  throw new Error(`Unexpected request: ${url.pathname}`);
}

test("a source workspace warms configured modes without redundant discovery or operations", async () => {
  handler = fixtures;
  mount({ dev: "dev", prod: "production" });
  await ui.screen.findByText("Source workspace");
  await ui.waitFor(() => assert.equal(requests.filter(path => path.startsWith("/api/deploy/status?")).length, 2));
  assert.equal(requests.some(path => /deploy\/(discover|operations)/.test(path)), false);
  assert.ok(requests.some(path => path.includes("profile=production") && path.includes("deployment=browser-prod")));
});

test("modes sharing a profile and no target share one account discovery", async () => {
  handler = url => {
    if (url.pathname === "/api/deploy/overview") return { ...overview(), targets: [] };
    if (url.pathname === "/api/deploy/discover") return { ok: true, value: { ...discovery(), context: { ...discovery().context, profile: url.searchParams.get("profile") } } };
    return fixtures(url);
  };
  mount({ dev: "dev", prod: "dev" });
  await ui.screen.findByText("Source workspace");
  await ui.waitFor(() => assert.equal(requests.filter(path => path.startsWith("/api/deploy/discover?")).length, 1));
  await ui.act(async () => { await new Promise(done => setTimeout(done, 30)); });
  assert.equal(requests.filter(path => path.startsWith("/api/deploy/discover?")).length, 1);
  assert.equal(requests.some(path => path.startsWith("/api/deploy/status?")), false);
});

test("no associations, unavailable profiles and catalog failure do not start deployment reads", async () => {
  for (const scenario of ["missing", "unavailable", "catalog-error"] as const) {
    handler = url => url.pathname === "/api/aws-connections" && scenario === "catalog-error" ? Promise.reject(new Error("Catalog unavailable")) : fixtures(url);
    mount(scenario === "missing" ? {} : { dev: "gone" });
    await ui.screen.findByText("Source workspace");
    await ui.waitFor(() => assert.ok(requests.some(path => path === "/api/aws-connections")));
    await ui.act(async () => { await new Promise(done => setTimeout(done, 20)); });
    assert.equal(requests.some(path => /deploy\/(?:status|discover)/.test(path)), false);
    ui.cleanup(); clients.splice(0).forEach(value => value.clear()); requests.length = 0;
  }
});

test("the deployment queue reserves at most two slots and removes aborted waiters", async () => {
  const queue = new queries.DeploymentReadQueue();
  const first = deferred<void>(), second = deferred<void>();
  let running = 0, maximum = 0, calls = 0;
  const read = async (wait: Promise<void>) => { calls++; running++; maximum = Math.max(maximum, running); await wait; running--; };
  const a = queue.run(() => read(first.promise));
  const b = queue.run(() => read(second.promise));
  const controller = new AbortController();
  const canceled = queue.run(() => read(Promise.resolve()), controller.signal).catch(error => error);
  const c = queue.run(() => read(Promise.resolve()));
  controller.abort();
  await canceled;
  first.resolve();
  const d = queue.run(() => read(Promise.resolve()));
  second.resolve();
  await Promise.all([a, b, c, d]);
  assert.equal(maximum, 2); assert.equal(calls, 4);
});

test("typed AWS refresh failures retain the previous success for the exact Query identity", async () => {
  const cache = client();
  let failed = false;
  handler = url => failed ? { ok: false, problem: { kind: "expired", message: "Sign in again" } } : fixtures(url);
  const options = queries.deploymentStatusQuery(scope);
  const good = await cache.fetchQuery(options);
  failed = true;
  await assert.rejects(cache.fetchQuery({ ...queries.deploymentStatusQuery(scope, true), staleTime: 0 }), error => error instanceof queries.AwsReadError && error.problem.kind === "expired");
  assert.deepEqual(cache.getQueryData(options.queryKey), good);
  assert.equal(cache.getQueryState(options.queryKey)?.status, "error");
});

test("late responses stay under their original generation and cannot replace a new actor's evidence", async () => {
  const cache = client(), old = deferred<unknown>();
  handler = url => url.searchParams.has("force") ? fixtures(url) : old.promise;
  const previous = cache.fetchQuery(queries.deploymentStatusQuery(scope));
  const nextScope = { ...scope, generation: "0:1" };
  const next = await cache.fetchQuery(queries.deploymentStatusQuery(nextScope, true));
  old.resolve({ ok: true, value: { ...(next as object), context: { ...discovery().context, profile: "dev", account: "999999999999" } } });
  await previous;
  assert.deepEqual(cache.getQueryData(queries.deploymentStatusQuery(nextScope).queryKey), next);
  assert.equal(cache.getQueryData(queries.deploymentStatusQuery(scope).queryKey)?.context.account, "999999999999");
});

test("invalidation received during a pending read coalesces one trailing reconciliation", async () => {
  const cache = client(), pending = deferred<number>();
  let calls = 0;
  const observer = new query.QueryObserver(cache, { queryKey: ["deploy", "test-trailing"], queryFn: () => ++calls === 1 ? pending.promise : Promise.resolve(calls), retry: false });
  const unsubscribe = observer.subscribe(() => {});
  await ui.waitFor(() => assert.equal(calls, 1));
  live.invalidateDeploymentQueries(cache);
  live.invalidateDeploymentQueries(cache);
  pending.resolve(1);
  await ui.waitFor(() => assert.equal(calls, 2));
  assert.equal(cache.getQueryData(["deploy", "test-trailing"]), 2);
  unsubscribe(); observer.destroy();
});

test("mode, destination, credentials and source all participate in status identity", () => {
  const original = JSON.stringify(queries.deploymentStatusQuery(scope).queryKey);
  for (const change of [{ mode: "prod" as const }, { profile: "production" }, { generation: "1:0" }, { deployment: "staging" }, { account: "123456789012" }, { region: "us-west-2" }, { sourceRevision: "source-2" }])
    assert.notEqual(JSON.stringify(queries.deploymentStatusQuery({ ...scope, ...change }).queryKey), original);
  assert.equal(observations.deploymentPollInterval(true, false, false), 120_000);
  assert.equal(observations.deploymentPollInterval(false, false, false), 300_000);
  assert.equal(observations.deploymentPollInterval(false, false, true), 4000);
  assert.equal(observations.deploymentPollInterval(true, true, true), 300_000);
});
