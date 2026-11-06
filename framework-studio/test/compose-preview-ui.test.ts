import assert from "./support/assert";
import { createRequire } from "node:module";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { createElement as h } from "react";
import { overview, dockerStatus, snapshot, discovery, NOW } from "./browser/support/scenarios";
import { connectionCatalogFixture } from "./browser/support/aws-connections";
import type { DockerView, JobView, LocalRunView, StatusView, StackView } from "../shared/deploy";

const require = createRequire(import.meta.url);
let dom: { window: Window & typeof globalThis };
const timers = new Set<ReturnType<typeof setTimeout>>();
let local: LocalRunView;
let router: typeof import("@tanstack/react-router");
let studio: typeof import("../src/studio");
let deployment: typeof import("../src/deploy/queries");
let profiles: typeof import("../src/aws-profile-queries");
let runtime: typeof import("../src/deploy/local-runtime");
const response = snapshot();
const destination = { deployment: "browser-dev", profile: "browser", account: "123456789012", region: "us-east-1" };
let ui: typeof import("@testing-library/react");
let view: typeof import("../src/views/map/ComposePreview");
let api: typeof import("../src/deploy/api").deployApi;
let docker: DockerView;
let operations: string[];
let query: typeof import("@tanstack/react-query");
let machine: typeof import("../src/machine/docker");
let client: import("@tanstack/react-query").QueryClient;
let outcome: JobView["status"];
let readDocker: () => Promise<ReturnType<typeof dockerStatus>>;

before(async () => {
  const { JSDOM } = require("jsdom");
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of ["window", "self", "document", "navigator", "HTMLElement", "Element", "Node", "Text", "MutationObserver", "getComputedStyle"] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  }
  // JSDOM hides native popovers but does not implement showing them. Browser tests cover dismissal/focus.
  dom.window.HTMLElement.prototype.showPopover = function () { this.style.display = "block"; };
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: class { addEventListener() {} removeEventListener() {} close() {} } });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: string) => {
    if (input.startsWith("/api/machine/docker")) return new Response(JSON.stringify(await readDocker()));
    if (input.startsWith("/api/deploy/local")) return new Response(JSON.stringify({ ...local, docker }));
    if (input === "/api/operations") return new Response(JSON.stringify(client.getQueryData(["operations"]) ?? { jobs: [] }));
    throw new Error(`Unscripted ${input}`);
  } });
  Object.defineProperty(globalThis, "scrollTo", { configurable: true, value: () => {} });
  query = require("@tanstack/react-query");
  machine = await import("../src/machine/docker");
  ui = require("@testing-library/react");
  view = await import("../src/views/map/ComposePreview");
  api = (await import("../src/deploy/api")).deployApi;
  router = require("@tanstack/react-router");
  studio = await import("../src/studio");
  deployment = await import("../src/deploy/queries");
  profiles = await import("../src/aws-profile-queries");
  runtime = await import("../src/deploy/local-runtime");
});

beforeEach(() => {
  docker = { engine: "running", desktop: true };
  operations = [];
  local = { ...overview().local, readiness: { state: "stopped", observedAt: NOW, message: "Stopped" } };
  outcome = "succeeded";
  readDocker = async () => dockerStatus(docker);
  client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
  api.overview = async () => ({ ...overview(), local: { ...overview().local, docker } });
  api.operate = async (kind, params) => {
    assert.ok(["docker-start", "local-start", "local-stop"].includes(kind), `unexpected operation: ${kind}`);
    if (kind === "local-start") assert.deepEqual(params, { ...destination, mode: "dev", export: true });
    if (kind === "local-stop") assert.deepEqual(params, {});
    operations.push(kind);
    const started: JobView = { id: `job-${operations.length}`, kind, title: kind, params, status: "running", startedAt: new Date(Date.now() + operations.length).toISOString(), lastSeq: 0 };
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (outcome === "succeeded") {
        if (kind === "docker-start") docker = { engine: "running", desktop: true };
        else {
          const running = kind === "local-start";
          local = { ...local, watch: { running }, client: { running },
            readiness: { state: running ? "ready" : "stopped", observedAt: NOW, message: running ? "Ready" : "Stopped" },
            binding: { ...destination, startedAt: NOW }, exported: { ...destination, client: true } };
          client.setQueryData(runtime.localRuntimeQuery(response.snapshot.repositoryRoot).queryKey, local);
        }
      }
      client.setQueryData(["operations"], { jobs: [{ ...started, status: outcome, ...(outcome === "failed" ? { summary: "Docker Desktop could not start." } : {}) }] });
    }, 10);
    timers.add(timer);
    return started;
  };
});

