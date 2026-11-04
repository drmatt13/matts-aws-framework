import type { FieldFact } from "../../shared/model";
import { test, expect, assertAccessible } from "./support/test";

test("Lambda concurrency defaults off, supports keyboard editing and validates before source review", async ({ page, studio }) => {
  const target = "lambda:fixture-0";
  const concurrency: FieldFact[] = ["reserved", "provisioned"].map((kind) => ({
    field: `lambda.${kind}ConcurrentExecutions`, label: `${kind === "reserved" ? "Reserved" : "Provisioned"} Concurrency`,
    path: [`${kind}ConcurrentExecutions`], domain: { kind: "number", min: kind === "reserved" ? 0 : 1, max: Number.MAX_SAFE_INTEGER, unit: "executions" },
    effective: false, inherited: { value: false, from: "the framework's default" }, provenance: "the framework's default",
  }));
  for (const model of Object.values(studio.response.snapshot.models)) {
    Object.assign(model, { fields: { ...model.fields, [target]: [...model.fields[target]!, ...concurrency] } });
  }
  Object.assign(studio.response.snapshot.source.editability[target]!, Object.fromEntries(concurrency.map(fact => [fact.field, { kind: "absent" }])));
  await studio.goto(`/?select=${encodeURIComponent(target)}`);
  await page.getByRole("complementary", { name: "Inspector", exact: true }).locator("[data-inspector-disclosure] > details > summary").filter({ hasText: /^Settings$/ }).click();
  const reserved = page.getByRole("switch", { name: "Reserved Concurrency", exact: true });
  const provisioned = page.getByRole("switch", { name: "Provisioned Concurrency", exact: true });
  const reservedCount = page.getByRole("spinbutton", { name: "Reserved Concurrency executions" });
  const provisionedCount = page.getByRole("spinbutton", { name: "Provisioned Concurrency executions" });
  await expect(reserved).toHaveAttribute("aria-checked", "false");
  await expect(provisioned).toHaveAttribute("aria-checked", "false");
  await expect(reservedCount).toHaveCount(0);
  await reserved.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  await expect(reservedCount).toBeFocused();
  await reservedCount.fill("0");
  await provisioned.focus();
  await page.keyboard.press("Enter");
  await expect(provisionedCount).toHaveValue("1");
  await expect(page.getByRole("alert")).toContainText("cannot exceed reserved concurrency");
  await expect(page.getByRole("button", { name: "Review Changes", exact: true })).toBeDisabled();
  await reservedCount.fill("5");
  await provisionedCount.fill("");
  await expect(provisionedCount).toHaveAttribute("aria-invalid", "true");
  await provisionedCount.fill("2.5");
  await expect(provisionedCount).toHaveAttribute("aria-invalid", "true");
  await provisionedCount.fill("2");

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await provisionedCount.scrollIntoViewIfNeeded();
    const bounds = await provisionedCount.evaluate(input => ({ input: input.getBoundingClientRect().toJSON(), row: input.closest("[data-slot=field]")!.getBoundingClientRect().toJSON() }));
    expect(bounds.input.right).toBeLessThanOrEqual(bounds.row.right + 1);
    expect(bounds.input.width).toBeGreaterThan(180);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await assertAccessible(page);
  await page.getByRole("button", { name: "Review Changes", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Apply All", exact: true })).toBeEnabled();
  const request = studio.requests.find(request => request.path === "/api/edits/batch/plan");
  expect(JSON.stringify(request?.body)).toContain('"lambda.reservedConcurrentExecutions"');
  expect(JSON.stringify(request?.body)).toContain('"value":2');
  await page.getByRole("button", { name: "Back to Editing", exact: true }).click();
  await expect(provisionedCount).toHaveValue("2");
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(reserved).toHaveAttribute("aria-checked", "false");
  await expect(provisionedCount).toHaveCount(0);
  expect(studio.requests.filter(request => /apply$/.test(request.path))).toHaveLength(0);
});
