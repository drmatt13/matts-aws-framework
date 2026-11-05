import assert from "./support/assert";
import { before, after, afterEach, test } from "node:test";
import { createRequire } from "node:module";
import { createElement as h } from "react";
import type { StackInspectionScope } from "../src/deploy/stack-inspection";
import { STUDIO_PROTOCOL_VERSION } from "../shared/protocol";
import { STACK_ACCOUNT, STACK_ID, STACK_NAME, inspectionFixtures, inspectedDeployment } from "./browser/support/stack-inspection";

let dom: { window: Window & typeof globalThis };
let ui: typeof import("@testing-library/react");
let query: typeof import("@tanstack/react-query");
let adapter: typeof import("../src/deploy/stack-inspection");
let detail: typeof import("../src/views/deploy/Detail");
const clients: import("@tanstack/react-query").QueryClient[] = [];
let requests: URL[] = [];
let answer: (url: URL, signal?: AbortSignal | null) => unknown | Promise<unknown>;
const scope: StackInspectionScope = { repository: "/fixture/repository", sourceRevision: "source-1", generation: "credentials-1",
  profile: "fixture-dev", deployment: "browser-dev", mode: "dev", account: STACK_ACCOUNT, region: "us-east-1", stack: STACK_NAME };

before(async () => {
  const require = createRequire(import.meta.url);
  const { JSDOM } = require("jsdom");
  dom = new JSDOM(`<!doctype html><html><head><meta name="studio-token" content="fixture"><meta name="studio-protocol" content="${STUDIO_PROTOCOL_VERSION}"></head><body></body></html>`, { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of ["window", "self", "document", "navigator", "HTMLElement", "Node", "MutationObserver", "getComputedStyle"] as const)
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://localhost");
    requests.push(url);
    assert.equal(init?.method, "GET", "stack inspection never creates an operation");
    const value = await answer(url, init?.signal);
    return new Response(JSON.stringify(value));
  } });
  ui = require("@testing-library/react");
  query = require("@tanstack/react-query");
  adapter = await import("../src/deploy/stack-inspection");
  detail = await import("../src/views/deploy/Detail");
});
afterEach(async () => { ui.cleanup(); for (const client of clients.splice(0)) { await client.cancelQueries(); client.clear(); } requests = []; });
after(() => dom.window.close());

test("stack reads encode and bind the destination, immutable ID and signed page cursor", async () => {
  const fixtures = inspectionFixtures();
  answer = () => ({ ok: true, value: fixtures.resources });
  const abort = new AbortController();
  await adapter.inspectStack(scope, "resources", { stackId: STACK_ID, cursor: "page+/=?cursor" }, abort.signal);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.pathname, "/api/deploy/stack");
  for (const key of ["profile", "deployment", "mode", "account", "region", "stack"] as const)
    assert.equal(requests[0]!.searchParams.get(key), scope[key]);
  assert.equal(requests[0]!.searchParams.get("stackId"), STACK_ID);
  assert.equal(requests[0]!.searchParams.get("cursor"), "page+/=?cursor");
  answer = () => ({ ok: true, value: { ...fixtures.resources, stackId: `${STACK_ID}-recreated` } });
  await assert.rejects(adapter.inspectStack(scope, "resources", { stackId: STACK_ID }), /another stack/);
});

test("stack cache identity separates credentials, repository, mode, profile, account, region and source", () => {
  const key = JSON.stringify(adapter.stackInspectionKey(scope, "overview"));
  for (const change of [{ generation: "credentials-2" }, { repository: "/another" }, { mode: "prod" as const },
    { profile: "fixture-prod" }, { account: "999999999999" }, { region: "us-west-2" }, { sourceRevision: "source-2" },
    { deployment: "another-dev" }, { stack: "another-stack" }])
    assert.notEqual(JSON.stringify(adapter.stackInspectionKey({ ...scope, ...change }, "overview")), key);
});

test("deployed rows stay lazy and a credential change closes pending stack evidence", async () => {
  const fixture = inspectionFixtures();
  let release: ((value: unknown) => void) | undefined;
  let firstSignal: AbortSignal | null | undefined;
  answer = (_url, signal) => { firstSignal = signal; return new Promise(resolve => { release = resolve; }); };
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const deployment = inspectedDeployment();
  function page(generation: string, sourceRevision = scope.sourceRevision) {
    return h(query.QueryClientProvider, { client }, h(detail.Detail, {
      row: { name: "browser-dev", mode: "dev", section: "repository", deployment },
      context: { profile: scope.profile, account: scope.account, region: scope.region, arn: "arn:aws:iam::123456789012:role/fixture" },
      findings: [{ code: "DEPLOYED", scope: "aws", severity: "info", title: "Deployed · 5 stacks", actions: [] }],
      awsKnown: true, events: [], onAction: () => assert.fail("read-only inspection must not start an operation"),
      inspectionScope: { ...scope, generation, sourceRevision },
    }));
  }
  const rendered = ui.render(page("credentials-1"));
  assert.equal(requests.length, 0);
  (ui.screen.getByRole("group", { name: "Deployed deployment" }) as HTMLDetailsElement).open = true;
  ui.fireEvent.click(ui.screen.getByRole("button", { name: `Inspect ${STACK_NAME}` }));
  await ui.waitFor(() => assert.equal(requests.length, 1));
  assert.ok(ui.screen.getByRole("dialog", { name: `Stack details · ${STACK_NAME}` }));
  rendered.rerender(page("credentials-2"));
  assert.equal(Boolean(ui.screen.queryByRole("dialog")), false);
  assert.equal(firstSignal?.aborted, true, "closing a scoped inspector aborts its pending read");
  await ui.act(async () => { release!({ ok: true, value: { ...fixture.overview, description: "Old credential response" } }); });
  assert.equal(Boolean(ui.screen.queryByText("Old credential response")), false);
  answer = () => ({ ok: true, value: { ...fixture.overview, description: "New credential response" } });
  (ui.screen.getByRole("group", { name: "Deployed deployment" }) as HTMLDetailsElement).open = true;
  ui.fireEvent.click(ui.screen.getByRole("button", { name: `Inspect ${STACK_NAME}` }));
  await ui.screen.findByText("New credential response");
  assert.equal(requests.length, 2);
  assert.equal(Boolean(ui.screen.queryByText("Old credential response")), false);
  answer = () => new Promise(resolve => { release = resolve; });
  rendered.rerender(page("credentials-2", "source-2"));
  await ui.waitFor(() => assert.equal(requests.length, 3));
  assert.ok(ui.screen.getByRole("dialog", { name: `Stack details · ${STACK_NAME}` }));
  assert.equal((ui.screen.getByRole("group", { name: "Deployed deployment" }) as HTMLDetailsElement).open, true);
  assert.ok(ui.screen.getByText("New credential response"), "source refresh keeps the observed immutable stack visible");
  await ui.act(async () => { release!({ ok: true, value: { ...fixture.overview, description: "Rechecked current stack" } }); });
  await ui.screen.findByText("Rechecked current stack");
});
