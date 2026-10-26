import assert from "./support/assert";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import { createElement as h, useState } from "react";
import { INTERFACE_ENDPOINT_SERVICES } from "@repo/framework/config";
import { endpointServiceDetails } from "../src/endpoint-services";

let ui: typeof import("@testing-library/react");
let Picker: typeof import("../src/views/InterfaceEndpointPicker").InterfaceEndpointPicker;
let dom: { window: Window & typeof globalThis };
before(async () => {
  const require = createRequire(import.meta.url);
  const { JSDOM } = require("jsdom");
  dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  for (const name of ["window", "document", "navigator", "HTMLElement", "Node", "MutationObserver", "getComputedStyle"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  ui = require("@testing-library/react");
  Picker = (await import("../src/views/InterfaceEndpointPicker")).InterfaceEndpointPicker;
});
afterEach(() => ui.cleanup());
after(() => dom.window.close());

test("every framework endpoint has local SVG artwork; friendly names preserve exact variants", () => {
  for (const id of INTERFACE_ENDPOINT_SERVICES) {
    const service = endpointServiceDetails(id);
    assert.equal(service.id, id);
    assert.match(service.icon, /^\/icons\/[a-z0-9/-]+\.svg$/);
    const file = path.resolve(__dirname, "../public", service.icon.slice(1));
    assert.ok(existsSync(file), `${id}: ${file}`);
    assert.doesNotMatch(readFileSync(file, "utf8"), /<script|\bonload=|<foreignObject/i);
  }
  assert.equal(endpointServiceDetails("logs").label, "CloudWatch Logs");
  assert.equal(endpointServiceDetails("ecr.dkr").label, "ECR · Docker");
  assert.equal(endpointServiceDetails("bedrock-agentcore.gateway").label, "Bedrock AgentCore · Gateway");
  assert.equal(endpointServiceDetails("future-service").id, "future-service");
});

test("search and keyboard navigation preserve unknown selections and Escape closes only the picker", () => {
  let outerEscape = false;
  function Form() {
    const [selected, setSelected] = useState<readonly string[]>(["future-service"]);
    return h("div", { onKeyDown: (event: { key: string }) => { if (event.key === "Escape") outerEscape = true; } },
      h(Picker, { id: "endpoints", services: ["logs", "ecr.api", "ecr.dkr", "secretsmanager"], selected, onChange: setSelected }), h("button", null, "Outside"));
  }
  ui.render(h(Form));
  const toggle = ui.screen.getByRole("button", { name: "Choose interface endpoint services" });
  ui.fireEvent.click(toggle);
  const search = ui.screen.getByRole("searchbox", { name: "Search interface endpoint services" });
  assert.equal(document.activeElement, search);
  ui.fireEvent.change(search, { target: { value: "ecr" } });
  assert.equal(ui.screen.queryByRole("button", { name: "Secrets Manager · secretsmanager" }), null, "acronyms match service words, not the middle of unrelated names");
  ui.fireEvent.keyDown(search, { key: "ArrowDown" });
  const api = ui.screen.getByRole("button", { name: "ECR · API · ecr.api" });
  const docker = ui.screen.getByRole("button", { name: "ECR · Docker · ecr.dkr" });
  assert.equal(document.activeElement, api);
  ui.fireEvent.keyDown(api, { key: "ArrowDown" });
  assert.equal(document.activeElement, docker);
  ui.fireEvent.click(docker);
  assert.equal(docker.getAttribute("aria-pressed"), "true");
  assert.ok(ui.screen.getByRole("button", { name: "Remove future-service endpoint" }));
  assert.ok(ui.screen.getByRole("button", { name: "Remove ecr.dkr endpoint" }));
  ui.fireEvent.keyDown(docker, { key: "Escape" });
  assert.equal(outerEscape, false);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(document.activeElement, toggle);
  const chip = ui.screen.getByRole("button", { name: "Remove ecr.dkr endpoint" });
  chip.focus(); ui.fireEvent.click(chip);
  assert.equal(document.activeElement, toggle, "removing the focused chip retains a keyboard position");
  ui.fireEvent.click(toggle);
  ui.fireEvent.change(ui.screen.getByRole("searchbox"), { target: { value: "no such service" } });
  assert.ok(ui.screen.getByText(/No services match/));
  ui.fireEvent.pointerDown(ui.screen.getByRole("button", { name: "Outside" }));
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
});

test("the selection limit still permits removal and disabled controls cannot stage edits", () => {
  const selected = INTERFACE_ENDPOINT_SERVICES.slice(0, 50);
  let calls = 0;
  const { rerender } = ui.render(h(Picker, { id: "endpoints", services: INTERFACE_ENDPOINT_SERVICES, selected, onChange: () => { calls++; } }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Choose interface endpoint services" }));
  const search = ui.screen.getByRole("searchbox");
  ui.fireEvent.change(search, { target: { value: "logs" } });
  const logs = ui.screen.getByRole("button", { name: "CloudWatch Logs · logs" });
  assert.equal(logs.getAttribute("aria-disabled"), "true");
  ui.fireEvent.click(logs);
  assert.equal(calls, 0);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: `Remove ${selected[0]} endpoint` }));
  assert.equal(calls, 1);
  rerender(h(Picker, { id: "endpoints", services: INTERFACE_ENDPOINT_SERVICES, selected, disabled: true, onChange: () => { calls++; } }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: `Remove ${selected[0]} endpoint` }));
  assert.equal(calls, 1);
  assert.ok(ui.screen.getByRole("button", { name: "Choose interface endpoint services" }).matches(":disabled"));
  rerender(h(Picker, { id: "endpoints", services: INTERFACE_ENDPOINT_SERVICES, selected, onChange: () => { calls++; } }));
  assert.equal(ui.screen.getByRole("button", { name: "Choose interface endpoint services" }).getAttribute("aria-expanded"), "false", "a completed background operation must not reopen the picker");
});

test("a missing server catalog gives a recovery action without dropping authored endpoints", () => {
  ui.render(h(Picker, { id: "endpoints", services: undefined, selected: ["logs"], onChange: () => assert.fail("opening must not stage changes") }));
  assert.ok(ui.screen.getByRole("button", { name: "Remove logs endpoint" }));
  assert.ok(ui.screen.getByRole("button", { name: "Choose interface endpoint services" }).matches(":disabled"));
  assert.match(ui.screen.getByRole("status").textContent!, /Restart npm run studio/);
});
