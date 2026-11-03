import assert from "./support/assert";
import { createRequire } from "node:module";
import { afterEach, before, test } from "node:test";
import { createElement as h } from "react";

const require = createRequire(import.meta.url);
let ui: typeof import("@testing-library/react");
let view: typeof import("../src/views/map/ComposePreview");

before(async () => {
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of ["window", "self", "document", "navigator", "HTMLElement", "Element", "Node", "Text", "MutationObserver", "getComputedStyle"] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  }
  ui = require("@testing-library/react");
  view = await import("../src/views/map/ComposePreview");
});

afterEach(() => ui.cleanup());

const mount = (motion: boolean) => {
  ui.render(h(view.ComposePreview, { motion }));
  return ui.screen.getByRole("switch", { name: "Docker Compose" });
};
const status = (control: HTMLElement) =>
  [...control.querySelectorAll("[data-slot='compose-status']")].find((item) => item.getAttribute("data-current") === "true")?.textContent;

test("the card is one switch whose status line follows it", () => {
  const control = mount(true);
  assert.equal(control.getAttribute("aria-checked"), "false");
  assert.equal(status(control), "Stopped");
  ui.fireEvent.click(control);
  assert.equal(control.getAttribute("aria-checked"), "true");
  assert.equal(control.getAttribute("data-state"), "on");
  assert.equal(status(control), "Running");
  ui.fireEvent.click(control);
  assert.equal(control.getAttribute("aria-checked"), "false");
  assert.equal(status(control), "Stopped");
});

test("nothing moves before the first turn-on, and each turn-on plays the launch once", () => {
  const control = mount(true);
  assert.equal(control.getAttribute("data-motion"), "on");
  assert.equal(control.querySelector("[data-slot='compose-launch']"), null, "no one-shot effect is mounted on page load");
  ui.fireEvent.click(control);
  const launch = control.querySelectorAll("[data-slot='compose-launch']");
  assert.ok(launch.length > 0, "turning on mounts the launch effects");
  assert.equal(control.querySelector("[data-slot='compose-hover-spout']"), null, "the click that turns it on does not also play the hover spout");
  ui.fireEvent.pointerLeave(control);
  assert.ok(control.querySelector("[data-slot='compose-hover-spout']"), "hovering again later can spout");
  ui.fireEvent.click(control);
  ui.fireEvent.click(control);
  const replay = control.querySelectorAll("[data-slot='compose-launch']");
  assert.ok(replay.length > 0 && [...replay].every((item) => ![...launch].includes(item)), "a second turn-on remounts the launch so it replays");
});

test("with motion off the switch changes state without any animation", () => {
  const control = mount(false);
  ui.fireEvent.click(control);
  assert.equal(control.getAttribute("aria-checked"), "true");
  assert.equal(control.getAttribute("data-motion"), "off");
  assert.equal(control.querySelector("[data-slot='compose-launch']"), null, "no one-shot effect plays");
  ui.fireEvent.pointerLeave(control);
  assert.equal(control.querySelector("[data-slot='compose-hover-spout']"), null, "and hovering never spouts");
});
