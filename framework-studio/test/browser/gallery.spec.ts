import { test, expect, assertAccessible } from "./support/test";
import { writeFile } from "node:fs/promises";

test("baseline shared controls and disclosure", async ({ page, studio }, testInfo) => {
  await page.goto("http://127.0.0.1:4593/");
  await expect(page.getByRole("heading", { name: "Studio controls" })).toBeVisible();
  await studio.settle();
  const metrics = await page.evaluate(() => [...document.querySelectorAll("section,h3,fieldset,legend,summary,input,select,textarea,button")].map(element => {
    const bounds = element.getBoundingClientRect(), style = getComputedStyle(element);
    return { tag: element.tagName, name: element.getAttribute("aria-label") ?? element.id ?? element.textContent?.trim().slice(0, 60), text: element.textContent?.trim().slice(0, 60), x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, font: style.font, padding: style.padding, margin: style.margin, minHeight: style.minHeight, border: style.border, color: style.color, background: style.backgroundColor };
  }));
  await writeFile(testInfo.outputPath("gallery-metrics.json"), JSON.stringify(metrics, null, 2));
  await expect(page).toHaveScreenshot("shared-controls.png", { fullPage: true });
  await page.getByRole("switch", { name: "Example setting" }).click();
  await expect(page.getByRole("switch", { name: "Example setting" })).toHaveAttribute("aria-checked", "true");
  await page.getByText("Supporting details", { exact: true }).click();
  await expect(page.getByText("Details retain their native keyboard behavior.")).toBeVisible();
});

test("baseline unrouted Board retains geometry and resource actions", async ({ page, studio }) => {
  await page.goto("http://127.0.0.1:4593/?view=board");
  await expect(page.getByRole("group", { name: "Application architecture" })).toBeVisible();
  await studio.settle();
  await expect(page).toHaveScreenshot("board-desktop.png", { fullPage: true });
  await page.setViewportSize({ width: 420, height: 850 });
  await expect(page.getByRole("button", { name: "Add to application", exact: true })).toBeVisible();
});

test("native dialog contains focus and restores its trigger", async ({ page, studio }) => {
  await page.goto("http://127.0.0.1:4593/");
  const trigger = page.getByRole("button", { name: "Open example dialog" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Example dialog" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Dialog name" }).fill("Keyboard test");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await assertAccessible(page);
  await studio.settle();
});

test("tag deletion and endpoint picker retain useful keyboard focus", async ({ page }) => {
  await page.goto("http://127.0.0.1:4593/");
  await page.getByRole("button", { name: "Add tag", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Tag 2 key" })).toBeFocused();
  await page.getByRole("button", { name: "Remove tag 2", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Tag 1 key" })).toBeFocused();
  await page.getByRole("button", { name: "Choose interface endpoint services" }).click();
  await expect(page.getByRole("searchbox", { name: "Search interface endpoint services" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Choose interface endpoint services" })).toBeFocused();
});

test("forced colors retain native select behavior and invalid and disabled semantics", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.goto("http://127.0.0.1:4593/");
  const select = page.getByRole("combobox", { name: "Choice", exact: true });
  await select.focus();
  await page.keyboard.press("t");
  await page.keyboard.press("Enter");
  await expect(select).toHaveValue("two");
  await expect(page.getByRole("textbox", { name: "Invalid field", exact: true })).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("button", { name: "Disabled", exact: true })).toBeDisabled();
});
