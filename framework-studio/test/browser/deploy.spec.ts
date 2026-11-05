import { dockerStatus } from "./support/scenarios";
import { test, expect, assertAccessible } from "./support/test";
import { discoveryFor, overview, NOW } from "./support/scenarios";
import { connectionCatalogFixture } from "./support/aws-connections";

test.beforeEach(async ({ context, studio }) => {
  await context.addInitScript(() => {
    localStorage.setItem("aws-studio:mode-profiles:v1:/studio-fixture", JSON.stringify({ dev: "dev-connection", prod: "prod-connection" }));
  });
  studio.reply("GET", "/api/aws-connections", route => route.fulfill({ json: connectionCatalogFixture([
    { name: "dev-connection", kind: "sso" }, { name: "prod-connection", kind: "sso" },
  ]) }));
  studio.reply("GET", "/api/deploy/status", (route, url) => route.fulfill({ json: { ok: true, value: {
    ...discoveryFor(url),
    deployment: url.searchParams.get("deployment"),
  } } }));
});

for (const width of [1440, 390])
  test(`AWS sign-in errors replace account metadata without shifting the header at ${width}px`, async ({ page, studio }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const expired = { ok: false, problem: { kind: "expired", message: "The selected profile's session has expired." } };
    for (const pathname of ["/api/deploy/discover", "/api/deploy/status"])
      studio.reply("GET", pathname, async (route, url) => {
        const profile = url.searchParams.get("profile");
        if (profile === "prod-connection") { await pending; await route.fulfill({ json: expired }); }
        else await route.fulfill({ json: { ok: true, value: { ...discoveryFor(url), deployment: url.searchParams.get("deployment") } } });
      });
    await studio.goto("/deploy");
    const header = page.locator("main h1").locator("xpath=ancestor::header");
    const metadata = header.locator('[data-slot="deployment-context"]');
    const readiness = page.getByRole("region", { name: "Machine readiness", exact: true });
    await expect(metadata).toContainText("123456789012 · us-east-1");
    const before = { header: await header.boundingBox(), metadata: await metadata.boundingBox(), readiness: await readiness.boundingBox() };
    const typography = await metadata.evaluate(element => ({ fontSize: getComputedStyle(element).fontSize, lineHeight: getComputedStyle(element).lineHeight }));
    const source = page.getByRole("group", { name: "Source environment", exact: true });
    await source.getByRole("button", { name: "Production", exact: true }).click();
    await expect(page.getByRole("heading", { name: /^browser-prod/ })).toBeVisible();
    const skeleton = metadata.getByRole("status", { name: "Loading AWS profile", exact: true });
    await expect(skeleton).toBeVisible();
    expect((await skeleton.boundingBox())!.height).toBe(before.metadata!.height);
    expect((await header.boundingBox())!.height).toBe(before.header!.height);
    const bar = skeleton.locator("span");
    await expect(bar).toHaveCSS("animation-name", "none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(bar).toHaveCSS("animation-name", "deploy-pulse");
    expect(await bar.evaluate(element => element.getAnimations().map(animation => animation.playState))).toEqual(["running"]);
    await page.emulateMedia({ reducedMotion: "reduce" });
    release();
    const error = metadata.getByRole("button", { name: "AWS sign-in required. Open AWS profile configuration", exact: true });
    await expect(error).toBeVisible();
    await expect(skeleton).toHaveCount(0);
    await expect(error).toHaveCSS("font-size", typography.fontSize);
    await expect(error).toHaveCSS("line-height", typography.lineHeight);
    expect((await metadata.boundingBox())!.y).toBe(before.metadata!.y);
    expect((await metadata.boundingBox())!.height).toBe(before.metadata!.height);
    expect(await header.boundingBox()).toEqual(before.header);
    expect(await readiness.boundingBox()).toEqual(before.readiness);
    await expect(header.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0);
    await expect(page.getByText("Sign in to prod-connection", { exact: true })).toHaveCount(0);
    await expect(page.getByText(expired.problem.message, { exact: true })).toHaveCount(0);
    await assertAccessible(page);
    await error.hover();
    await expect(error).toHaveCSS("text-decoration-line", "underline");
    await page.screenshot({ path: testInfo.outputPath("inline-aws-sign-in.png"), fullPage: true });
    await error.focus();
    await page.keyboard.press("Enter");
    const configuration = page.getByRole("dialog", { name: "AWS profile configuration", exact: true });
    await expect(configuration).toBeVisible();
    await expect(configuration.getByRole("heading", { name: "prod-connection", exact: true })).toBeVisible();
    await configuration.getByRole("button", { name: "Close AWS profile configuration", exact: true }).click();
    await expect(page.getByRole("button", { name: "Production AWS profile: prod-connection", exact: true })).toBeFocused();
    await source.getByRole("button", { name: "Development", exact: true }).click();
    await expect(metadata).toContainText("123456789012 · us-east-1");
    await expect(error).toHaveCount(0);
    expect(await header.boundingBox()).toEqual(before.header);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(studio.requests.filter(request => request.path === "/api/deploy/operations" || /\/aws-connections\/(?:authenticate|check)$/.test(request.path))).toEqual([]);
  });

for (const width of [1440, 320])
  test(`Deploy aligns machine readiness to the right with Docker remediation first at ${width}px`, async ({ page, studio }, testInfo) => {
    studio.reply("GET", "/api/machine/docker", route => route.fulfill({ json: dockerStatus({ engine: "stopped", desktop: true }) }));
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
    const actionGroup = await toolbar.locator("xpath=..").boundingBox();
    const actions = await page.getByRole("button", { name: "Synthesize", exact: true }).boundingBox();
    expect(actionGroup!.x + actionGroup!.width).toBeCloseTo(width - Math.max(0, (width - 1280) / 2) - 16, 0);
    if (width === 1440) {
      expect(before!.x).toBeGreaterThan(headingBefore!.x + headingBefore!.width);
      expect(before!.y + before!.height / 2).toBeCloseTo(headingBefore!.y + headingBefore!.height / 2, 0);
      expect(before!.x + before!.width).toBeLessThan(actions!.x);
    } else {
      expect(before!.y).toBeGreaterThanOrEqual(headingBefore!.y + headingBefore!.height);
    }
    await expect(page.getByRole("navigation", { name: "Deployments", exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Repository", exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "AWS", exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "This machine", exact: true })).toHaveCount(0);
    await expect(page.getByText("Client environment & frontend release", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Stateful retention and retained-resource references", { exact: true })).toHaveCount(0);
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
    await expect.poll(() => studio.requests.some(request => request.path.startsWith("/api/deploy/status?") && request.path.includes(`deployment=${expected}`))).toBe(true);
    await page.getByRole("navigation", { name: "Views", exact: true }).getByRole("link", { name: "Deploy", exact: true }).click();
    await expect(page.getByRole("heading", { name: new RegExp(`^${expected}`) })).toBeVisible();
    expect(studio.requests.some(request => request.path === "/api/deploy/operations")).toBe(false);
  });

test("idle polling runs quietly at slower intervals and job events still update immediately", async ({ page, studio }) => {
  await page.clock.install({ time: new Date(NOW) });
  await studio.goto("/deploy");
  await expect(page.getByRole("heading", { name: /^browser-dev/ })).toBeVisible();
  const count = (path: string) => studio.requests.filter(request => request.path.startsWith(path)).length;
  await expect.poll(() => count("/api/deploy/status?")).toBe(2);
  const before = { overview: count("/api/deploy/overview"), docker: count("/api/machine/docker"), status: count("/api/deploy/status?"), discovery: count("/api/deploy/discover?") };
  await page.getByRole("link", { name: "GraphQL", exact: true }).click();
  await page.getByRole("link", { name: "Deploy", exact: true }).click();
  expect(count("/api/deploy/status?")).toBe(before.status);
  await page.clock.fastForward(29_000);
  expect(count("/api/deploy/overview")).toBe(before.overview);
  await page.clock.fastForward(2_000);
  await expect.poll(() => count("/api/machine/docker")).toBeGreaterThan(before.docker);
  expect(count("/api/deploy/overview")).toBe(before.overview);
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

const statusRequests = (requests: readonly { path: string }[], deployment?: string, profile?: string) => requests.filter(request => {
  const url = new URL(request.path, "http://studio-fixture.invalid");
  return url.pathname === "/api/deploy/status" && (!deployment || url.searchParams.get("deployment") === deployment)
    && (!profile || url.searchParams.get("profile") === profile);
});
const operationRequests = (requests: readonly { method: string; path: string }[]) => requests.filter(request =>
  request.method !== "GET" && request.path !== "/api/aws-connections/check",
);

for (const pathname of ["/", "/graphql"])
  test(`cold ${pathname === "/" ? "Map" : "GraphQL"} observes both configured modes before Deploy is visited`, async ({ page, studio }) => {
    await studio.goto(pathname);
    await expect.poll(() => statusRequests(studio.requests, "browser-dev", "dev-connection").length).toBe(1);
    await expect.poll(() => statusRequests(studio.requests, "browser-prod", "prod-connection").length).toBe(1);
    expect(studio.requests.some(request => request.path.startsWith("/api/deploy/discover?"))).toBe(false);
    expect(operationRequests(studio.requests)).toEqual([]);
    const before = statusRequests(studio.requests).length;
    await page.getByRole("navigation", { name: "Views", exact: true }).getByRole("link", { name: "Deploy", exact: true }).click();
    await expect(page.getByRole("heading", { name: /^browser-dev/ })).toBeVisible();
    expect(statusRequests(studio.requests)).toHaveLength(before);
    expect(await page.evaluate(() => (window as unknown as { __studioBrowserEvents: { active(): number } }).__studioBrowserEvents.active())).toBe(1);
  });

test("entering and leaving Deploy reuses a pending observation without adding event transports", async ({ page, studio }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  studio.reply("GET", "/api/deploy/status", async (route, url) => {
    if (url.searchParams.get("profile") === "dev-connection") await pending;
    await route.fulfill({ json: { ok: true, value: { ...discoveryFor(url), deployment: url.searchParams.get("deployment") } } });
  });
  await studio.goto("/graphql");
  await expect.poll(() => statusRequests(studio.requests, "browser-dev").length).toBe(1);
  await page.getByRole("link", { name: "Deploy", exact: true }).click();
  await expect(page.getByRole("status", { name: "Loading AWS profile", exact: true })).toBeVisible();
  expect(statusRequests(studio.requests, "browser-dev")).toHaveLength(1);
  await page.getByRole("link", { name: "GraphQL", exact: true }).click();
  release();
  await expect.poll(() => statusRequests(studio.requests, "browser-prod").length).toBe(1);
  await page.getByRole("link", { name: "Deploy", exact: true }).click();
  await expect(page.locator('[data-slot="deployment-context"]')).toContainText("123456789012 · us-east-1");
  expect(statusRequests(studio.requests, "browser-dev")).toHaveLength(1);
  expect(await page.evaluate(() => (window as unknown as { __studioBrowserEvents: { active(): number } }).__studioBrowserEvents.active())).toBe(1);
  expect(operationRequests(studio.requests)).toEqual([]);
});

test("both modes sharing one profile refresh independently after a same-profile credential event", async ({ context, page, studio }) => {
  await context.addInitScript(() => localStorage.setItem("aws-studio:mode-profiles:v1:/studio-fixture", JSON.stringify({ dev: "dev-connection", prod: "dev-connection" })));
  await studio.goto("/graphql");
  await expect.poll(() => statusRequests(studio.requests, "browser-dev", "dev-connection").length).toBe(1);
  await expect.poll(() => statusRequests(studio.requests, "browser-prod", "dev-connection").length).toBe(1);
  await studio.emit("aws-connections", { profiles: ["dev-connection"] });
  await expect.poll(() => statusRequests(studio.requests, "browser-dev", "dev-connection").length).toBe(2);
  await expect.poll(() => statusRequests(studio.requests, "browser-prod", "dev-connection").length).toBe(2);
  await page.getByRole("button", { name: "Production", exact: true }).click();
  await page.getByRole("link", { name: "Deploy", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^browser-prod/ })).toBeVisible();
  expect(statusRequests(studio.requests).some(request => request.path.includes("profile=prod-connection"))).toBe(false);
  expect(operationRequests(studio.requests)).toEqual([]);
});

test("the other configured mode warms after five seconds when the active profile is slow", async ({ page, studio }) => {
  await page.clock.install({ time: new Date(NOW) });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  studio.reply("GET", "/api/deploy/status", async (route, url) => {
    if (url.searchParams.get("profile") === "dev-connection") await pending;
    await route.fulfill({ json: { ok: true, value: { ...discoveryFor(url), deployment: url.searchParams.get("deployment") } } });
  });
  await studio.goto("/graphql");
  await expect.poll(() => statusRequests(studio.requests, "browser-dev").length).toBe(1);
  expect(statusRequests(studio.requests, "browser-prod")).toHaveLength(0);
  await page.clock.fastForward(5_100);
  await expect.poll(() => statusRequests(studio.requests, "browser-prod").length).toBe(1);
  release();
  expect(statusRequests(studio.requests)).toHaveLength(2);
  expect(operationRequests(studio.requests)).toEqual([]);
});

test("a scoped connection event refreshes its associated mode without rereading the other profile", async ({ studio }) => {
  await studio.goto("/graphql");
  await expect.poll(() => statusRequests(studio.requests).length).toBe(2);
  await studio.emit("aws-connections", { profiles: ["prod-connection"] });
  await expect.poll(() => statusRequests(studio.requests, "browser-prod").length).toBe(2);
  expect(statusRequests(studio.requests, "browser-dev")).toHaveLength(1);
  expect(operationRequests(studio.requests)).toEqual([]);
});

for (const failure of ["no associations", "missing profile", "failed catalog"] as const)
  test(`${failure} leaves navigation usable without deployment reads`, async ({ context, page, studio }) => {
    await context.addInitScript(({ failure }) => localStorage.setItem("aws-studio:mode-profiles:v1:/studio-fixture",
      JSON.stringify(failure === "no associations" ? {} : { dev: failure === "missing profile" ? "removed-profile" : "dev-connection" })), { failure });
    if (failure === "failed catalog") studio.reply("GET", "/api/aws-connections", route => route.fulfill({ status: 503, json: { error: "Profile catalog is temporarily unavailable." } }));
    await studio.goto("/graphql");
    await expect.poll(() => studio.requests.some(request => request.path === "/api/aws-connections")).toBe(true);
    await page.getByRole("link", { name: "Map", exact: true }).click();
    await expect(page.getByRole("button", { name: "Resources", exact: true })).toBeVisible();
    expect(studio.requests.filter(request => /\/deploy\/(?:status|discover)\?/.test(request.path))).toEqual([]);
    expect(operationRequests(studio.requests)).toEqual([]);
  });

test("catalog failure recovers on an ordinary route without replacing associations", async ({ page, studio }) => {
  let unavailable = true;
  studio.reply("GET", "/api/aws-connections", route => route.fulfill(unavailable
    ? { status: 503, json: { error: "Profile catalog is temporarily unavailable." } }
    : { json: connectionCatalogFixture([{ name: "dev-connection", kind: "sso" }, { name: "prod-connection", kind: "sso" }]) }));
  await studio.goto("/graphql");
  await expect.poll(() => studio.requests.some(request => request.path === "/api/aws-connections")).toBe(true);
  expect(statusRequests(studio.requests)).toEqual([]);
  unavailable = false;
  await studio.emit("aws-connections", { profiles: [] });
  await expect.poll(() => statusRequests(studio.requests).length).toBe(2);
  await expect(page.getByRole("button", { name: "Development AWS profile: dev-connection", exact: true })).toBeVisible();
  expect(operationRequests(studio.requests)).toEqual([]);
});

for (const failure of ["catalog", "status"] as const)
  test(`initial ${failure} transport failure stops loading without claiming deployment absence`, async ({ page, studio }) => {
    const message = `Fixture ${failure} transport unavailable.`;
    studio.reply("GET", failure === "catalog" ? "/api/aws-connections" : "/api/deploy/status",
      route => route.fulfill({ status: 503, json: { error: message } }));
    await studio.goto("/deploy");
    await expect(page.getByRole("alert").filter({ hasText: message })).toBeVisible();
    await expect(page.getByRole("status", { name: "Loading AWS profile", exact: true })).toHaveCount(0);
    await expect(page.getByText("Not deployed here", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /^browser-dev/ })).toBeVisible();
    await page.getByRole("link", { name: "Map", exact: true }).click();
    await expect(page.getByRole("button", { name: "Resources", exact: true })).toBeVisible();
    expect(operationRequests(studio.requests)).toEqual([]);
  });

test("an expired same-profile observation recovers after credential refresh on GraphQL", async ({ context, page, studio }) => {
  await context.addInitScript(() => localStorage.setItem("aws-studio:mode-profiles:v1:/studio-fixture", JSON.stringify({ dev: "dev-connection" })));
  let expired = true;
  studio.reply("GET", "/api/deploy/status", (route, url) => route.fulfill({ json: expired
    ? { ok: false, problem: { kind: "expired", message: "Fixture session expired." } }
    : { ok: true, value: { ...discoveryFor(url), deployment: url.searchParams.get("deployment") } } }));
  await studio.goto("/graphql");
  await expect.poll(() => statusRequests(studio.requests).length).toBe(1);
  expired = false;
  await studio.emit("aws-connections", { profiles: ["dev-connection"] });
  await expect.poll(() => statusRequests(studio.requests).length).toBe(2);
  await page.getByRole("link", { name: "Deploy", exact: true }).click();
  await expect(page.locator('[data-slot="deployment-context"]')).toContainText("123456789012 · us-east-1");
  await expect(page.getByRole("button", { name: "AWS sign-in required. Open AWS profile configuration", exact: true })).toHaveCount(0);
  expect(operationRequests(studio.requests)).toEqual([]);
});

test("a late response remains attached to its original profile after changing the association", async ({ context, page, studio }) => {
  await context.addInitScript(() => localStorage.setItem("aws-studio:mode-profiles:v1:/studio-fixture", JSON.stringify({ dev: "dev-connection" })));
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let completed!: () => void;
  const oldFinished = new Promise<void>(resolve => { completed = resolve; });
  studio.reply("GET", "/api/deploy/status", async (route, url) => {
    const original = discoveryFor(url);
    const previousProfile = url.searchParams.get("profile") === "dev-connection";
    if (previousProfile) await pending;
    const value = previousProfile ? original : { ...original, context: { ...original.context, account: "999999999999", arn: "arn:aws:iam::999999999999:user/new-caller" } };
    try { await route.fulfill({ json: { ok: true, value: { ...value, deployment: url.searchParams.get("deployment") } } }); }
    finally { if (previousProfile) completed(); }
  });
  await studio.goto("/deploy");
  await expect.poll(() => statusRequests(studio.requests, "browser-dev", "dev-connection").length).toBe(1);
  await page.getByRole("button", { name: "Development AWS profile: dev-connection", exact: true }).click();
  await page.getByRole("combobox", { name: "AWS profile", exact: true }).selectOption("prod-connection");
  await page.keyboard.press("Escape");
  const metadata = page.locator('[data-slot="deployment-context"]');
  await expect(metadata).toContainText("999999999999 · us-east-1");
  release();
  await oldFinished;
  await expect(metadata).toContainText("999999999999 · us-east-1");
  expect(operationRequests(studio.requests)).toEqual([]);
});

test("credential invalidation during a pending read cannot restore the old caller", async ({ context, page, studio }) => {
  await context.addInitScript(() => localStorage.setItem("aws-studio:mode-profiles:v1:/studio-fixture", JSON.stringify({ dev: "dev-connection" })));
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let completed!: () => void;
  const oldFinished = new Promise<void>(resolve => { completed = resolve; });
  let first = true;
  studio.reply("GET", "/api/deploy/status", async (route, url) => {
    const oldGeneration = first;
    first = false;
    if (oldGeneration) await pending;
    const original = discoveryFor(url);
    const context = oldGeneration ? original.context : { ...original.context, account: "999999999999", arn: "arn:aws:iam::999999999999:user/refreshed-caller" };
    try { await route.fulfill({ json: { ok: true, value: { ...original, context, deployment: url.searchParams.get("deployment") } } }); }
    finally { if (oldGeneration) completed(); }
  });
  await studio.goto("/deploy");
  await expect.poll(() => statusRequests(studio.requests).length).toBe(1);
  await studio.emit("aws-connections", { profiles: ["dev-connection"] });
  await expect(page.locator('[data-slot="deployment-context"]')).toContainText("999999999999 · us-east-1");
  release();
  await oldFinished;
  await expect(page.locator('[data-slot="deployment-context"]')).toContainText("999999999999 · us-east-1");
  expect(statusRequests(studio.requests)).toHaveLength(2);
  expect(operationRequests(studio.requests)).toEqual([]);
});

test("cross-tab association changes refresh the matching deployment on an ordinary route", async ({ context, page, studio }) => {
  await studio.goto("/graphql");
  await expect.poll(() => statusRequests(studio.requests).length).toBe(2);
  const other = await context.newPage();
  await other.goto("/graphql");
  await other.evaluate(() => localStorage.setItem("aws-studio:mode-profiles:v1:/studio-fixture", JSON.stringify({ dev: "prod-connection", prod: "prod-connection" })));
  await expect(page.getByRole("button", { name: "Development AWS profile: prod-connection", exact: true })).toBeVisible();
  await expect.poll(() => statusRequests(studio.requests, "browser-dev", "prod-connection").length).toBeGreaterThan(0);
  await other.close();
  expect(operationRequests(studio.requests)).toEqual([]);
});

test("source publication reloads targets and uses the new target's pinned region", async ({ studio }) => {
  let current = overview();
  studio.reply("GET", "/api/deploy/overview", route => route.fulfill({ json: current }));
  await studio.goto("/graphql");
  await expect.poll(() => statusRequests(studio.requests).length).toBe(2);
  current = { ...current, targets: current.targets.map(target => target.mode === "dev" ? { ...target, name: "renamed-development", region: "eu-west-1" } : target) };
  Object.assign(studio.response.snapshot, { revision: "changed-target-revision" });
  await studio.emit("snapshot", { revision: "changed-target-revision", external: [] });
  await expect.poll(() => statusRequests(studio.requests, "renamed-development", "dev-connection").some(request => request.path.includes("region=eu-west-1"))).toBe(true);
  expect(operationRequests(studio.requests)).toEqual([]);
});

test("entering Deploy during a delayed source snapshot reuses the published deployment context", async ({ page, studio }) => {
  let current = overview();
  studio.reply("GET", "/api/deploy/overview", route => route.fulfill({ json: current }));
  await studio.goto("/graphql");
  await expect.poll(() => statusRequests(studio.requests).length).toBe(2);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let completed!: () => void;
  const snapshotFinished = new Promise<void>(resolve => { completed = resolve; });
  const response = { ...studio.response, snapshot: { ...studio.response.snapshot, revision: "published-target-revision" } };
  studio.reply("GET", "/api/snapshot", async route => {
    await pending;
    try { await route.fulfill({ json: response }); }
    finally { completed(); }
  });
  current = { ...current, targets: current.targets.map(target => target.mode === "dev" ? { ...target, name: "published-development", region: "eu-west-1" } : target) };
  await studio.emit("snapshot", { revision: "published-target-revision", external: [] });
  await expect.poll(() => statusRequests(studio.requests, "published-development", "dev-connection").length).toBe(1);
  await page.getByRole("link", { name: "Deploy", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^published-development/ })).toBeVisible();
  await expect(page.locator('[data-slot="deployment-context"]')).toContainText("123456789012 · eu-west-1");
  expect(statusRequests(studio.requests, "published-development", "dev-connection")).toHaveLength(1);
  release();
  await snapshotFinished;
  await expect(page.getByRole("heading", { name: /^published-development/ })).toBeVisible();
  await expect(page.locator('[data-slot="deployment-context"]')).toContainText("123456789012 · eu-west-1");
  expect(statusRequests(studio.requests, "published-development", "dev-connection")).toHaveLength(1);
  expect(operationRequests(studio.requests)).toEqual([]);
});

test("a hidden inactive mode revalidates a freshly cached profile when its association returns", async ({ context, page, studio }) => {
  await context.addInitScript(() => localStorage.setItem("aws-studio:mode-profiles:v1:/studio-fixture", JSON.stringify({ dev: "dev-connection", prod: "dev-connection" })));
  await studio.goto("/graphql");
  await expect.poll(() => statusRequests(studio.requests, "browser-prod", "dev-connection").length).toBe(1);
  await page.getByRole("button", { name: "Production", exact: true }).click();
  await page.getByRole("button", { name: "Production AWS profile: dev-connection", exact: true }).click();
  await page.getByRole("combobox", { name: "AWS profile", exact: true }).selectOption("prod-connection");
  await page.keyboard.press("Escape");
  await expect.poll(() => statusRequests(studio.requests, "browser-prod", "prod-connection").length).toBe(1);
  await page.getByRole("button", { name: "Development", exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new StorageEvent("storage", { key: "aws-studio:mode-profiles:v1:/studio-fixture",
      newValue: JSON.stringify({ dev: "dev-connection", prod: "dev-connection" }) }));
  });
  await studio.settle();
  expect(statusRequests(studio.requests, "browser-prod", "dev-connection")).toHaveLength(1);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => statusRequests(studio.requests, "browser-prod", "dev-connection").length).toBe(2);
  await expect(page.getByRole("button", { name: "Development", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(operationRequests(studio.requests)).toEqual([]);
});

test("hidden tabs suspend deployment polling and reconnect reconciles both configured contexts", async ({ page, studio }) => {
  await page.clock.install({ time: new Date(NOW) });
  await studio.goto("/graphql");
  await expect.poll(() => statusRequests(studio.requests).length).toBe(2);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const before = statusRequests(studio.requests).length;
  await page.clock.fastForward(360_000);
  expect(statusRequests(studio.requests)).toHaveLength(before);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => statusRequests(studio.requests, "browser-dev").length).toBeGreaterThan(1);
  await expect.poll(() => statusRequests(studio.requests, "browser-prod").length).toBeGreaterThan(1);
  const connected = statusRequests(studio.requests).length;
  await studio.emit("hello", {});
  await expect.poll(() => statusRequests(studio.requests).length).toBeGreaterThan(connected);
  expect(await page.evaluate(() => (window as unknown as { __studioBrowserEvents: { active(): number } }).__studioBrowserEvents.active())).toBe(1);
  expect(operationRequests(studio.requests)).toEqual([]);
});

test("matching deployment jobs accelerate polling on Map and completion refreshes their destination", async ({ page, studio }) => {
  await page.clock.install({ time: new Date(NOW) });
  await studio.goto("/");
  await expect.poll(() => statusRequests(studio.requests).length).toBe(2);
  const job = { id: "global-observer-job", title: "Fixture deployment", kind: "deploy-apply", status: "running", deployment: "browser-dev",
    params: { profile: "dev-connection", deployment: "browser-dev" }, startedAt: NOW, locks: [], lastSeq: 0 };
  await studio.emit("deploy-job", job);
  const before = statusRequests(studio.requests, "browser-dev").length;
  await page.clock.fastForward(4_100);
  await expect.poll(() => statusRequests(studio.requests, "browser-dev").length).toBeGreaterThan(before);
  expect(statusRequests(studio.requests, "browser-prod")).toHaveLength(1);
  const running = statusRequests(studio.requests, "browser-dev").length;
  await studio.emit("deploy-job", { ...job, status: "succeeded", finishedAt: new Date(Date.parse(NOW) + 4100).toISOString() });
  await studio.emit("deploy-changed", { profile: "dev-connection", deployment: "browser-dev" });
  await expect.poll(() => statusRequests(studio.requests, "browser-dev").length).toBeGreaterThan(running);
  expect(operationRequests(studio.requests)).toEqual([]);
});
