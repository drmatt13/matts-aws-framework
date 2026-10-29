import { test, expect } from "./support/test";

test("database keyboard layout resizing and modal focus preserve the same editor", async ({ page, studio }) => {
  await studio.goto("/database");
  const editor = page.getByRole("textbox", { name: "Prisma schema source" });
  await expect(editor).toContainText("model Note");
  const splitter = page.getByRole("separator", { name: "Resize source and diagram" });
  await splitter.focus();
  await page.keyboard.press("ArrowRight");
  await expect(splitter).toHaveAttribute("aria-valuenow", "51");
  await expect(splitter).toBeFocused();
  await page.getByRole("button", { name: "Focus source", exact: true }).click();
  await expect(editor).toBeVisible();
  await page.getByRole("button", { name: "Split source and diagram", exact: true }).click();
  await expect(page.getByRole("button", { name: "Select table Note" })).toBeVisible();
  const help = page.getByRole("button", { name: "How this works", exact: true });
  await help.click();
  const dialog = page.getByRole("dialog", { name: "How this works" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(help).toBeFocused();
  await expect(editor).toContainText("model Note");
});

test("schema search reset and source-review shortcut do not save", async ({ page, studio }) => {
  await studio.goto("/database");
  const search = page.getByRole("searchbox", { name: "Find a table or column" });
  await search.fill("Note");
  await page.getByRole("button", { name: "Clear schema search" }).click();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("");
  const editor = page.getByRole("textbox", { name: "Prisma schema source" });
  await editor.click();
  await page.keyboard.press("ControlOrMeta+f");
  await expect(page.getByRole("textbox", { name: "Find", exact: true })).toBeVisible();
  expect(studio.requests.filter(request => request.path.endsWith("/save"))).toHaveLength(0);
});

test("native fullscreen preserves the mounted editor and restores the previous layout", async ({ page, studio }) => {
  await studio.goto("/database");
  const editor = page.getByRole("textbox", { name: "Prisma schema source" });
  const originalEditor = await editor.elementHandle();
  await page.getByRole("button", { name: "Fullscreen schema workspace", exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
  await expect(page.getByRole("navigation", { name: "Database workspace", exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Focus diagram", exact: true }).click();
  await expect(editor).toBeHidden();
  await expect(page.getByRole("button", { name: "Select table Note", exact: true })).toBeVisible();
  expect(await originalEditor!.evaluate(element => element.isConnected)).toBe(true);
  await page.getByRole("button", { name: "Exit fullscreen", exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect(editor).toBeVisible();
  await expect(editor).toContainText("model Note");
  expect(await originalEditor!.evaluate(element => element.isConnected)).toBe(true);
  await expect(page.getByRole("button", { name: "Fullscreen schema workspace", exact: true })).toBeFocused();
  expect(studio.requests.filter(request => request.path.endsWith("/save"))).toHaveLength(0);
});
