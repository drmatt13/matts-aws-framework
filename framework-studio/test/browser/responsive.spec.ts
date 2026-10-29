import { test, expect } from "./support/test";

test("navbar and map layout preserve exact breakpoint boundaries", async ({ page, studio }) => {
  await studio.goto();
  for (const width of [559, 560, 561, 759, 760, 761, 799, 800, 801, 1100, 1101]) {
    await page.setViewportSize({ width, height: 1000 });
    await studio.settle();
    const header = await page.locator("header").first().boundingBox();
    expect(header!.height, `navbar at ${width}px`).toBe(width <= 560 ? 129 : width <= 760 ? 89 : 52);
    const search = await page.getByRole("searchbox", { name: "Search isometric map" }).boundingBox();
    const tools = await page.getByRole("group", { name: "Map view controls" }).boundingBox();
    const canvas = await page.locator("canvas").boundingBox();
    expect(canvas!.y, `canvas below controls at ${width}px`).toBeGreaterThanOrEqual(Math.max(search!.y + search!.height, tools!.y + tools!.height));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `document overflow at ${width}px`).toBe(true);
  }
});

test("map panel switches beside and below canvas at 800px", async ({ page, studio }) => {
  await studio.goto();
  await page.getByRole("button", { name: "Resources", exact: true }).click();
  for (const width of [799, 800, 801]) {
    await page.setViewportSize({ width, height: 1000 });
    await studio.settle();
    const panel = await page.getByRole("complementary", { name: "Resources", exact: true }).boundingBox();
    const canvas = await page.locator("canvas").boundingBox();
    if (width <= 800) {
      expect(panel!.width).toBe(width);
      expect(panel!.y).toBeGreaterThanOrEqual(canvas!.y + canvas!.height);
    } else {
      expect(panel!.width).toBe(380);
      expect(panel!.x).toBeGreaterThanOrEqual(canvas!.x + canvas!.width);
    }
  }
});

test("real inspector fields respond to named container widths", async ({ page }) => {
  await page.goto("http://127.0.0.1:4593/?view=containers");
  for (const width of [299, 300, 301, 359, 360, 361, 380, 419, 420, 421]) {
    const container = page.getByRole("region", { name: `Inspector ${width}px`, exact: true });
    const field = container.locator('[data-slot="field"]');
    const label = await field.locator("label").boundingBox();
    const input = await field.getByRole("spinbutton", { name: "Memory in MB" }).boundingBox();
    expect((await container.boundingBox())!.width).toBe(width);
    if (width <= 420) expect(input!.y).toBeGreaterThanOrEqual(label!.y + label!.height);
    else expect(input!.x).toBeGreaterThanOrEqual(label!.x + label!.width);
    expect(await container.evaluate(element => element.scrollWidth <= element.clientWidth), `container overflow at ${width}px`).toBe(true);
  }
});

test.describe("coarse input and DPR 2", () => {
  test.use({ hasTouch: true, isMobile: true, deviceScaleFactor: 2, viewport: { width: 420, height: 900 } });
  test("canvas pixels and touch inspector targets follow their real viewport", async ({ page, studio }) => {
    await studio.goto();
    expect(await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches)).toBe(true);
    const bitmap = await page.locator("canvas").evaluate(canvas => ({ width: (canvas as HTMLCanvasElement).width, cssWidth: canvas.getBoundingClientRect().width, dpr: devicePixelRatio }));
    expect(bitmap.dpr).toBe(2);
    expect(bitmap.width).toBe(Math.round(bitmap.cssWidth * 2));
    await page.getByRole("button", { name: "Resources", exact: true }).tap();
    await page.locator('[data-resource-id="lambda:fixture-0"]').tap();
    const inspector = page.getByRole("complementary", { name: "Inspector", exact: true });
    await inspector.getByRole("region", { name: "Node description" }).locator("summary").tap();
    const summary = await inspector.getByRole("region", { name: "Node description" }).locator("summary").boundingBox();
    expect(summary!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});
