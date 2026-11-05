import assert from "./support/assert";
import { createRequire } from "node:module";
import { afterEach, before, beforeEach, test } from "node:test";
import { createElement as h } from "react";
import { overview, dockerStatus } from "./browser/support/scenarios";
import type { DockerView, JobView } from "../shared/deploy";

const require = createRequire(import.meta.url);
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
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of ["window", "self", "document", "navigator", "HTMLElement", "Element", "Node", "Text", "MutationObserver", "getComputedStyle"] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  }
  // JSDOM hides native popovers but does not implement showing them. Browser tests cover dismissal/focus.
  dom.window.HTMLElement.prototype.showPopover = function () { this.style.display = "block"; };
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: class { addEventListener() {} removeEventListener() {} close() {} } });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: string) => {
    if (input.startsWith("/api/machine/docker")) return new Response(JSON.stringify(await readDocker()));
    if (input === "/api/operations") return new Response(JSON.stringify(client.getQueryData(["operations"]) ?? { jobs: [] }));
    throw new Error(`Unscripted ${input}`);
  } });
  query = require("@tanstack/react-query");
  machine = await import("../src/machine/docker");
  ui = require("@testing-library/react");
  view = await import("../src/views/map/ComposePreview");
  api = (await import("../src/deploy/api")).deployApi;
});

beforeEach(() => {
  docker = { engine: "running", desktop: true };
  operations = [];
  outcome = "succeeded";
  readDocker = async () => dockerStatus(docker);
  client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
  api.overview = async () => ({ ...overview(), local: { ...overview().local, docker } });
  api.operate = async (kind) => {
    operations.push(kind);
    const started: JobView = { id: `docker-job-${operations.length}`, kind, title: "Start Docker Desktop", params: {}, status: "running", startedAt: new Date(Date.now() + operations.length).toISOString(), lastSeq: 0 };
    setTimeout(() => {
      if (outcome === "succeeded") docker = { engine: "running", desktop: true };
      client.setQueryData(["operations"], { jobs: [{ ...started, status: outcome, ...(outcome === "failed" ? { summary: "Docker Desktop could not start." } : {}) }] });
    }, 10);
    return started;
  };
});

afterEach(() => { ui.cleanup(); client.clear(); });

const mount = (motion: boolean) => {
  ui.render(h(query.QueryClientProvider, { client }, h(machine.GlobalDockerStatus), h(view.ComposePreview, { motion })));
  return ui.screen.getByRole("switch", { name: "Local runtime" });
};
const status = (control: HTMLElement) =>
  [...control.querySelectorAll("[data-slot='compose-status']")].find((item) => item.getAttribute("data-current") === "true")?.textContent;

test("the card checks Docker before enabling the preview and its status follows it", async () => {
  const control = mount(true);
  assert.equal(control.getAttribute("aria-checked"), "false");
  assert.equal(status(control), "Stopped");
  ui.fireEvent.click(control);
  await ui.waitFor(() => assert.equal(control.getAttribute("aria-checked"), "true"));
  assert.equal(control.getAttribute("aria-checked"), "true");
  assert.equal(control.getAttribute("data-state"), "on");
  assert.equal(status(control), "Running");
  ui.fireEvent.click(control);
  assert.equal(control.getAttribute("aria-checked"), "false");
  assert.equal(status(control), "Stopped");
});

test("nothing moves before the first turn-on, and each turn-on plays the launch once", async () => {
  const control = mount(true);
  assert.equal(control.getAttribute("data-motion"), "on");
  assert.equal(control.querySelector("[data-slot='compose-launch']"), null, "no one-shot effect is mounted on page load");
  ui.fireEvent.click(control);
  await ui.waitFor(() => assert.equal(control.getAttribute("aria-checked"), "true"));
  const launch = control.querySelectorAll("[data-slot='compose-launch']");
  assert.ok(launch.length > 0, "turning on mounts the launch effects");
  assert.equal(control.querySelector("[data-slot='compose-hover-spout']"), null, "the click that turns it on does not also play the hover spout");
  ui.fireEvent.pointerLeave(control);
  assert.ok(control.querySelector("[data-slot='compose-hover-spout']"), "hovering again later can spout");
  ui.fireEvent.click(control);
  ui.fireEvent.click(control);
  await ui.waitFor(() => assert.equal(control.getAttribute("aria-checked"), "true"));
  const replay = control.querySelectorAll("[data-slot='compose-launch']");
  assert.ok(replay.length > 0 && [...replay].every((item) => ![...launch].includes(item)), "a second turn-on remounts the launch so it replays");
});

test("with motion off the switch changes state without any animation", async () => {
  const control = mount(false);
  ui.fireEvent.click(control);
  await ui.waitFor(() => assert.equal(control.getAttribute("aria-checked"), "true"));
  assert.equal(control.getAttribute("aria-checked"), "true");
  assert.equal(control.getAttribute("data-motion"), "off");
  assert.equal(control.querySelector("[data-slot='compose-launch']"), null, "no one-shot effect plays");
  ui.fireEvent.pointerLeave(control);
  assert.equal(control.querySelector("[data-slot='compose-hover-spout']"), null, "and hovering never spouts");
});

test("starting Docker keeps the switch off until a separate click on the switch", async () => {
  docker = { engine: "stopped", desktop: true };
  const control = mount(true);
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
  assert.deepEqual(operations, ["docker-start"]);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Done" }));
  assert.equal(ui.screen.queryByRole("dialog"), null);
  assert.equal(document.activeElement, control);
  ui.fireEvent.click(control);
  await ui.waitFor(() => assert.equal(control.getAttribute("aria-checked"), "true"));
});

test("Docker without Desktop offers manual instructions and a fresh check", async () => {
  docker = { engine: "missing", desktop: false };
  const control = mount(false);
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
  await ui.waitFor(() => assert.equal(control.getAttribute("aria-checked"), "true"));
});

test("a failed Docker start stays off and can be retried", async () => {
  docker = { engine: "stopped", desktop: true };
  outcome = "failed";
  const control = mount(false);
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
  const control = mount(false);
  ui.fireEvent.click(control);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Close Docker help" }));
  await ui.act(async () => { finish(dockerStatus()); });
  assert.equal(control.getAttribute("aria-checked"), "false");
  assert.equal(ui.screen.queryByRole("dialog"), null);
});
