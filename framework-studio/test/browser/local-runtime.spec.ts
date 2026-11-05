import { test, expect, assertAccessible } from "./support/test";
import { NOW, overview, dockerStatus } from "./support/scenarios";
import type { DockerView, JobView } from "../../shared/deploy";

const job = (status: JobView["status"]): JobView => ({
  id: "docker-start-job", kind: "docker-start", title: "Start Docker Desktop", params: {}, status, startedAt: NOW, lastSeq: 0,
  ...(status === "failed" ? { summary: "Docker Desktop could not start. Open it from your applications, then check again." } : {}),
});

for (const width of [1440, 320]) test(`local runtime explains Docker and starts it only on request at ${width}px`, async ({ page, studio }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  let running = false;
  let submitted = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  studio.reply("GET", "/api/machine/docker", route => route.fulfill({ json: dockerStatus({ engine: running ? "running" : "stopped", desktop: true }) }));
  studio.reply("POST", "/api/deploy/operations", route => { submitted = true; return route.fulfill({ json: job("running") }); });
  studio.reply("GET", "/api/operations", async route => {
    if (!submitted) { await route.fulfill({ json: { jobs: [] } }); return; }
    await pending;
    running = true;
    await route.fulfill({ json: { jobs: [job("succeeded")] } });
  });
  await studio.goto();
  const control = page.getByRole("switch", { name: "Local runtime", exact: true });
  await control.focus();
  await page.keyboard.press("Space");
  const popup = page.getByRole("dialog", { name: "Docker Desktop is not running", exact: true });
  await expect(popup).toBeVisible();
  await expect(control).not.toBeChecked();
  await expect(popup).toContainText("Docker runs your app’s local services");
  expect(studio.requests.filter(request => request.path === "/api/deploy/operations")).toHaveLength(0);
  await assertAccessible(page);
  const bounds = (await popup.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(12);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 12);
  expect(bounds.y).toBeGreaterThanOrEqual(12);
  expect(bounds.y + bounds.height).toBeLessThan((await control.boundingBox())!.y);
  await page.screenshot({ path: testInfo.outputPath("docker-help.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(control).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(popup).toBeVisible();
  await expect(page.getByRole("button", { name: "Close Docker help" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(popup.getByRole("button", { name: "Start Docker Desktop", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog").getByRole("status")).toContainText("Waiting for the Docker engine");
  await expect(page.getByRole("button", { name: "Starting…", exact: true })).toBeDisabled();
  await expect.poll(() => studio.requests.filter(request => request.path === "/api/deploy/operations").map(request => { const { requestKey, ...intent } = request.body as { requestKey: string; kind: string; params: object }; expect(requestKey).toEqual(expect.any(String)); return intent; })).toEqual([{ kind: "docker-start", params: {} }]);
  release();
  const ready = page.getByRole("dialog", { name: "Docker is ready", exact: true });
  await expect(ready).toBeVisible();
  await expect(ready).toContainText("Close this popup, then turn on Local runtime");
  await expect(control).not.toBeChecked();
  await expect(control.locator('[data-slot="compose-launch"]')).toHaveCount(0);
  await assertAccessible(page);
  await page.screenshot({ path: testInfo.outputPath("docker-ready-switch-off.png"), fullPage: true });
  await ready.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(control).toBeFocused();
  await control.click();
  await expect(control).toBeChecked();
  await control.click();
  await expect(control).not.toBeChecked();
  expect(studio.requests.filter(request => request.path === "/api/deploy/operations")).toHaveLength(1);
});

for (const width of [1440, 320]) test(`Activity bar states Docker's current condition and starts it in place at ${width}px`, async ({ page, studio }) => {
  await page.setViewportSize({ width, height: 900 });
  let running = false;
  let submitted = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const past = { ...job("succeeded"), id: "past-startup", summary: "Docker is running." };
  studio.reply("GET", "/api/machine/docker", route => route.fulfill({ json: dockerStatus({ engine: running ? "running" : "stopped", desktop: true }) }));
  studio.reply("POST", "/api/deploy/operations", route => { submitted = true; return route.fulfill({ json: job("running") }); });
  studio.reply("GET", "/api/operations", async route => {
    if (!submitted) { await route.fulfill({ json: { jobs: [past] } }); return; }
    await pending;
    running = true;
    await route.fulfill({ json: { jobs: [job("succeeded"), past] } });
  });
  await studio.goto();
  const activity = page.getByRole("region", { name: "Activity", exact: true });
  const toggle = activity.getByRole("button", { name: /^Activity/ });
  await expect(activity.getByRole("status")).toHaveText("Docker stopped");
  await expect(toggle).not.toContainText("Start Docker Desktop");
  await expect(page.locator("html")).toHaveJSProperty("scrollWidth", width);
  await assertAccessible(page);
  await activity.getByRole("button", { name: "Start Docker", exact: true }).click();
  await expect(activity.getByRole("status")).toHaveText("Starting Docker…");
  await expect(activity.getByRole("button", { name: "Start Docker", exact: true })).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  release();
  await expect(activity.getByRole("status")).toHaveText("Docker running");
  await assertAccessible(page);
});

test("Docker setup, detection and startup failures remain recoverable", async ({ page, studio }) => {
  let docker: DockerView = { engine: "missing", desktop: false };
  let failed = true;
  studio.reply("GET", "/api/machine/docker", route => route.fulfill(failed
    ? { status: 503, json: { error: "Could not check Docker. Try again." } }
    : { json: dockerStatus(docker) }));
  studio.reply("POST", "/api/deploy/operations", route => route.fulfill({ json: job("failed") }));
  await studio.goto();
  const control = page.getByRole("switch", { name: "Local runtime", exact: true });
  await control.click();
  await expect(page.getByRole("alert")).toContainText("Could not check Docker");
  await expect(control).not.toBeChecked();
  failed = false;
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Install Docker Desktop, open it and finish setup");
  await expect(page.getByRole("button", { name: "Start Docker Desktop", exact: true })).toHaveCount(0);
  docker = { engine: "stopped", desktop: true };
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  await page.getByRole("button", { name: "Start Docker Desktop", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Docker Desktop could not start");
  await expect(control).not.toBeChecked();
  docker = { engine: "running", desktop: true };
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Docker is ready" })).toBeVisible();
  await expect(control).not.toBeChecked();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await control.click();
  await expect(control).toBeChecked();
});

test("light dismissal ignores a pending check and keeps the clicked control focused", async ({ page, studio }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  studio.reply("GET", "/api/machine/docker", async route => { await pending; await route.fulfill({ json: dockerStatus() }); });
  await studio.goto();
  const control = page.getByRole("switch", { name: "Local runtime", exact: true });
  await control.click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText("Checking whether the Docker engine");
  const search = page.getByRole("searchbox", { name: "Search isometric map" });
  await search.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(search).toBeFocused();
  release();
  await expect(control).not.toBeChecked();
});

test("Map, Deploy and historical Activity share current Docker state across navigation", async ({ page, studio }) => {
  let current = dockerStatus({ engine: "running", desktop: true });
  const historic = { ...job("succeeded"), summary: "Docker is running." };
  studio.reply("GET", "/api/machine/docker", route => route.fulfill({ json: current }));
  studio.reply("GET", "/api/operations", route => route.fulfill({ json: { jobs: [historic] } }));
  // Deliberately old overview: consumers must use the newer shared observation.
  studio.reply("GET", "/api/deploy/overview", route => route.fulfill({ json: {
    ...overview(), prerequisites: dockerStatus({ engine: "stopped", desktop: true }).checks,
    local: { ...overview().local, docker: { engine: "stopped", desktop: true } },
  } }));
  await studio.goto();
  const control = page.getByRole("switch", { name: "Local runtime", exact: true });
  const activity = page.getByRole("region", { name: "Activity", exact: true });
  await control.click();
  await expect(control).toBeChecked();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  current = dockerStatus({ engine: "stopped", desktop: true }, "2026-10-28T12:00:01.000Z");
  await studio.emit("machine-docker", current);
  await expect(control).not.toBeChecked();
  await expect(activity.getByRole("status")).toHaveText("Docker stopped");
  await expect(activity.getByRole("button", { name: "Start Docker", exact: true })).toBeVisible();
  await expect(activity).not.toContainText("Docker startup completed.");
  await expect(activity).not.toContainText("Docker is running.");
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Deploy", exact: true }).click();
  await expect(page.getByRole("region", { name: "Machine readiness" })).toContainText("Docker Desktop is not running.");
  current = dockerStatus({ engine: "running", desktop: true }, "2026-10-28T12:00:02.000Z");
  await studio.emit("machine-docker", current);
  await expect(page.getByRole("region", { name: "Machine readiness" })).not.toContainText("Docker Desktop is not running.");
  await expect(activity.getByRole("status")).toHaveText("Docker running");
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Map", exact: true }).click();
  await expect(control).not.toBeChecked();
  await control.click();
  await expect(control).toBeChecked();
  expect(studio.requests.filter(request => request.method === "POST")).toHaveLength(0);
  current = dockerStatus({ engine: "stopped", desktop: true }, "2026-10-28T12:00:03.000Z");
  await studio.emit("open", {});
  await expect(control).not.toBeChecked();
  await expect(activity.getByRole("status")).toHaveText("Docker stopped");
  await assertAccessible(page);
});

test("Docker startup from Deploy remains shared when Map opens or dismisses its help", async ({ page, studio }) => {
  let current = dockerStatus({ engine: "stopped", desktop: true });
  let accepted = false;
  studio.reply("GET", "/api/machine/docker", route => route.fulfill({ json: current }));
  studio.reply("GET", "/api/operations", route => route.fulfill({ json: { jobs: accepted ? [job("running")] : [] } }));
  studio.reply("POST", "/api/deploy/operations", route => { accepted = true; return route.fulfill({ json: job("running") }); });
  studio.reply("GET", "/api/operations/docker-start-job/log", route => route.fulfill({ json: { job: job("running"), lines: [] } }));
  await studio.goto("/deploy");
  const readiness = page.getByRole("region", { name: "Machine readiness" });
  await readiness.getByRole("button", { name: "Start", exact: true }).click();
  await expect(readiness.getByRole("button", { name: "Starting…", exact: true })).toBeDisabled();
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Map", exact: true }).click();
  const control = page.getByRole("switch", { name: "Local runtime", exact: true });
  // Starting from Deploy revealed the job in Activity, whose open tray covers the map's dock.
  await expect(control).toBeHidden();
  await page.getByRole("region", { name: "Activity", exact: true }).getByRole("button", { name: /^Activity/ }).click();
  await control.click();
  await expect(page.getByRole("dialog", { name: "Starting Docker Desktop…", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(control).toBeFocused();
  current = dockerStatus({ engine: "running", desktop: true }, "2026-10-28T12:00:01.000Z");
  await studio.emit("machine-docker", current);
  await studio.emit("operation-job", job("succeeded"));
  await expect(control).not.toBeChecked();
  await control.click();
  await expect(control).toBeChecked();
  expect(studio.requests.filter(request => request.method === "POST" && request.path === "/api/deploy/operations")).toHaveLength(1);
});

test("a late HTTP observation cannot replace a newer Docker event", async ({ page, studio }) => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  studio.reply("GET", "/api/machine/docker", async route => {
    await pending;
    await route.fulfill({ json: dockerStatus({ engine: "stopped", desktop: true }) });
  });
  await studio.goto("/deploy");
  const current = dockerStatus({ engine: "running", desktop: true }, "2026-10-28T12:00:01.000Z");
  await studio.emit("machine-docker", current);
  const readiness = page.getByRole("region", { name: "Machine readiness" });
  await expect(readiness).toContainText("This machine");
  finish();
  await studio.settle();
  await expect(readiness).not.toContainText("not running");
  expect(studio.requests.filter(request => request.method === "POST")).toHaveLength(0);
});

test("shared polling observes external shutdown without deployment reads", async ({ page, studio }) => {
  let current = dockerStatus();
  studio.reply("GET", "/api/machine/docker", route => route.fulfill({ json: current }));
  await studio.goto();
  const control = page.getByRole("switch", { name: "Local runtime", exact: true });
  await control.click();
  await expect(control).toBeChecked();
  current = dockerStatus({ engine: "stopped", desktop: true }, "2026-10-28T12:00:01.000Z");
  await expect(control).not.toBeChecked({ timeout: 7500 });
  expect(studio.requests.filter(request => request.path.startsWith("/api/deploy/"))).toHaveLength(0);
  expect(studio.requests.filter(request => request.method === "POST")).toHaveLength(0);
});
