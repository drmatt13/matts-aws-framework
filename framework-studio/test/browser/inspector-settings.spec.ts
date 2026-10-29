import type { FieldFact } from "../../shared/model";
import { test, expect } from "./support/test";

const authorizer: FieldFact = {
  field: "http.auth", label: "API user-pool authorizer", path: ["auth"],
  domain: { kind: "enum", values: [true, false] }, effective: true,
  inherited: { value: true, from: "Shared HTTP defaults" },
  provenance: "Shared HTTP defaults from a deliberately long source description that must wrap below the setting instead of sizing its switch column.",
};

test("Boolean settings keep readable labels and full-width help through source details and narrow panels", async ({ page, studio }) => {
  for (const model of Object.values(studio.response.snapshot.models)) {
    Object.assign(model, { fields: { ...model.fields, "lambda:fixture-0": [
      ...model.fields["lambda:fixture-0"]!, authorizer,
      { ...authorizer, field: "lambda.bundling.minify", label: "Minify", path: ["lambda", "bundling", "minify"] },
      { ...authorizer, field: "lambda.bundling.sourceMap", label: "Source maps", path: ["lambda", "bundling", "sourceMap"], blocked: "This setting is computed from a shared source helper with a long explanatory message." },
    ] } });
  }
  Object.assign(studio.response.snapshot.source.editability["lambda:fixture-0"]!, {
    "http.auth": { kind: "absent" }, "lambda.bundling.minify": { kind: "absent" }, "lambda.bundling.sourceMap": { kind: "absent" },
  });
  await studio.goto();
  await page.getByRole("button", { name: "Resources", exact: true }).click();
  await page.locator('[data-resource-id="lambda:fixture-0"]').click();
  const inspector = page.getByRole("complementary", { name: "Inspector", exact: true });
  const control = inspector.getByRole("switch", { name: authorizer.label, exact: true });
  const row = control.locator("xpath=ancestor::*[@data-slot='field'][1]");
  const origin = row.locator(":scope > [data-slot=field-origin]");
  await origin.locator("summary").click();
  await expect(origin).toContainText(authorizer.provenance);
  await inspector.locator("summary").filter({ hasText: "Build and runtime" }).click();

  for (const width of [1440, 1100, 900, 800, 540, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await control.scrollIntoViewIfNeeded();
    const geometry = await row.evaluate(element => {
      const box = element.getBoundingClientRect();
      const label = element.querySelector<HTMLElement>("[data-slot=field-label]")!;
      const toggle = element.querySelector<HTMLElement>("[role=switch]")!;
      const text = document.createRange(); text.selectNodeContents(label);
      return { row: box.toJSON(), label: label.getBoundingClientRect().toJSON(), toggle: toggle.getBoundingClientRect().toJSON(),
        textLines: [...text.getClientRects()].filter(rect => rect.width > 0).length,
        support: [...element.querySelectorAll<HTMLElement>(":scope > [data-slot=field-help], :scope > [data-slot=field-origin]")].map(item => item.getBoundingClientRect().toJSON()) };
    });
    expect(geometry.label.width, `readable label at ${width}px`).toBeGreaterThan(160);
    expect(geometry.textLines, `authorizer label at ${width}px`).toBe(1);
    expect(geometry.toggle.x).toBeGreaterThanOrEqual(geometry.label.right);
    expect(geometry.toggle.right).toBeLessThanOrEqual(geometry.row.right + 1);
    for (const support of geometry.support) {
      expect(Math.abs(support.x - geometry.row.x), `help starts at the row edge at ${width}px`).toBeLessThan(1);
      expect(Math.abs(support.width - geometry.row.width), `help spans the row at ${width}px`).toBeLessThan(1);
      expect(support.top).toBeGreaterThanOrEqual(geometry.toggle.bottom);
    }
    for (const label of ["Minify", "Source maps"]) {
      const setting = inspector.getByRole("switch", { name: label, exact: true }).locator("xpath=ancestor::*[@data-slot='field'][1]");
      const bounds = await setting.evaluate(element => ({ row: element.getBoundingClientRect().toJSON(), label: element.querySelector("[data-slot=field-label]")!.getBoundingClientRect().toJSON(), toggle: element.querySelector("[role=switch]")!.getBoundingClientRect().toJSON() }));
      expect(bounds.label.width).toBeGreaterThan(160);
      expect(bounds.toggle.right).toBeLessThanOrEqual(bounds.row.right + 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  // The inherited-value action appears only after staging an override. It must
  // remain below the full-width source details, and this exercise never applies.
  await control.click();
  await expect(origin.getByRole("button", { name: "Use inherited value (On)", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  expect(studio.requests.filter(request => /apply$/.test(request.path))).toHaveLength(0);
});

test("event local-replay help stays beneath its switch at desktop and mobile widths", async ({ page, studio }) => {
  const replay: FieldFact = { ...authorizer, field: "events.localReplay", label: "Local replay", path: ["localReplay"] };
  for (const model of Object.values(studio.response.snapshot.models)) {
    Object.assign(model.targets[0]!, { role: "event" });
    Object.assign(model, { fields: { "lambda:fixture-0": [replay] } });
  }
  Object.assign(studio.response.snapshot.source.editability["lambda:fixture-0"]!, { "events.localReplay": { kind: "absent" } });
  await studio.goto();
  await page.getByRole("button", { name: "Resources", exact: true }).click();
  await page.locator('[data-resource-id="lambda:fixture-0"]').click();
  const control = page.getByRole("switch", { name: "Local replay", exact: true });
  const row = control.locator("xpath=ancestor::*[@data-slot='field'][1]");
  await row.locator(":scope > [data-slot=field-origin] > summary").click();
  for (const width of [1440, 800, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await control.scrollIntoViewIfNeeded();
    const boxes = await row.evaluate(element => ({ row: element.getBoundingClientRect().toJSON(), label: element.querySelector("label")!.getBoundingClientRect().toJSON(), control: element.querySelector("[role=switch]")!.getBoundingClientRect().toJSON(), help: element.querySelector("[data-slot=field-help]")!.getBoundingClientRect().toJSON() }));
    expect(boxes.label.width, `Local replay label at ${width}px`).toBeGreaterThan(140);
    expect(boxes.help.top).toBeGreaterThanOrEqual(boxes.control.bottom);
    expect(Math.abs(boxes.help.width - boxes.row.width)).toBeLessThan(1);
    expect(boxes.control.right).toBeLessThanOrEqual(boxes.row.right + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test("conditional deployment fields retain full-width controls beside long input names", async ({ page, studio }) => {
  const input = { id: "input:conditional", kind: "input", path: ["deployment", "a_long_authored_parameter_name_for_conditionally_enabling_the_workload"], fromEnv: "VERY_LONG_AUTHORED_DEPLOYMENT_CONDITION_INPUT", values: ["enabled", "disabled"], absent: false };
  for (const model of Object.values(studio.response.snapshot.models)) {
    Object.assign(model.targets[0]!.lanes, { when: { resource: input.id, equals: "enabled", dev: "holds", prod: "fails" } });
    Object.assign(model, { resources: [...model.resources, input] });
  }
  Object.assign(studio.response.snapshot.source.editability["lambda:fixture-0"]!, { deploy: { kind: "condition" } });
  await studio.goto();
  await page.getByRole("button", { name: "Resources", exact: true }).click();
  await page.locator('[data-resource-id="lambda:fixture-0"]').click();
  const condition = page.locator("[data-slot=deploy-condition]");
  for (const width of [1440, 1100, 800, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await condition.scrollIntoViewIfNeeded();
    const rows = await condition.locator(":scope > [data-slot=field]").evaluateAll(elements => elements.map(element => ({ row: element.getBoundingClientRect().toJSON(), control: element.querySelector("select,input")!.getBoundingClientRect().toJSON(), help: element.querySelector("[data-slot=note]")!.getBoundingClientRect().toJSON() })));
    expect(rows).toHaveLength(2);
    for (const item of rows) {
      expect(item.control.width).toBeGreaterThan(item.row.width * .9);
      expect(item.control.right).toBeLessThanOrEqual(item.row.right + 1);
      expect(Math.abs(item.help.width - item.row.width)).toBeLessThan(1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
