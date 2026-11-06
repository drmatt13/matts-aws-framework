import { test, expect, assertAccessible } from "./support/test";

for (const width of [1440, 390]) test(`Bottom panel resizes only from its top edge and reaches the window top at ${width}px`, async ({ page, studio }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await studio.goto("/");
  const tray = page.getByRole("region", { name: "Activity", exact: true });
  const toggle = tray.getByRole("button", { name: /^Activity:/ });
  const separator = tray.getByRole("separator", { name: "Resize bottom panel" });
  const drawer = page.locator("#studio-activity-drawer");
  const size = async () => (await drawer.boundingBox())!.height;
  const canvas = page.locator('[data-ui="landscape-canvas"]');
  const initialCanvas = await canvas.boundingBox();
  const camera = await page.evaluate(() => JSON.stringify((window as unknown as { __studioLandscape: { camera(): unknown } }).__studioLandscape.camera()));

  await toggle.click();
  await expect.poll(size).toBe(340);
  await expect(separator).toHaveAttribute("aria-valuenow", "340");
  const bar = (await toggle.boundingBox())!;
  await expect(toggle).toHaveCSS("cursor", "pointer");
  const x = bar.x + 20, y = bar.y + bar.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 100, { steps: 8 });
  await page.mouse.up();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(await size()).toBe(340);

  const initialEdge = (await separator.boundingBox())!;
  const edgeY = initialEdge.y + initialEdge.height / 2;
  await page.mouse.move(width / 2, edgeY);
  await page.mouse.down();
  await page.mouse.move(width / 2, edgeY - 100, { steps: 8 });
  // This checks the size before mouseup: there must be no transition lag.
  expect(await size()).toBeCloseTo(440, 0);
  await page.mouse.up();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(await size()).toBeCloseTo(440, 0);
  await studio.settle();
  expect(await canvas.boundingBox()).toEqual(initialCanvas);
  expect(await page.evaluate(() => JSON.stringify((window as unknown as { __studioLandscape: { camera(): unknown } }).__studioLandscape.camera()))).toBe(camera);

  const edge = (await separator.boundingBox())!;
  await page.mouse.move(width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(width / 2, edge.y + edge.height / 2 + 160, { steps: 8 });
  await page.mouse.up();
  await expect.poll(size).toBe(280);
  await toggle.click();
  await expect.poll(size).toBe(0);
  await toggle.click();
  await expect.poll(size).toBe(280);
  await separator.focus();
  await page.keyboard.press("End");
  await expect.poll(async () => (await tray.boundingBox())!.y).toBeCloseTo(0, 0);
  await studio.settle();
  expect(await canvas.boundingBox()).toEqual(initialCanvas);
  expect(await page.evaluate(() => JSON.stringify((window as unknown as { __studioLandscape: { camera(): unknown } }).__studioLandscape.camera()))).toBe(camera);
  await page.keyboard.press("Home");
  await expect.poll(size).toBe(120);
  await studio.settle();
  expect(await canvas.boundingBox()).toEqual(initialCanvas);
  await page.getByRole("navigation", { name: "Views", exact: true }).getByRole("link", { name: "GraphQL", exact: true }).click();
  await expect.poll(size).toBe(120);

  await separator.focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(size).toBe(144);
  await page.keyboard.press("ArrowDown");
  await expect.poll(size).toBe(120);
  await page.keyboard.press("Home");
  await expect.poll(size).toBe(120);
  await page.keyboard.press("End");
  await expect.poll(size).toBe(Number(await separator.getAttribute("aria-valuemax")));
  expect((await tray.boundingBox())!.y).toBeCloseTo(0, 0);
  await page.setViewportSize({ width, height: 480 });
  await expect.poll(async () => await size() - Number(await separator.getAttribute("aria-valuemax"))).toBe(0);
  const bounds = (await tray.boundingBox())!;
  expect(bounds.y).toBeCloseTo(0, 0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(481);
  await page.keyboard.press("Home");
  await expect.poll(size).toBe(120);
  // Pointer input reaches the same full-window limit as the End key.
  const smallEdge = (await separator.boundingBox())!;
  await page.mouse.move(width / 2, smallEdge.y + smallEdge.height / 2);
  await page.mouse.down();
  await page.mouse.move(width / 2, 0, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await tray.boundingBox())!.y).toBeCloseTo(0, 0);
  // Restore some workspace for the whole-page accessibility scan.
  await separator.focus();
  await page.keyboard.press("Home");
  await expect.poll(size).toBe(120);
  await assertAccessible(page);
});

test("The collapsed panel has no resize handle, highlight or drag behavior", async ({ page, studio }) => {
  await studio.goto("/graphql");
  const tray = page.getByRole("region", { name: "Activity", exact: true });
  const toggle = tray.getByRole("button", { name: /^Activity:/ });
  const bar = (await toggle.boundingBox())!;
  await expect(tray.getByRole("separator")).toHaveCount(0);
  await expect(toggle).toHaveCSS("cursor", "pointer");
  const x = bar.x + 20, y = (await tray.boundingBox())!.y - 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 240, { steps: 8 });
  await page.mouse.up();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(tray.getByRole("separator")).toHaveCount(0);
  await expect.poll(async () => (await page.locator("#studio-activity-drawer").boundingBox())!.height).toBe(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(tray.getByRole("separator", { name: "Resize bottom panel" })).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(tray.getByRole("separator")).toHaveCount(0);
});
