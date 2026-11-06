import { test, expect, assertAccessible } from "./support/test";
import { NOW, dockerStatus, discoveryFor, overview } from "./support/scenarios";
import { installLocalRuntime, localRuntimeView, LOCAL_ACCOUNT, LOCAL_REGION } from "./support/local-runtime";
import type { JobView } from "../../shared/deploy";
import type { Page } from "@playwright/test";
import { inspectionStatus } from "./support/stack-inspection";
import { connectionCatalogFixture } from "./support/aws-connections";

const controlFor = (page: Page) => page.getByRole("switch", { name: "Local runtime", exact: true, includeHidden: true });
const detailsFor = (page: Page) => page.getByRole("button", { name: "Local runtime details", exact: true });
async function closeActivity(page: Page) {
  const collapse = page.getByRole("region", { name: "Activity", exact: true }).getByRole("button", { name: "Activity: collapse panel", exact: true });
  await expect(collapse).toBeVisible();
  await collapse.click();
}
const dockerJob = (status: JobView["status"]): JobView => ({
  id: "docker-start-job", kind: "docker-start", title: "Start Docker Desktop", params: {}, status, startedAt: NOW, lastSeq: 0,
  ...(status === "failed" ? { summary: "Docker Desktop could not start. Open it from your applications, then check again." } : {}),
});