afterEach(async () => {
  ui.cleanup();
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  await client.cancelQueries(); client.clear();
  dom.window.localStorage.clear();
});
after(() => dom.window.close());

const mount = async (motion: boolean) => {
  const source = { repository: response.snapshot.repositoryRoot, sourceRevision: response.snapshot.revision };
  const scope = { ...source, mode: "dev" as const, profile: destination.profile, deployment: destination.deployment, generation: "0:0" };
  const stack: StackView = { name: "browser-dev-Core", status: "CREATE_COMPLETE", health: "complete", evidence: "tags", identity: { deployment: "browser-dev", mode: "dev" } };
  const status: StatusView = { ...discovery(), deployment: destination.deployment,
    detail: { name: destination.deployment, mode: "dev", account: destination.account, region: destination.region,
      stacks: [stack], contracts: [2], state: { kind: "ready", stacks: [stack] }, events: [], changeSets: [],
      local: { compatible: true, exported: { client: true, fresh: true } } } };
  dom.window.localStorage.setItem(`aws-studio:mode-profiles:v1:${source.repository}`, JSON.stringify({ dev: destination.profile }));
  client.setQueryData(deployment.deploymentOverviewQuery(false, source).queryKey, overview());
  client.setQueryData(profiles.awsProfileCatalogQuery().queryKey, connectionCatalogFixture([{ name: "browser", kind: "sso", region: "us-east-1" }]));
  client.setQueryData(deployment.deploymentStatusQuery(scope).queryKey, status);
  client.setQueryData(["operations"], { jobs: [] });
  client.setQueryData(runtime.localRuntimeQuery(source.repository).queryKey, local);
  function Root() {
    return h(studio.StudioProvider, { response, selected: undefined, select: () => {}, children:
      h("div", null, h(machine.GlobalDockerStatus), h(view.ComposePreview, { motion })) });
  }
  const root = router.createRootRoute({ component: Root });
  const app = router.createRouter({ history: router.createMemoryHistory({ initialEntries: ["/"] }), routeTree: root });
  ui.render(h(query.QueryClientProvider, { client }, h(router.RouterProvider, { router: app })));
  return await ui.screen.findByRole("switch", { name: "Local runtime" });
};
const status = (control: HTMLElement) =>
  [...control.querySelectorAll("[data-slot='compose-status']")].find((item) => item.getAttribute("data-current") === "true")?.textContent;

test("the card checks Docker before enabling the preview and its status follows it", async () => {
  const control = await mount(true);
  assert.equal(control.getAttribute("aria-checked"), "false");
  assert.equal(status(control), "Stopped");
  ui.fireEvent.click(control);
  await ui.waitFor(() => { assert.equal(control.getAttribute("aria-checked"), "true"); assert.equal(status(control), "Running"); assert.equal(control.getAttribute("aria-busy"), "false"); });
  assert.equal(control.getAttribute("aria-checked"), "true");
  assert.equal(control.getAttribute("data-state"), "on");
  assert.equal(status(control), "Running");
  ui.fireEvent.click(control);
  await ui.waitFor(() => assert.equal(control.getAttribute("aria-checked"), "false"));
  assert.equal(status(control), "Stopped");
  assert.deepEqual(operations, ["local-start", "local-stop"]);
});

test("nothing moves before the first turn-on, and each turn-on plays the launch once", async () => {
  const control = await mount(true);
  assert.equal(control.getAttribute("data-motion"), "on");
  assert.equal(control.querySelector("[data-slot='compose-launch']"), null, "no one-shot effect is mounted on page load");
  ui.fireEvent.click(control);
  await ui.waitFor(() => { assert.equal(control.getAttribute("aria-checked"), "true"); assert.equal(status(control), "Running"); assert.equal(control.getAttribute("aria-busy"), "false"); });
  const launch = control.querySelectorAll("[data-slot='compose-launch']");
  assert.ok(launch.length > 0, "turning on mounts the launch effects");
  assert.equal(control.querySelector("[data-slot='compose-hover-spout']"), null, "the click that turns it on does not also play the hover spout");
  ui.fireEvent.pointerLeave(control);
  assert.ok(control.querySelector("[data-slot='compose-hover-spout']"), "hovering again later can spout");
  ui.fireEvent.click(control);
  await ui.waitFor(() => assert.equal(control.getAttribute("aria-checked"), "false"));
  ui.fireEvent.click(control);
  await ui.waitFor(() => { assert.equal(control.getAttribute("aria-checked"), "true"); assert.equal(status(control), "Running"); assert.equal(control.getAttribute("aria-busy"), "false"); });
  const replay = control.querySelectorAll("[data-slot='compose-launch']");
  assert.ok(replay.length > 0 && [...replay].every((item) => ![...launch].includes(item)), "a second turn-on remounts the launch so it replays");
});

