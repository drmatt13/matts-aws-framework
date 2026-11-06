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
  await expect.poll(size).toBe(100);
  await studio.settle();
  expect(await canvas.boundingBox()).toEqual(initialCanvas);
  await page.getByRole("navigation", { name: "Views", exact: true }).getByRole("link", { name: "GraphQL", exact: true }).click();
  await expect.poll(size).toBe(100);

  await separator.focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(size).toBe(124);
  await page.keyboard.press("ArrowDown");
  await expect.poll(size).toBe(100);
  await page.keyboard.press("Home");
  await expect.poll(size).toBe(100);
  await page.keyboard.press("End");
  await expect.poll(size).toBe(Number(await separator.getAttribute("aria-valuemax")));
  expect((await tray.boundingBox())!.y).toBeCloseTo(0, 0);
  await page.setViewportSize({ width, height: 480 });
  await expect.poll(async () => await size() - Number(await separator.getAttribute("aria-valuemax"))).toBe(0);
  const bounds = (await tray.boundingBox())!;
  expect(bounds.y).toBeCloseTo(0, 0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(481);
  await page.keyboard.press("Home");
  await expect.poll(size).toBe(100);
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
  await expect.poll(size).toBe(100);
  if (width === 390) {
    const content = tray.getByRole("tabpanel", { name: "Activity", exact: true });
    await content.focus();
    await page.keyboard.press("PageDown");
    await expect.poll(() => content.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  }
  await assertAccessible(page);
});

for (const width of [1440, 390]) test(`Dragging below the minimum closes the panel and resets its next opening at ${width}px`, async ({ page, studio }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await studio.goto("/");
  const tray = page.getByRole("region", { name: "Activity", exact: true });
  const toggle = tray.getByRole("button", { name: /^Activity:/ });
  const separator = tray.getByRole("separator", { name: "Resize bottom panel" });
  const drawer = page.locator("#studio-activity-drawer");
  const shell = page.locator('[data-ui="shell"]');
  const size = async () => (await drawer.boundingBox())!.height;

  await toggle.click();
  await expect.poll(size).toBe(340);
  await separator.focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(size).toBe(364);
  const edge = (await separator.boundingBox())!;
  const y = edge.y + edge.height / 2;
  await page.mouse.move(width / 2, y);
  await page.mouse.down();
  await page.mouse.move(width / 2, y + 264, { steps: 8 });
  expect(await size()).toBe(100);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.mouse.move(width / 2, y + 276, { steps: 4 });
  // Collapse immediately, without needing to release or finish at the window bottom.
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(separator).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await expect(shell).not.toHaveAttribute("data-activity-resizing");
  await page.mouse.move(width / 2, y);
  await page.mouse.up();
  await expect.poll(size).toBe(0);
  await expect(drawer).toHaveAttribute("inert", "");

  // Reopening uses the current viewport's CSS default, not the old size or minimum.
  await page.setViewportSize({ width, height: 480 });
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect.poll(size).toBeCloseTo(480 * 0.42, 0);
  await expect(drawer).not.toHaveAttribute("inert");
  await separator.focus();
  await page.keyboard.press("Home");
  await expect.poll(size).toBe(100);
  await page.keyboard.press("ArrowUp");
  await expect.poll(size).toBe(124);
  await assertAccessible(page);
});

for (const width of [1440, 390]) test(`The collapsed bar pulls the panel open without turning the drag into a click at ${width}px`, async ({ page, studio }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  studio.reply("GET", "/api/agent-lab/status", route => route.fulfill({ json: {
    providers: [{ id: "codex", label: "Codex", available: false, detail: "Fixture CLI is not installed." }], busy: false,
  } }));
  await studio.goto("/graphql");
  const tray = page.getByRole("region", { name: "Activity", exact: true });
  const toggle = tray.getByRole("button", { name: /^Activity:/ });
  const drawer = page.locator("#studio-activity-drawer");
  const size = async () => (await drawer.boundingBox())!.height;
  const pull = async (amount: number) => {
    const bar = (await toggle.boundingBox())!;
    const x = bar.x + 20, y = bar.y + bar.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - amount, { steps: 8 });
    expect(await size()).toBeCloseTo(amount, 0);
    await page.mouse.up();
  };

  await expect(tray.getByRole("separator")).toHaveCount(0);
  await expect(toggle).toHaveCSS("cursor", "pointer");
  // Mode buttons open their panel; the separate toggle can collapse it before dragging.
  await tray.getByRole("tab", { name: "Agent", exact: true }).click();
  await tray.getByRole("tab", { name: "Activity", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect.poll(size).toBe(0);
  await pull(60);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect.poll(size).toBe(0);
  await expect(tray.getByRole("separator")).toHaveCount(0);

  // A pending default reset must not override the height of a manual opening.
  await pull(220);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect.poll(size).toBe(220);
  await expect(page.locator('[data-ui="shell"]')).not.toHaveAttribute("data-activity-resizing");
  await toggle.click();
  await expect.poll(size).toBe(0);
  await toggle.click();
  await expect.poll(size).toBe(220);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(tray.getByRole("separator", { name: "Resize bottom panel" })).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(tray.getByRole("separator")).toHaveCount(0);
});