for (const width of [1440, 390]) test(`runtime starts and stops only after observed readiness at ${width}px`, async ({ page, studio }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const runtime = installLocalRuntime(studio);
  await studio.goto();
  const control = controlFor(page);
  await expect(control).toContainText("Stopped");
  await expect(control).not.toBeChecked();
  await control.focus();
  await page.keyboard.press("Space");
  await expect.poll(() => runtime.submitted.length).toBe(1);
  expect(runtime.submitted[0]).toMatchObject({ kind: "local-start", params: {
    deployment: "browser-dev", profile: "browser", mode: "dev", account: LOCAL_ACCOUNT, region: LOCAL_REGION, export: true,
  } });
  await expect(control).toBeChecked();
  await expect(control).toBeDisabled();
  await expect(control).toHaveAttribute("aria-busy", "true");
  await expect(control).toContainText("Starting");
  await expect(page.getByRole("region", { name: "Activity", exact: true }).getByRole("button", { name: "Activity: collapse panel", exact: true })).toBeVisible();
  // A completed startup command still cannot claim ready while the observation is pending.
  await runtime.finish(localRuntimeView("starting"));
  await expect(control).toBeChecked();
  await expect(control).not.toContainText("Running");
  await runtime.publish(localRuntimeView("ready"));
  await expect(control).toBeChecked();
  await closeActivity(page);
  await expect(control).toContainText("Running");
  await assertAccessible(page);
  await page.screenshot({ path: testInfo.outputPath("runtime-ready.png"), fullPage: true });
  await control.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => runtime.submitted.length).toBe(2);
  expect(runtime.submitted[1]).toMatchObject({ kind: "local-stop", params: {} });
  await expect(control).toBeDisabled();
  await expect(control).toContainText("Stopping");
  await runtime.finish(localRuntimeView());
  await expect(control).not.toBeChecked();
  await closeActivity(page);
  await expect(control).toContainText("Stopped");
  expect(runtime.submitted.map(entry => entry.kind)).toEqual(["local-start", "local-stop"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await assertAccessible(page);
});

test("a pending local observation never claims stopped or starts compute", async ({ page, studio }) => {
  const runtime = installLocalRuntime(studio);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  studio.reply("GET", "/api/deploy/local", async route => { await pending; await route.fulfill({ json: localRuntimeView("ready") }); });
  await studio.goto();
  const control = controlFor(page);
  await expect(control).not.toBeChecked();
  await expect(control).toContainText(/Checking|Loading/);
  await expect(control).toBeDisabled();
  expect(runtime.submitted).toEqual([]);
  release();
  await expect(control).toBeChecked();
  expect(runtime.submitted).toEqual([]);
});

for (const state of ["absent", "in-progress", "failed", "incomplete", "incompatible", "unavailable"] as const)
  test(`a ${state} AWS development deployment keeps local startup disabled`, async ({ page, studio }) => {
    const runtime = installLocalRuntime(studio);
    let complete = false;
    studio.reply("GET", "/api/deploy/status", (route, url) => {
      if (!complete && state === "unavailable") return route.fulfill({ json: { ok: false, problem: { kind: "denied", message: "Development stack status cannot be verified." } } });
      const value = inspectionStatus(url);
      const base = value.detail!;
      const stacks = !complete && state === "incomplete"
        ? base.stacks.map((stack, index) => index === 0 ? { ...stack, health: "in-progress" as const, status: "CREATE_IN_PROGRESS" } : stack)
        : base.stacks;
      const detail = !complete && state === "absent" ? undefined : {
        ...base, stacks,
        state: !complete && (state === "in-progress" || state === "failed") ? { kind: state, stacks, deployable: false } : base.state,
        local: { compatible: complete || state !== "incompatible", problem: "Development resources require an update.",
          exported: { deployment: "browser-dev", client: true, fresh: true } },
      };
      return route.fulfill({ json: { ok: true, value: { ...value, detail } } });
    });
    await studio.goto();
    const control = controlFor(page);
    await expect(control).toBeDisabled();
    await expect(control).not.toBeChecked();
    const details = detailsFor(page);
    await details.focus();
    await page.keyboard.press("Enter");
    const help = page.getByRole("dialog", { name: "Local runtime", exact: true });
    await expect(help).toBeVisible();
    await expect(help).toContainText(/development|deploy|resources/i);
    await assertAccessible(page);
    expect(runtime.submitted).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(details).toBeFocused();
    complete = true;
    await studio.emit("deploy-changed", { profile: "browser", deployment: "browser-dev" });
    await expect(control).toBeEnabled();
    await expect(control).not.toBeChecked();
    expect(runtime.submitted).toEqual([]);
  });

test("a running local runtime can be stopped even after its AWS deployment disappears", async ({ page, studio }) => {
  const runtime = installLocalRuntime(studio);
  runtime.set(localRuntimeView("ready"));
  studio.reply("GET", "/api/deploy/status", (route, url) => route.fulfill({ json: { ok: true,
    value: { ...discoveryFor(url), deployment: url.searchParams.get("deployment"), detail: undefined } } }));
  await studio.goto();
  const control = controlFor(page);
  await expect(control).toBeChecked();
  await expect(control).toBeEnabled();
  await control.focus();
  await page.keyboard.press("Space");
  await expect.poll(() => runtime.submitted.map(entry => entry.kind)).toEqual(["local-stop"]);
  await runtime.finish(localRuntimeView());
  await closeActivity(page);
  await expect(control).not.toBeChecked();
  await expect(control).toBeDisabled();
  expect(runtime.submitted.some(entry => entry.kind === "local-start")).toBe(false);
});

for (const reason of ["deployment", "profile"] as const) test(`runtime explains a missing ${reason} without starting anything`, async ({ page, studio }) => {
  const runtime = installLocalRuntime(studio);
  if (reason === "deployment") studio.reply("GET", "/api/deploy/status", (route, url) => route.fulfill({ json: {
    ok: true, value: { ...discoveryFor(url), deployment: url.searchParams.get("deployment"), detail: undefined },
  } }));
  else await page.addInitScript(() => localStorage.setItem("aws-studio:mode-profiles:v1:/studio-fixture", "{}"));
  await studio.goto();
  const control = controlFor(page);
  await expect(control).not.toBeChecked();
  await expect(control).toBeDisabled();
  const details = detailsFor(page);
  await details.focus();
  await page.keyboard.press("Enter");
  const help = page.getByRole("dialog", { name: "Local runtime", exact: true });
  await expect(help).toBeVisible();
  await expect(help).toContainText(reason === "deployment" ? /deploy/i : /profile/i);
  await expect(help.getByRole("link", { name: /Open Deploy/i })).toBeVisible();
  await assertAccessible(page);
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
  await expect(details).toBeFocused();
  expect(runtime.submitted).toEqual([]);
});

for (const width of [1440, 390]) test(`Docker help remains separate from runtime startup at ${width}px`, async ({ page, studio }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const runtime = installLocalRuntime(studio);
  let running = false;
  studio.reply("GET", "/api/machine/docker", route => route.fulfill({ json: dockerStatus({ engine: running ? "running" : "stopped", desktop: true }) }));
  await studio.goto();
  const control = controlFor(page);
  await control.focus();
  await page.keyboard.press("Space");
  const popup = page.getByRole("dialog", { name: "Docker Desktop is not running", exact: true });
  await expect(popup).toBeVisible();
  await expect(control).not.toBeChecked();
  await expect(popup).toContainText("Docker runs your app’s local services");
  expect(runtime.submitted).toEqual([]);
  await assertAccessible(page);
  const bounds = (await popup.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(12);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 12);
  expect(bounds.y).toBeGreaterThanOrEqual(12);
  await page.screenshot({ path: testInfo.outputPath("runtime-docker-prerequisite.png"), fullPage: true });
  running = true;
  await popup.getByRole("button", { name: "Check again", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Docker is ready", exact: true })).toBeVisible();
  await expect(control).not.toBeChecked();
  expect(runtime.submitted).toEqual([]);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(control).toBeFocused();
  await control.click();
  await expect.poll(() => runtime.submitted.map(entry => entry.kind)).toEqual(["local-start"]);
  await expect(control).toBeChecked();
  await expect(control).toContainText("Starting");
});

test("partial startup failure keeps cleanup available and a later start is explicit", async ({ page, studio }) => {
  const runtime = installLocalRuntime(studio);
  await studio.goto();
  const control = controlFor(page);
  await control.click();
  await expect.poll(() => runtime.submitted.length).toBe(1);
  await runtime.finish(localRuntimeView("blocked"), "failed");
  await closeActivity(page);
  await expect(control).toBeChecked();
  await detailsFor(page).click();
  const help = page.getByRole("dialog", { name: "Local runtime", exact: true });
  await expect(help).toBeVisible();
  await expect(help).toContainText(/prisma-verify|Needs attention|Database/i);
  await expect(help.getByRole("button", { name: "View activity", exact: true })).toBeVisible();
  await help.getByRole("button", { name: "Stop runtime", exact: true }).click();
  await expect.poll(() => runtime.submitted.map(entry => entry.kind)).toEqual(["local-start", "local-stop"]);
  await runtime.finish(localRuntimeView());
  await closeActivity(page);
  await expect(control).not.toBeChecked();
  await control.click();
  await expect.poll(() => runtime.submitted.map(entry => entry.kind)).toEqual(["local-start", "local-stop", "local-start"]);
  await runtime.finish(localRuntimeView("ready"));
  await closeActivity(page);
  await expect(control).toBeChecked();
});

test("runtime readiness survives navigation and reload and detects external shutdown", async ({ page, studio }) => {
  const runtime = installLocalRuntime(studio);
  runtime.set(localRuntimeView("ready"));
  await studio.goto();
  const control = controlFor(page);
  await expect(control).toBeChecked();
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Deploy", exact: true }).click();
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Map", exact: true }).click();
  await expect(control).toBeChecked();
  await page.reload();
  await expect(control).toBeChecked();
  runtime.set(localRuntimeView());
  await expect(control).not.toBeChecked({ timeout: 10_000 });
  expect(runtime.submitted).toEqual([]);
});

test("editing source and switching declaration modes never retargets a running runtime", async ({ page, studio }) => {
  const runtime = installLocalRuntime(studio);
  runtime.set(localRuntimeView("ready"));
  await studio.goto();
  const control = controlFor(page);
  await expect(control).toBeChecked();
  const source = page.getByRole("group", { name: "Source environment", exact: true });
  await source.getByRole("button", { name: "Production", exact: true }).click();
  await expect(control).toHaveCount(0);
  await source.getByRole("button", { name: "Development", exact: true }).click();
  await expect(control).toBeChecked();
  Object.assign(studio.response.snapshot!, { revision: "local-handler-edit" });
  await studio.emit("snapshot", { revision: "local-handler-edit", external: [] });
  await expect(control).toBeChecked();
  await expect(control).toContainText("Running");
  expect(runtime.submitted).toEqual([]);
});

test("changing the selected AWS profile keeps the actual runtime bound to its original profile", async ({ page, studio }) => {
  const runtime = installLocalRuntime(studio);
  runtime.set(localRuntimeView("ready"));
  studio.reply("GET", "/api/aws-connections", route => route.fulfill({ json: connectionCatalogFixture([
    ...overview().profiles, { name: "second-profile", kind: "sso", region: "us-east-1" },
  ]) }));
  await studio.goto();
  const control = controlFor(page);
  await expect(control).toBeChecked();
  await page.getByRole("button", { name: "Development AWS profile: browser", exact: true }).click();
  await page.getByRole("combobox", { name: "AWS profile", exact: true }).selectOption("second-profile");
  await page.keyboard.press("Escape");
  await expect(control).toBeChecked();
  await expect(control).toContainText(/elsewhere|attention/i);
  await detailsFor(page).click();
  const help = page.getByRole("dialog", { name: "Local runtime", exact: true });
  await expect(help).toContainText("profile browser");
  expect(runtime.submitted).toEqual([]);
});

test("a different runtime binding cannot silently retarget the selected deployment", async ({ page, studio }) => {
  const runtime = installLocalRuntime(studio);
  runtime.set({ ...localRuntimeView("ready"), profile: "other-profile",
    exported: { deployment: "other-dev", account: "999999999999", region: "us-west-2", client: true },
    binding: { deployment: "other-dev", profile: "other-profile", account: "999999999999", region: "us-west-2", startedAt: NOW },
  });
  await studio.goto();
  const control = controlFor(page);
  await expect(control).toBeChecked();
  await detailsFor(page).click();
  const help = page.getByRole("dialog", { name: "Local runtime", exact: true });
  await expect(help).toBeVisible();
  await expect(help).toContainText(/other-dev|another|different/i);
  await expect(help.getByRole("button", { name: "Stop runtime", exact: true })).toBeVisible();
  expect(runtime.submitted).toEqual([]);
});

for (const failure of ["HTTP failure", "unknown container observation"] as const)
test(`an unavailable local read (${failure}) retains evidence without claiming readiness and can retry`, async ({ page, studio }) => {
  const runtime = installLocalRuntime(studio);
  let unavailable = false;
  studio.reply("GET", "/api/deploy/local", route => route.fulfill(unavailable
    ? failure === "HTTP failure" ? { status: 503, json: { error: "Local runtime status is unavailable. Check again." } }
      : { json: { ...localRuntimeView(), docker: { engine: "unknown", desktop: true }, observationProblem: "Local runtime status is unavailable. Check again." } }
    : { json: localRuntimeView("ready") }));
  await studio.goto();
  const control = controlFor(page);
  await expect(control).toBeChecked();
  unavailable = true;
  await studio.emit("deploy-changed", { profile: "browser", deployment: "browser-dev" });
  await expect(control).toContainText("Status unavailable");
  await expect(control).toBeChecked();
  await expect(control).not.toContainText("Running");
  await detailsFor(page).click();
  const help = page.getByRole("dialog", { name: "Local runtime", exact: true });
  await expect(help.getByRole("alert")).toContainText("Local runtime status is unavailable");
  await expect(help.getByRole("button", { name: "Stop runtime", exact: true })).toBeEnabled();
  unavailable = false;
  await help.getByRole("button", { name: "Check again", exact: true }).click();
  await expect(control).toBeChecked();
  await expect(control).toContainText("Running");
  await page.keyboard.press("Escape");
  await expect(control).toBeFocused();
  expect(runtime.submitted).toEqual([]);
});

test("healthy external containers have no verified runtime binding and remain inspectable", async ({ page, studio }) => {
  const runtime = installLocalRuntime(studio);
  runtime.set({ ...localRuntimeView("ready"), startedBy: "outside", profile: undefined, binding: undefined });
  await studio.goto();
  const control = controlFor(page);
  await expect(control).toBeChecked();
  await detailsFor(page).click();
  const help = page.getByRole("dialog", { name: "Local runtime", exact: true });
  await expect(help).toBeVisible();
  await expect(help).toContainText(/no verified deployment binding/i);
  await expect(help.getByRole("button", { name: "Stop runtime", exact: true })).toBeVisible();
  expect(runtime.submitted).toEqual([]);
});

for (const width of [1440, 390]) test(`Activity bar states Docker's current condition and starts it in place at ${width}px`, async ({ page, studio }) => {
  await page.setViewportSize({ width, height: 900 });
  let running = false, submitted = false;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const past = { ...dockerJob("succeeded"), id: "past-startup", summary: "Docker is running." };
  studio.reply("GET", "/api/machine/docker", route => route.fulfill({ json: dockerStatus({ engine: running ? "running" : "stopped", desktop: true }) }));
  studio.reply("POST", "/api/deploy/operations", route => { submitted = true; return route.fulfill({ json: dockerJob("running") }); });
  studio.reply("GET", "/api/operations", async route => {
    if (!submitted) { await route.fulfill({ json: { jobs: [past] } }); return; }
    await pending; running = true;
    await route.fulfill({ json: { jobs: [dockerJob("succeeded"), past] } });
  });
  await studio.goto();
  const activity = page.getByRole("region", { name: "Activity", exact: true });
  const toggle = activity.getByRole("button", { name: /^Activity/ });
  await expect(activity.getByRole("status")).toHaveText("Docker stopped");
  await expect(toggle).not.toContainText("Start Docker Desktop");
  await assertAccessible(page);
  await activity.getByRole("button", { name: "Start Docker", exact: true }).click();
  await expect(activity.getByRole("status")).toHaveText("Starting Docker…");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  release();
  await expect(activity.getByRole("status")).toHaveText("Docker running");
  await assertAccessible(page);
});

test("a late HTTP observation cannot replace a newer Docker event", async ({ page, studio }) => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  studio.reply("GET", "/api/machine/docker", async route => { await pending; await route.fulfill({ json: dockerStatus({ engine: "stopped", desktop: true }) }); });
  await studio.goto("/deploy");
  await studio.emit("machine-docker", dockerStatus({ engine: "running", desktop: true }, "2026-10-28T12:00:01.000Z"));
  const readiness = page.getByRole("region", { name: "Machine readiness" });
  await expect(readiness).toContainText("This machine");
  finish();
  await studio.settle();
  await expect(readiness).not.toContainText("not running");
  expect(studio.requests.filter(request => request.method === "POST")).toHaveLength(0);
});
