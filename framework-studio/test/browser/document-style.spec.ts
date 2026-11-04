import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./support/test";
import { discovery, overview } from "./support/scenarios";

async function expectPageColumn(page: Page, element: Locator) {
  const width = page.viewportSize()!.width;
  const left = Math.max(0, (width - 1280) / 2) + 16;
  const box = await element.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeCloseTo(left, 0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width - left + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

async function expectPageTitle(page: Page) {
  const title = page.locator("main h1:visible");
  await expect(title).toHaveCount(1);
  await expect(title).toHaveCSS("font-size", "18px");
  await expect(title).toHaveCSS("font-family", /Barlow/);
  await expect(title).not.toHaveCSS("font-family", /Semi Condensed/);
  await expect(title).toHaveCSS("font-weight", "600");
  await expectPageColumn(page, title);
  return title;
}

for (const width of [1440, 390]) test.describe(`document styles at ${width}px`, () => {
  test.use({ viewport: { width, height: 1000 } });

  test("page titles and reading cards share typography, padding and surfaces", async ({ page, studio }) => {
    const pages = [
      { path: "/deploy", heading: "This machine" },
      { path: "/graphql", heading: "Coming soon" },
      { path: "/cognito/user-pools", heading: "Application user pool" },
      { path: "/domains", heading: "Read-only deployment inspection" },
    ];
    for (const { path, heading } of pages) {
      await studio.goto(path);
      await expectPageTitle(page);
      const cardHeading = page.getByRole("heading", { name: heading, exact: true });
      await expect(cardHeading).toBeVisible();
      await expect(cardHeading).toHaveCSS("font-size", "15px");
      await expect(cardHeading).toHaveCSS("font-weight", "600");
      const card = cardHeading.locator("xpath=ancestor::section[1]");
      await expect(card).toHaveCSS("border-top-left-radius", "6px");
      await expect(card).toHaveCSS("padding-left", width <= 720 ? "12px" : "16px");
      await expect(card).toHaveCSS("padding-top", width <= 720 ? "12px" : "16px");
      await expectPageColumn(page, card);
      const levels = await page.locator("main :is(h1,h2,h3,h4):visible").evaluateAll(headings => headings.map(heading => Number(heading.tagName.slice(1))));
      for (let index = 1; index < levels.length; index++)
        expect(levels[index] - levels[index - 1], `${path} does not skip a heading level`).toBeLessThanOrEqual(1);
      if (path === "/graphql") {
        const paragraph = card.getByText("GraphQL tools will be available here.", { exact: true });
        await expect(paragraph).toHaveCSS("font-size", "14px");
        const titleBox = await cardHeading.boundingBox(), copyBox = await paragraph.boundingBox();
        expect(copyBox!.y - titleBox!.y - titleBox!.height).toBeCloseTo(12, 0);
      }
      if (path === "/cognito/user-pools") {
        const summary = page.locator("summary").filter({ hasText: "Evidence and action boundaries" });
        await expect(summary).toHaveCSS("font-size", "13px");
        await expect(summary).toHaveCSS("font-weight", "600");
        expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(32);
        await summary.focus();
        await page.keyboard.press("Enter");
        await expect(summary.locator("..")).toHaveAttribute("open", "");
        await page.keyboard.press("Enter");
        await expect(summary.locator("..")).not.toHaveAttribute("open");
        const deploymentLabel = page.getByRole("combobox", { name: "Identity deployment", exact: true }).locator("..");
        await expect(deploymentLabel).toHaveCSS("font-size", "13px");
        await page.getByRole("navigation", { name: "Cognito sections", exact: true }).getByRole("link", { name: "Identity Pools", exact: true }).click();
        const declaredPools = page.getByRole("heading", { name: "Declared identity pools", exact: true }).locator("xpath=ancestor::section[1]");
        const policies = declaredPools.getByRole("link", { name: "Review reader policies and simulate permissions", exact: true });
        const copy = await declaredPools.locator(":scope > p").last().boundingBox();
        const link = await policies.boundingBox(), poolCard = await declaredPools.boundingBox();
        expect(link!.y - copy!.y - copy!.height, "source action stays 12px below its supporting prose").toBeCloseTo(12, 0);
        expect(link!.x + link!.width).toBeLessThanOrEqual(poolCard!.x + poolCard!.width);
      }
    }
  });

  test("Deploy keeps its document frame during loading, failure and keyboard retry", async ({ page, studio }) => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let fail = true;
    studio.reply("GET", "/api/deploy/overview", async route => {
      await pending;
      await route.fulfill(fail
        ? { status: 500, json: { error: "Fixture deployment overview unavailable. " + "Long diagnostic detail ".repeat(12) } }
        : { json: overview() });
    });
    await page.goto("/deploy");
    const loading = page.getByRole("status").filter({ hasText: "Reading this machine" });
    await expect(loading).toBeVisible();
    await expectPageTitle(page);
    release();
    const failure = page.getByRole("alert").filter({ hasText: "Fixture deployment overview unavailable" });
    await expect(failure).toBeVisible({ timeout: 15_000 });
    await expectPageTitle(page);
    expect(await failure.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    fail = false;
    const retry = page.getByRole("button", { name: "Try again", exact: true });
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: /^browser-dev/ })).toBeVisible();
    await expect(failure).toHaveCount(0);
    await expectPageTitle(page);
    expect(studio.requests.some(request => request.path === "/api/deploy/operations")).toBe(false);
  });

  test("Deploy empty profiles and undeclared mode keep the same page title and column", async ({ page, studio }) => {
    studio.reply("GET", "/api/deploy/overview", route => route.fulfill({ json: { ...overview(), profiles: [] } }));
    await studio.goto("/deploy");
    await expect(page.getByText("No AWS profiles on this machine", { exact: true })).toBeVisible();
    await expectPageTitle(page);
    await expect(page.getByRole("region", { name: "Machine readiness", exact: true })).toBeVisible();
    studio.reply("GET", "/api/deploy/overview", route => route.fulfill({ json: { ...overview(), targets: [] } }));
    studio.reply("GET", "/api/deploy/discover", route => route.fulfill({ json: { ok: true, value: { ...discovery(), targets: [] } } }));
    await studio.goto("/deploy");
    await expect(page.getByText("No development deployment is declared in this repository.", { exact: true })).toBeVisible();
    await expectPageTitle(page);
    await expect(page.getByRole("region", { name: "Machine readiness", exact: true })).toBeVisible();
  });

  test("Deploy partial read failures retain the deployment and bounded retry feedback", async ({ page, studio }) => {
    let fail = true;
    studio.reply("GET", "/api/deploy/plans", route => route.fulfill(fail
      ? { status: 500, json: { error: "Fixture plans unavailable. " + "Long diagnostic detail ".repeat(12) } }
      : { json: [] }));
    await studio.goto("/deploy");
    const failure = page.getByRole("alert").filter({ hasText: "Some information could not be refreshed" });
    await expect(failure).toBeVisible({ timeout: 15_000 });
    await expectPageTitle(page);
    await expect(page.getByRole("heading", { name: /^browser-dev/ })).toBeVisible();
    expect(await failure.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    fail = false;
    await failure.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(failure).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /^browser-dev/ })).toBeVisible();
    expect(studio.requests.some(request => request.path === "/api/deploy/operations")).toBe(false);
  });
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 480 }])
  test(`Deploy keeps Activity reachable below a stale configuration banner at ${viewport.width}px`, async ({ page, studio }, info) => {
    await page.setViewportSize(viewport);
    Object.assign(studio.response.snapshot.models.dev, { stale: true });
    await studio.goto("/deploy");
    await expect(page.getByRole("status").filter({ hasText: "The configuration does not load right now" })).toBeVisible();
    await expectPageTitle(page);
    const activity = page.getByRole("region", { name: "Activity", exact: true });
    const toggle = activity.getByRole("button", { name: /^Activity/ });
    const geometry = await page.locator("main").evaluate(element => ({
      height: element.clientHeight, scrollHeight: element.scrollHeight,
      documentHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight,
    }));
    await info.attach("stale-deploy-geometry", { body: JSON.stringify(geometry, null, 2), contentType: "application/json" });
    expect(geometry.documentHeight).toBeLessThanOrEqual(geometry.viewportHeight);
    await toggle.scrollIntoViewIfNeeded();
    await toggle.focus();
    await expect(toggle).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(toggle).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
