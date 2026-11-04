import { test, expect, assertAccessible } from "./support/test";
import { NOW, overview } from "./support/scenarios";
import type { DockerView, JobView } from "../../shared/deploy";

const job = (status: JobView["status"]): JobView => ({
  id: "docker-start-job", kind: "docker-start", title: "Start Docker Desktop", params: {}, status, startedAt: NOW, lastSeq: 0,
  ...(status === "failed" ? { summary: "Docker Desktop could not start. Open it from your applications, then check again." } : {}),
});

for (const width of [1440, 320]) test(`local runtime explains Docker and starts it only on request at ${width}px`, async ({ page, studio }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  let running = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  studio.reply("GET", "/api/deploy/overview", (route) => route.fulfill({ json: {
    ...overview(), local: { ...overview().local, docker: { engine: running ? "running" : "stopped", desktop: true } },
  } }));
  studio.reply("POST", "/api/deploy/operations", route => route.fulfill({ json: job("running") }));
  studio.reply("GET", "/api/deploy/jobs/docker-start-job/log", async route => {
    await pending;
    running = true;
    await route.fulfill({ json: { lines: [], job: job("succeeded") } });
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
  expect(studio.requests.filter(request => request.path === "/api/deploy/operations").map(request => { const { requestKey, ...intent } = request.body as { requestKey: string; kind: string; params: object }; expect(requestKey).toEqual(expect.any(String)); return intent; })).toEqual([{ kind: "docker-start", params: {} }]);
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

test("Docker setup, detection and startup failures remain recoverable", async ({ page, studio }) => {
  let docker: DockerView = { engine: "missing", desktop: false };
  let failed = true;
  studio.reply("GET", "/api/deploy/overview", route => route.fulfill(failed
    ? { status: 503, json: { error: "Could not check Docker. Try again." } }
    : { json: { ...overview(), local: { ...overview().local, docker } } }));
  studio.reply("POST", "/api/deploy/operations", route => route.fulfill({ json: job("failed") }));
  await studio.goto();
  const control = page.getByRole("switch", { name: "Local runtime", exact: true });
  await control.click();
  await expect(page.getByRole("alert")).toContainText("Could not check Docker");
  await expect(control).not.toBeChecked();
  failed = false;
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByRole("dialog")).toContainText("Install Docker Desktop, open it and finish setup");
  await expect(page.getByRole("button", { name: "Start Docker Desktop", exact: true })).toHaveCount(0);
  docker = { engine: "stopped", desktop: true };
  await page.getByRole("button", { name: "Check again" }).click();
  await page.getByRole("button", { name: "Start Docker Desktop", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Docker Desktop could not start");
  await expect(control).not.toBeChecked();
  docker = { engine: "running", desktop: true };
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByRole("dialog", { name: "Docker is ready" })).toBeVisible();
  await expect(control).not.toBeChecked();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await control.click();
  await expect(control).toBeChecked();
});

test("light dismissal ignores a pending check and keeps the clicked control focused", async ({ page, studio }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  studio.reply("GET", "/api/deploy/overview", async route => { await pending; await route.fulfill({ json: overview() }); });
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