test("with motion off the switch changes state without any animation", async () => {
  const control = await mount(false);
  ui.fireEvent.click(control);
  await ui.waitFor(() => { assert.equal(control.getAttribute("aria-checked"), "true"); assert.equal(status(control), "Running"); assert.equal(control.getAttribute("aria-busy"), "false"); });
  assert.equal(control.getAttribute("aria-checked"), "true");
  assert.equal(control.getAttribute("data-motion"), "off");
  assert.equal(control.querySelector("[data-slot='compose-launch']"), null, "no one-shot effect plays");
  ui.fireEvent.pointerLeave(control);
  assert.equal(control.querySelector("[data-slot='compose-hover-spout']"), null, "and hovering never spouts");
});

test("starting Docker keeps the switch off until a separate click on the switch", async () => {
  docker = { engine: "stopped", desktop: true };
  const control = await mount(true);
  ui.fireEvent.click(control);
  const start = await ui.screen.findByRole("button", { name: "Start Docker Desktop" });
  assert.equal(control.getAttribute("aria-checked"), "false");
  assert.equal(status(control), "Stopped");
  assert.equal(control.querySelector("[data-slot='compose-launch']"), null);
  assert.deepEqual(operations, []);
  ui.fireEvent.click(start);
  await ui.screen.findByText("Docker is ready");
  assert.equal(control.getAttribute("aria-checked"), "false");
  assert.equal(status(control), "Stopped");
  assert.equal(control.querySelector("[data-slot='compose-launch']"), null);
  assert.deepEqual(operations, ["docker-start"], "starting Docker does not start application compute");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Done" }));
  assert.equal(ui.screen.queryByRole("dialog"), null);
  assert.equal(document.activeElement, control);
  ui.fireEvent.click(control);
  await ui.waitFor(() => { assert.equal(control.getAttribute("aria-checked"), "true"); assert.equal(status(control), "Running"); assert.equal(control.getAttribute("aria-busy"), "false"); });
});

test("Docker without Desktop offers manual instructions and a fresh check", async () => {
  docker = { engine: "missing", desktop: false };
  const control = await mount(false);
  ui.fireEvent.click(control);
  await ui.screen.findByText("Docker is not installed");
  assert.equal(ui.screen.queryByRole("button", { name: "Start Docker Desktop" }), null);
  assert.ok(ui.screen.getByText(/Install Docker Desktop, open it and finish setup/));
  docker = { engine: "running", desktop: false };
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Check again" }));
  await ui.screen.findByText("Docker is ready");
  assert.equal(control.getAttribute("aria-checked"), "false");
  assert.deepEqual(operations, []);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Done" }));
  ui.fireEvent.click(control);
  await ui.waitFor(() => { assert.equal(control.getAttribute("aria-checked"), "true"); assert.equal(status(control), "Running"); assert.equal(control.getAttribute("aria-busy"), "false"); });
});

test("a failed Docker start stays off and can be retried", async () => {
  docker = { engine: "stopped", desktop: true };
  outcome = "failed";
  const control = await mount(false);
  ui.fireEvent.click(control);
  ui.fireEvent.click(await ui.screen.findByRole("button", { name: "Start Docker Desktop" }));
  await ui.screen.findByRole("alert");
  assert.equal(control.getAttribute("aria-checked"), "false");
  outcome = "succeeded";
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Start Docker Desktop" }));
  await ui.screen.findByText("Docker is ready");
  assert.equal(control.getAttribute("aria-checked"), "false");
});

test("closing while detection is pending ignores the late response", async () => {
  let finish!: (value: ReturnType<typeof dockerStatus>) => void;
  readDocker = () => new Promise((resolve) => { finish = resolve; });
  const control = await mount(false);
  ui.fireEvent.click(control);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Close Docker help" }));
  await ui.act(async () => { finish(dockerStatus()); });
  assert.equal(control.getAttribute("aria-checked"), "false");
  assert.equal(ui.screen.queryByRole("dialog"), null);
});
