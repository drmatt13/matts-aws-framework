import type { ModelResource } from "../../shared/model";
import { test, expect, assertAccessible } from "./support/test";

for (const width of [1440, 390]) test(`inspector drilldowns restore the parent and original list at ${width}px`, async ({ page, studio }) => {
  await page.setViewportSize({ width, height: 900 });
  const group: ModelResource = { id: "resource:settings", kind: "group", path: ["settings"], absent: false };
  const entries: ModelResource[] = Array.from({ length: 6 }, (_, index) => ({ id: `resource:settings.input${index}`, kind: "input",
    path: ["settings", `input${index}`], parent: group.id, absent: false, default: "fixture-default", fromEnv: `FIXTURE_INPUT_${index}` }));
  for (const model of Object.values(studio.response.snapshot.models)) Object.assign(model, { resources: [...model.resources, group, ...entries] });
  studio.reply("GET", "/api/resources/details", async route => { await route.fulfill({ json: { configured: false, inputFile: { exists: true, hash: "fixture-inputs" } } }); });
  await studio.goto();
  await page.getByRole("button", { name: "Resources", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search isometric map" }).fill("settings");
  await page.getByRole("combobox", { name: "Map resource type" }).selectOption("Input group");
  await page.locator('[data-resource-id="resource:settings"]').click();
  const panel = page.getByRole("complementary", { name: "Inspector", exact: true });
  const content = panel.locator('[data-slot="inspector-content"]');
  await content.locator("summary").filter({ hasText: /^Tags/ }).click();
  const entry = panel.getByRole("button", { name: "input5", exact: true });
  await entry.scrollIntoViewIfNeeded();
  await entry.focus();
  const scroll = await content.evaluate(element => element.scrollTop);
  await page.keyboard.press("Enter");
  const back = panel.getByRole("button", { name: "Back to settings", exact: true });
  await expect(back).toBeFocused();
  await expect(panel.getByRole("heading", { name: "input5", exact: true })).toBeVisible();
  expect(await content.evaluate(element => element.scrollTop)).toBe(0);
  await expect(panel.getByRole("button", { name: "Back to Resources", exact: true })).toBeVisible();
  await assertAccessible(page);
  await back.click();
  await expect(entry).toBeFocused();
  expect(await content.evaluate(element => element.scrollTop)).toBeCloseTo(scroll, 0);
  await expect(content.locator('[data-slot="declaration-tags"] details')).toHaveAttribute("open", "");
  await page.goForward();
  await expect(panel.getByRole("heading", { name: "input5", exact: true })).toBeVisible();

  const description = panel.getByRole("region", { name: "Node description", exact: true });
  await description.locator("summary").click();
  await description.getByRole("textbox", { name: "Description", exact: true }).fill("Unsaved browser navigation fixture");
  await back.click();
  const warning = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
  await expect(warning).toBeVisible();
  await warning.getByRole("button", { name: "Keep Editing", exact: true }).click();
  await expect(description.getByRole("textbox", { name: "Description", exact: true })).toHaveValue("Unsaved browser navigation fixture");
  await page.goBack();
  await expect(warning).toBeVisible();
  await warning.getByRole("button", { name: "Keep Editing", exact: true }).click();
  await expect(back).toBeVisible();
  await back.click();
  await warning.getByRole("button", { name: "Discard and Continue", exact: true }).click();
  await expect(entry).toBeFocused();
  await entry.press("Enter");
  await panel.getByRole("button", { name: "Back to Resources", exact: true }).click();
  await expect(page.locator('[data-resource-id="resource:settings"]')).toBeFocused();
  await expect(page.getByRole("combobox", { name: "Map resource type" })).toHaveValue("Input group");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(studio.requests.filter(request => /apply$/.test(request.path))).toHaveLength(0);
});

test("a direct inspector link has a safe Resources fallback", async ({ page, studio }) => {
  await studio.goto("/?select=lambda%3Afixture-0");
  const inspector = page.getByRole("complementary", { name: "Inspector", exact: true });
  await inspector.getByRole("button", { name: "Back to Resources", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Resources", exact: true })).toBeVisible();
  await expect(page.locator('[data-resource-id="lambda:fixture-0"]')).toBeFocused();
  await expect(page).toHaveURL("http://127.0.0.1:4592/");
});
