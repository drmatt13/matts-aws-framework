import { test, expect, assertAccessible } from "./support/test";
import { discovery, overview, NOW } from "./support/scenarios";
import { connectionCatalogFixture } from "./support/aws-connections";

test.beforeEach(async ({ context, studio }) => {
  await context.addInitScript(() => {
    localStorage.setItem("aws-studio:mode-profiles:v1:/studio-fixture", JSON.stringify({ dev: "dev-connection", prod: "prod-connection" }));
  });
  studio.reply("GET", "/api/aws-connections", route => route.fulfill({ json: connectionCatalogFixture([
    { name: "dev-connection", kind: "sso" }, { name: "prod-connection", kind: "sso" },
  ]) }));
  studio.reply("GET", "/api/deploy/status", (route, url) => route.fulfill({ json: { ok: true, value: {
    ...discovery(),
    context: { ...discovery().context, profile: url.searchParams.get("profile") },
    deployment: url.searchParams.get("deployment"),
  } } }));
});

for (const width of [1440, 320])
  test(`Deploy aligns machine readiness to the right with Docker remediation first at ${width}px`, async ({ page, studio }, testInfo) => {
    studio.reply("GET", "/api/deploy/overview", route => route.fulfill({ json: {
      ...overview(), prerequisites: [
        ...Array.from({ length: 5 }, (_, index) => ({ id: `check-${index}`, label: `Tool ${index + 1}`, status: "ok", summary: "Available" })),
        { id: "docker", label: "Docker", status: "warn", summary: "Docker Desktop is not running.", remedy: { kind: "docker-start", params: {} } },
      ],
    } }));
    await page.setViewportSize({ width, height: 900 });
    await studio.goto("/deploy");
    const toolbar = page.getByRole("region", { name: "Machine readiness", exact: true });
    const passed = toolbar.getByRole("button", { name: "This machine · 5 checks passed", exact: true });
    await expect(passed).toBeVisible();
    await expect(toolbar.getByText("Docker Desktop is not running.", { exact: true })).toBeVisible();
    await expect(toolbar.getByRole("button", { name: "Start", exact: true })).toBeVisible();
    await expect(toolbar).not.toContainText("Connection:");
    await expect(toolbar).not.toContainText("Account");
    await expect(toolbar.getByRole("button", { name: /Refresh|Manage connection/ })).toHaveCount(0);
    const before = await toolbar.boundingBox();
    const heading = page.getByRole("heading", { name: /^browser-dev/ });
    const headingBefore = await heading.boundingBox();
    await expect(toolbar.getByRole("button")).toHaveText(["Start", "This machine · 5 checks passed"]);
    expect(before!.x + before!.width).toBeCloseTo(width - Math.max(0, (width - 1280) / 2) - 16, 0);
    if (width === 1440) {
      expect(before!.x).toBeGreaterThan(headingBefore!.x + headingBefore!.width);
      expect(before!.y + before!.height / 2).toBeCloseTo(headingBefore!.y + headingBefore!.height / 2, 0);
    } else {
      expect(before!.y).toBeGreaterThanOrEqual(headingBefore!.y + headingBefore!.height);
    }
    await expect(page.getByRole("navigation", { name: "Deployments", exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Repository", exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "AWS", exact: true })).toHaveCount(0);
    await expect(page.getByText("Add a deployment stage", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Compare AWS templates/ })).toHaveCount(0);
    const popup = page.getByRole("dialog", { name: "This machine", exact: true });
    await toolbar.getByRole("button", { name: "Start", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(passed).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(popup.getByRole("list", { name: "Passed machine checks", exact: true })).toBeVisible();
    await expect(passed).toHaveAttribute("aria-expanded", "true");
    await expect(passed).toBeFocused();
    expect(await toolbar.boundingBox()).toEqual(before);
    expect(await heading.boundingBox()).toEqual(headingBefore);
    const bounds = await popup.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(12);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width - 12);
    await assertAccessible(page);
    await page.screenshot({ path: testInfo.outputPath("deploy-machine-popover.png"), fullPage: true });
    await page.keyboard.press("Tab");
    await expect(popup.getByRole("button", { name: "Close machine checks" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(popup).toBeHidden();
    await expect(passed).toBeFocused();
    await passed.click();
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden();
    await expect(passed).toBeFocused();
    await expect(passed).toHaveAttribute("aria-expanded", "false");
    await passed.click();
    await page.getByRole("group", { name: "Source environment", exact: true }).getByText("Source", { exact: true }).click();
    await expect(popup).toBeHidden();
    await passed.click();
    await page.getByRole("button", { name: "Development AWS profile: dev-connection", exact: true }).click();
    await expect(popup).toBeHidden();
    await page.keyboard.press("Escape");
    await passed.click();
    await page.setViewportSize({ width: 320, height: 480 });
    await expect.poll(async () => {
      const box = await popup.boundingBox();
      return box !== null && box.x >= 12 && box.x + box.width <= 308 && box.y + box.height <= 468;
    }).toBe(true);
    expect(await popup.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await popup.getByText("Tool 5", { exact: true }).scrollIntoViewIfNeeded();
    await expect(popup.getByText("Tool 5", { exact: true })).toBeInViewport();
    await page.keyboard.press("Escape");
    await expect(passed).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(studio.requests.some(request => request.path === "/api/deploy/operations")).toBe(false);
  });

test("Source mode switches the deployment using the accepted mode's profile", async ({ page, studio }) => {
  await studio.goto("/deploy");
  const mode = page.getByRole("group", { name: "Source environment", exact: true });
  await expect(page.getByRole("heading", { name: /^browser-dev/ })).toBeVisible();
  await expect(page.getByText("Default development stage", { exact: true })).toHaveCount(0);
  await mode.getByRole("button", { name: "Production", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^browser-prod/ })).toBeVisible();
  await expect(page.getByText("Declared in cdk-app/cdk.json", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Production AWS profile: prod-connection", exact: true })).toBeVisible();
  await expect.poll(() => studio.requests.some(request => request.path.includes("/api/deploy/status?") && request.path.includes("deployment=browser-prod") && request.path.includes("profile=prod-connection"))).toBe(true);
  expect(studio.requests.some(request => request.path.includes("deployment=browser-prod") && request.path.includes("profile=dev-connection"))).toBe(false);
  await mode.getByRole("button", { name: "Development", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^browser-dev/ })).toBeVisible();
  expect(studio.requests.some(request => request.path === "/api/deploy/operations")).toBe(false);
});

for (const mode of ["Development", "Production"] as const)
  test(`entering Deploy in ${mode} ignores a saved target from the other mode`, async ({ page, studio }) => {
    const expected = mode === "Development" ? "browser-dev" : "browser-prod";
    studio.reply("GET", "/api/deploy/overview", route => route.fulfill({ json: {
      ...overview(), preferences: { profiles: {}, deployment: mode === "Development" ? "browser-prod" : "browser-dev" },
    } }));
    await studio.goto("/graphql");
    await page.getByRole("group", { name: "Source environment", exact: true }).getByRole("button", { name: mode, exact: true }).click();
    await page.getByRole("navigation", { name: "Views", exact: true }).getByRole("link", { name: "Deploy", exact: true }).click();
    await expect(page.getByRole("heading", { name: new RegExp(`^${expected}`) })).toBeVisible();
    expect(studio.requests.some(request => request.path === "/api/deploy/operations")).toBe(false);
  });

test("idle polling runs quietly at slower intervals and job events still update immediately", async ({ page, studio }) => {
  await page.clock.install({ time: new Date(NOW) });
  await studio.goto("/deploy");
  await expect(page.getByRole("heading", { name: /^browser-dev/ })).toBeVisible();
  const count = (path: string) => studio.requests.filter(request => request.path.startsWith(path)).length;
  await expect.poll(() => count("/api/deploy/status?")).toBeGreaterThan(0);
  const before = { overview: count("/api/deploy/overview"), status: count("/api/deploy/status?"), discovery: count("/api/deploy/discover?") };
  await page.clock.fastForward(29_000);
  expect(count("/api/deploy/overview")).toBe(before.overview);
  await page.clock.fastForward(2_000);
  await expect.poll(() => count("/api/deploy/overview")).toBeGreaterThan(before.overview);
  expect(count("/api/deploy/status?")).toBe(before.status);
  expect(count("/api/deploy/discover?")).toBe(before.discovery);
  await page.clock.fastForward(90_000);
  await expect.poll(() => count("/api/deploy/status?")).toBeGreaterThan(before.status);
  const updated = count("/api/deploy/overview");
  await studio.emit("deploy-changed", {});
  await expect.poll(() => count("/api/deploy/overview")).toBeGreaterThan(updated);
  await expect(page.getByRole("region", { name: "Machine readiness", exact: true }).locator(".animate-spin")).toHaveCount(0);
  expect(studio.requests.some(request => request.path === "/api/deploy/operations")).toBe(false);
});
