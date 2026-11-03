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
  test(`Deploy shows only machine checks and Docker remediation in its toolbar at ${width}px`, async ({ page, studio }, testInfo) => {
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
    await passed.focus();
    await page.keyboard.press("Enter");
    await expect(toolbar.getByRole("list", { name: "Passed machine checks", exact: true })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(toolbar.getByRole("list", { name: "Passed machine checks", exact: true })).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await assertAccessible(page);
    await page.screenshot({ path: testInfo.outputPath("deploy-machine-toolbar.png"), fullPage: true });
    expect(studio.requests.some(request => request.path === "/api/deploy/operations")).toBe(false);
  });

test("deployment target and Source mode follow each other using the accepted mode's profile", async ({ page, studio }) => {
  await studio.goto("/deploy");
  const rail = page.getByRole("navigation", { name: "Deployments", exact: true });
  const dev = rail.getByRole("button", { name: /^browser-dev/ });
  const prod = rail.getByRole("button", { name: /^browser-prod/ });
  const mode = page.getByRole("group", { name: "Source environment", exact: true });
  await expect(dev).toHaveAttribute("aria-current", "true");
  await prod.click();
  await expect(mode.getByRole("button", { name: "Production", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Production AWS profile: prod-connection", exact: true })).toBeVisible();
  await expect(prod).toHaveAttribute("aria-current", "true");
  await expect.poll(() => studio.requests.some(request => request.path.includes("/api/deploy/status?") && request.path.includes("deployment=browser-prod") && request.path.includes("profile=prod-connection"))).toBe(true);
  expect(studio.requests.some(request => request.path.includes("deployment=browser-prod") && request.path.includes("profile=dev-connection"))).toBe(false);
  await dev.click();
  await expect(mode.getByRole("button", { name: "Development", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(dev).toHaveAttribute("aria-current", "true");
  await mode.getByRole("button", { name: "Production", exact: true }).click();
  await expect(prod).toHaveAttribute("aria-current", "true");
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
    await expect(page.getByRole("navigation", { name: "Deployments", exact: true }).getByRole("button", { name: new RegExp(`^${expected}`) })).toHaveAttribute("aria-current", "true");
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
