import { test, expect } from "./support/test";

const creators = ["Function", "Stack", "VPC", "Workflow", "Container service", "Container task", "API route", "Agent", "Agent tool", "Input parameter or secret", "Authentication provider"] as const;

for (const width of [1440, 390]) test(`all creation forms accept pointer input and keep expanded settings bounded at ${width}px`, async ({ page, studio }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width, height: 1000 });
  await studio.goto();
  for (const creator of creators) {
    await page.getByRole("button", { name: "Add to application", exact: true }).click();
    await page.getByRole("dialog", { name: "Add to application", exact: true }).getByRole("button", { name: creator, exact: true }).click();
    const dialog = page.locator("dialog[open]");
    const identifier = dialog.getByRole("textbox", { name: "Stable identifier", exact: true });
    // A real pointer click catches inherited pointer-events:none; fill alone would not.
    await identifier.click();
    await identifier.fill("second-pass-example");
    await expect(identifier).toBeFocused();
    while (await dialog.locator("details:visible:not([open]) > summary").count()) await dialog.locator("details:visible:not([open]) > summary").first().click();
    const branching = dialog.locator('select').filter({ has: page.locator('option[value="http"], option[value="identity-pool"], option[value="saml"], option[value="model"], option[value="existing"]') });
    const branchIds = await branching.evaluateAll(selects => selects.map(select => select.id));
    for (const id of branchIds) {
      const select = dialog.locator(`[id="${id}"]`);
      const values = await select.locator("option:not(:disabled)").evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
      for (const value of values) { await select.selectOption(value); await expect(select).toHaveValue(value); }
    }
    if (creator === "Input parameter or secret") {
      const secret = dialog.getByRole("switch", { name: "Secret", exact: true });
      await secret.click(); await expect(secret).toHaveAttribute("aria-checked", "true");
      await secret.click(); await expect(secret).toHaveAttribute("aria-checked", "false");
    }
    const metrics = await dialog.evaluate(root => {
      const bounds = root.getBoundingClientRect();
      const controls = [...root.querySelectorAll<HTMLElement>("input, select, textarea, button")].filter(el => el.checkVisibility()).map(el => {
        const box = el.getBoundingClientRect();
        return { label: el.getAttribute("aria-label") ?? (el as HTMLInputElement).labels?.[0]?.textContent ?? el.textContent, left: box.left - bounds.left, right: box.right - bounds.right, width: box.width };
      });
      return { width: bounds.width, viewport: innerWidth, pointer: getComputedStyle(root).pointerEvents, controls };
    });
    expect(metrics.pointer).toBe("auto");
    expect(metrics.width).toBeLessThanOrEqual(width);
    for (const control of metrics.controls) {
      expect(control.left, `${creator}: ${control.label} left edge`).toBeGreaterThanOrEqual(0);
      expect(control.right, `${creator}: ${control.label} right edge`).toBeLessThanOrEqual(1);
      expect(control.width, `${creator}: ${control.label} width`).toBeGreaterThan(10);
    }
    await testInfo.attach(`${creator}-${width}-geometry`, { body: JSON.stringify(metrics, null, 2), contentType: "application/json" });
    const body = dialog.locator(":scope > div");
    const extent = await body.evaluate(el => ({ height: el.clientHeight, total: el.scrollHeight }));
    for (let top = 0, frame = 0; top < extent.total; top += Math.max(200, extent.height - 80), frame++) {
      await body.evaluate((el, top) => { el.scrollTop = top; }, top);
      await testInfo.attach(`${creator}-${width}-${frame}`, { body: await dialog.screenshot(), contentType: "image/png" });
      if (top + extent.height >= extent.total) break;
    }
    await dialog.getByRole("button", { name: "Cancel creation", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  expect(studio.requests.filter(request => request.method !== "GET")).toEqual([]);
});
