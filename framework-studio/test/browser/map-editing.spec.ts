import { test, expect } from "./support/test";

test("map search resets focus and keyboard navigator returns to canvas", async ({ page, studio }) => {
  await studio.goto();
  const search = page.getByRole("searchbox", { name: "Search isometric map" });
  await search.fill("fixture-0");
  await expect(page.getByRole("status").filter({ hasText: /match/ }).first()).toBeVisible();
  await page.getByRole("button", { name: "Clear map search" }).click();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("");
  const navigator = page.getByRole("list", { name: "Entities in the landscape" });
  const resource = navigator.getByRole("button", { name: /^fixture-0, HTTP Lambda/ });
  await resource.focus();
  await expect(resource).toBeInViewport();
  await page.keyboard.press("Escape"); // First Escape dismisses the resource preview.
  await page.keyboard.press("Escape");
  await expect(page.locator("canvas")).toBeFocused();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Fit the whole application", exact: true }).click();
  await expect(page.locator("canvas")).toBeVisible();
});

test("baseline inspector and reviewed draft preserve the accepted-write boundary", async ({ page, studio }) => {
  await studio.goto();
  await page.getByRole("button", { name: "Resources", exact: true }).click();
  await page.locator('[data-resource-id="lambda:fixture-0"]').click();
  const inspector = page.getByRole("complementary", { name: "Inspector", exact: true });
  await expect(inspector.getByRole("heading", { name: "Fixture handler 0", exact: true })).toBeVisible();
  await studio.settle();
  await expect(page).toHaveScreenshot("inspector-desktop.png", { fullPage: true });
  const description = inspector.getByRole("region", { name: "Node description" });
  await description.locator("summary").click();
  await description.getByRole("textbox", { name: "Description", exact: true }).fill("A reviewed fixture description.");
  await page.getByRole("button", { name: "Review Changes", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Apply All", exact: true })).toBeEnabled();
  await studio.settle();
  await expect(page).toHaveScreenshot("source-review.png", { fullPage: true });
  await dialog.getByRole("button", { name: "Back to Editing", exact: true }).click();
  await expect(description.getByRole("textbox", { name: "Description", exact: true })).toHaveValue("A reviewed fixture description.");
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  expect(studio.requests.filter(request => /apply$/.test(request.path))).toHaveLength(0);
});

test("narrow map toolbar stays outside the measured canvas and inspector remains bounded", async ({ page, studio }) => {
  await page.setViewportSize({ width: 420, height: 850 });
  await studio.goto();
  const search = page.getByRole("searchbox", { name: "Search isometric map" });
  const canvas = page.locator("canvas");
  const searchBounds = await search.boundingBox(), canvasBounds = await canvas.boundingBox();
  expect(searchBounds).not.toBeNull(); expect(canvasBounds).not.toBeNull();
  expect(canvasBounds!.y).toBeGreaterThanOrEqual(searchBounds!.y + searchBounds!.height);
  await page.getByRole("button", { name: "Resources", exact: true }).click();
  await page.locator('[data-resource-id="lambda:fixture-0"]').click();
  await expect(page.getByRole("complementary", { name: "Inspector" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("baseline 380px inspector panel preserves disclosure and field widths", async ({ page, studio }) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await studio.goto();
  await page.getByRole("button", { name: "Resources", exact: true }).click();
  await page.locator('[data-resource-id="lambda:fixture-0"]').click();
  const inspector = page.getByRole("complementary", { name: "Inspector", exact: true });
  await expect(inspector.getByRole("heading", { name: "Fixture handler 0", exact: true })).toBeVisible();
  expect((await inspector.boundingBox())!.width).toBe(380);
  await studio.settle();
  await expect(page).toHaveScreenshot("inspector-380.png", { fullPage: true });
});

test("resource hover previews stay in the viewport and dismiss without changing selection", async ({ page, studio }) => {
  await studio.goto();
  await page.getByRole("button", { name: "Resources", exact: true }).click();
  const row = page.locator('[data-resource-id="lambda:fixture-0"]');
  await row.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toBeVisible();
  const bounds = await tooltip.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1440);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(1000);
  await page.keyboard.press("Escape");
  await expect(tooltip).not.toBeVisible();
  await expect(page).toHaveURL("http://127.0.0.1:4592/");
});

test("delayed source review disables apply and preserves the draft when returning", async ({ page, studio }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  studio.reply("POST", "/api/edits/batch/plan", async route => {
    await pending;
    await route.fulfill({ json: { planId: "delayed-plan", summaries: ["Fixture description"], changes: [], preflight: { dev: { mode: "dev", ok: true, diagnostics: [] }, prod: { mode: "prod", ok: true, diagnostics: [] } }, ok: true, impact: [] } });
  });
  await studio.goto();
  await page.getByRole("button", { name: "Resources", exact: true }).click();
  await page.locator('[data-resource-id="lambda:fixture-0"]').click();
  const description = page.getByRole("region", { name: "Node description" });
  await description.locator("summary").click();
  await description.getByRole("textbox", { name: "Description", exact: true }).fill("Preserved pending draft");
  await page.getByRole("button", { name: "Review Changes", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("status")).toContainText("Checking all changes");
  await expect(dialog.getByRole("button", { name: "Apply All", exact: true })).toBeDisabled();
  release();
  await expect(dialog.getByRole("button", { name: "Apply All", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Back to Editing", exact: true }).click();
  await expect(description.getByRole("textbox", { name: "Description", exact: true })).toHaveValue("Preserved pending draft");
  await page.getByRole("button", { name: "Discard", exact: true }).click();
});
