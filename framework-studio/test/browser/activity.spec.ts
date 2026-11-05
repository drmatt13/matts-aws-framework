import type { JobLogLine, JobView } from "../../shared/deploy";
import { test, expect, assertAccessible } from "./support/test";
import { NOW, overview } from "./support/scenarios";

const older: JobView = {
  id: "persistent-activity-older", kind: "deploy-plan", title: "Prepare fixture deployment",
  deployment: "browser-dev", params: { deployment: "browser-dev", profile: "browser" },
  status: "running", startedAt: "2026-10-28T11:00:00.000Z", lastSeq: 180,
  steps: [{ label: "Compare templates", status: "running" }],
};
const newer: JobView = {
  id: "persistent-activity-newer", kind: "export", title: "Export fixture outputs",
  deployment: "browser-dev", params: { deployment: "browser-dev", profile: "browser" },
  status: "succeeded", startedAt: "2026-10-28T11:30:00.000Z", endedAt: NOW, lastSeq: 1,
};
const line = (seq: number, text = `Fixture activity line ${seq}`): JobLogLine => ({
  seq, at: NOW, stream: "out", text,
});

test("Activity retains its selected job, log DOM and scroll across every primary route", async ({ page, studio }) => {
  const jobs = [newer, older];
  studio.reply("GET", "/api/operations", route => route.fulfill({ json: { ...overview(), jobs } }));
  for (const job of jobs) studio.reply("GET", `/api/operations/${job.id}/log`, route => route.fulfill({ json: {
    job, lines: job.id === older.id ? Array.from({ length: 180 }, (_, index) => line(index + 1)) : [line(1, "Export fixture complete")],
  } }));
  studio.reply("GET", "/api/agent-lab/status", route => route.fulfill({ json: {
    providers: [{ id: "codex", label: "Codex", available: false, detail: "Fixture CLI is not installed." }], busy: false,
  } }));

  await studio.goto("/graphql");
  const activity = page.getByRole("region", { name: "Activity", exact: true });
  const toggle = activity.getByRole("button", { name: /^Activity/ });
  await expect(activity).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const selected = activity.getByRole("list", { name: "Operations", exact: true }).getByRole("button", { name: /^Prepare fixture deployment/ });
  await selected.click();
  await expect(selected).toHaveAttribute("aria-current", "true");
  const log = activity.getByLabel("Log", { exact: true });
  await expect(log).toContainText("Fixture activity line 180");
  await log.evaluate(element => {
    element.scrollTop = 64;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  expect(await log.evaluate(element => element.scrollTop)).toBe(64);
  const logReads = () => studio.requests.filter(request => /\/api\/operations\/[^/]+\/log/.test(request.path)).length;
  const initialLogReads = logReads();
  await activity.evaluate(element => {
    const state = { region: element, log: element.querySelector('[aria-label="Log"]'), mutations: 0, observer: undefined as MutationObserver | undefined };
    state.observer = new MutationObserver(records => { state.mutations += records.length; });
    state.observer.observe(element, { subtree: true, childList: true, characterData: true });
    Object.assign(window, { __activityPersistence: state });
  });

  const navigation = page.getByRole("navigation", { name: "Views", exact: true });
  for (const name of ["Map", "Database", "Deploy", "Cognito", "Domains", "WebSockets", "Agent test", "GraphQL"]) {
    await navigation.getByRole("link", { name, exact: true }).click();
    await expect(navigation.getByRole("link", { name, exact: true })).toHaveAttribute("aria-current", "page");
    await studio.settle();
    await expect(activity).toHaveCount(1);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(selected).toHaveAttribute("aria-current", "true");
    expect(await activity.evaluate(element => {
      const saved = (window as unknown as { __activityPersistence: { region: Element; log: Element; mutations: number } }).__activityPersistence;
      return { sameRegion: element === saved.region, sameLog: element.querySelector('[aria-label="Log"]') === saved.log, mutations: saved.mutations };
    })).toEqual({ sameRegion: true, sameLog: true, mutations: 0 });
    expect(await log.evaluate(element => element.scrollTop)).toBe(64);
    expect(logReads()).toBe(initialLogReads);
    expect(await page.evaluate(() => (window as unknown as { __studioBrowserEvents: { active(): number } }).__studioBrowserEvents.active())).toBe(1);
  }

  await page.evaluate(() => (window as unknown as { __activityPersistence: { observer: MutationObserver } }).__activityPersistence.observer.disconnect());
  const updated = { ...older, summary: "Fixture comparison is still running", lastSeq: 181 };
  await studio.emit("operation-job", updated);
  await studio.emit("operation-log", { id: older.id, lines: [line(181, "Live fixture line received away from Deploy")] });
  await expect(activity).toContainText(updated.summary);
  await expect(log).toContainText("Live fixture line received away from Deploy");
  await expect(selected).toHaveAttribute("aria-current", "true");
  expect(await log.evaluate(element => element.scrollTop)).toBe(64);
  // A job update may advertise its new tail just before the corresponding log event.
  expect(logReads()).toBeLessThanOrEqual(initialLogReads + 1);
  expect(studio.requests.filter(request => request.method === "POST")).toEqual([]);
  await assertAccessible(page);
});

for (const width of [1440, 390]) test(`Activity receives and cancels a background job outside Deploy at ${width}px`, async ({ page, studio }) => {
  await page.setViewportSize({ width, height: 900 });
  let jobs: JobView[] = [];
  const running: JobView = { ...older, id: `background-activity-${width}`, lastSeq: 1 };
  studio.reply("GET", "/api/operations", route => route.fulfill({ json: { ...overview(), jobs } }));
  studio.reply("GET", `/api/operations/${running.id}/log`, route => route.fulfill({ json: { job: running, lines: [line(1, "Fixture background operation started")] } }));
  studio.reply("POST", `/api/operations/${running.id}/cancel`, async route => {
    const stopped: JobView = { ...running, status: "cancelled", endedAt: NOW, summary: "Fixture command stopped" };
    jobs = [stopped];
    await route.fulfill({ json: stopped });
    await studio.emit("operation-job", stopped);
  });
  await studio.goto("/graphql");
  const activity = page.getByRole("region", { name: "Activity", exact: true });
  await expect(activity).toContainText("Nothing has run yet.");
  jobs = [running];
  await studio.emit("operation-job", running);
  await expect(activity).toContainText(running.title);
  await activity.getByRole("button", { name: /^Activity/ }).click();
  await expect(activity.getByLabel("Log", { exact: true })).toContainText("Fixture background operation started");
  const trayBounds = (await activity.boundingBox())!;
  const canvasBounds = (await page.locator("main").boundingBox())!;
  expect(trayBounds.y).toBeGreaterThanOrEqual(0);
  expect(trayBounds.y + trayBounds.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  expect(canvasBounds.height).toBeGreaterThan(0);
  expect(canvasBounds.y + canvasBounds.height).toBeLessThanOrEqual(trayBounds.y + 1);
  await activity.getByRole("button", { name: "Stop command; AWS may continue", exact: true }).click();
  await expect(activity).toContainText("Fixture command stopped");
  await expect(activity.getByRole("button", { name: "Stop command; AWS may continue", exact: true })).toHaveCount(0);
  expect(studio.requests.filter(request => request.method === "POST").map(request => request.path)).toEqual([`/api/operations/${running.id}/cancel`]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await assertAccessible(page);
});

test("a failed cancellation preserves the selected job and log while navigating another route", async ({ page, studio }) => {
  const running: JobView = { ...older, id: "failed-cancel-activity", lastSeq: 1 };
  studio.reply("GET", "/api/operations", route => route.fulfill({ json: { ...overview(), jobs: [newer, running] } }));
  for (const job of [newer, running]) studio.reply("GET", `/api/operations/${job.id}/log`, route => route.fulfill({ json: {
    job, lines: [line(1, job.id === running.id ? "Fixture command remains active" : "Fixture export completed")],
  } }));
  const cancelPath = `/api/operations/${running.id}/cancel`;
  studio.reply("POST", cancelPath, route => route.fulfill({ status: 500, json: { error: "Fixture command cancellation was refused" } }));
  await studio.goto("/graphql");
  const activity = page.getByRole("region", { name: "Activity", exact: true });
  const toggle = activity.getByRole("button", { name: /^Activity/ });
  await toggle.click();
  const selected = activity.getByRole("list", { name: "Operations", exact: true }).getByRole("button", { name: /^Prepare fixture deployment/ });
  await selected.click();
  await expect(selected).toHaveAttribute("aria-current", "true");
  const log = activity.getByLabel("Log", { exact: true });
  await expect(log).toContainText("Fixture command remains active");
  const originalLog = await log.elementHandle();
  await activity.getByRole("button", { name: "Stop command; AWS may continue", exact: true }).click();
  await expect(activity.getByRole("alert")).toContainText("Fixture command cancellation was refused");
  await expect(selected).toHaveAttribute("aria-current", "true");
  await expect(log).toContainText("Fixture command remains active");
  await page.getByRole("navigation", { name: "Views", exact: true }).getByRole("link", { name: "Database", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Prisma schema source", exact: true })).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(activity.getByRole("alert")).toContainText("Fixture command cancellation was refused");
  await expect(selected).toHaveAttribute("aria-current", "true");
  expect(await originalLog!.evaluate(element => element.isConnected && element === document.querySelector('[aria-label="Log"]'))).toBe(true);
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(selected).toHaveAttribute("aria-current", "true");
  await expect(log).toContainText("Fixture command remains active");
  await expect(activity.getByRole("button", { name: "Stop command; AWS may continue", exact: true })).toBeEnabled();
  expect(studio.requests.filter(request => request.method === "POST").map(request => request.path)).toEqual([cancelPath]);
});

test("Activity replays a missed log tail after reconnecting without remounting the tray", async ({ page, studio }) => {
  let recorded: JobView = { ...older, id: "reconnected-activity", lastSeq: 1 };
  studio.reply("GET", "/api/operations", route => route.fulfill({ json: { ...overview(), jobs: [recorded] } }));
  const logPath = `/api/operations/${recorded.id}/log`;
  studio.reply("GET", logPath, (route, url) => {
    const after = Number(url.searchParams.get("after") ?? 0);
    const lines = [line(1, "Fixture log before connection loss"), line(2, "Fixture output missed while disconnected"), line(3, "Fixture command finished offline")];
    return route.fulfill({ json: { job: recorded, lines: lines.filter(entry => entry.seq > after && entry.seq <= recorded.lastSeq) } });
  });
  await studio.goto("/graphql");
  const activity = page.getByRole("region", { name: "Activity", exact: true });
  await activity.getByRole("button", { name: /^Activity/ }).click();
  const log = activity.getByLabel("Log", { exact: true });
  await expect(log).toContainText("Fixture log before connection loss");
  const originalLog = await log.elementHandle();
  await studio.emit("error", {});
  recorded = {
    ...recorded, status: "succeeded", lastSeq: 3, endedAt: NOW,
    summary: "Fixture command completed while disconnected", steps: [{ label: "Compare templates", status: "done" }],
  };
  await studio.emit("open", {});
  await expect(activity).toContainText(recorded.summary!);
  await expect(log).toContainText("Fixture output missed while disconnected");
  await expect(log).toContainText("Fixture command finished offline");
  expect(await originalLog!.evaluate(element => element.isConnected && element === document.querySelector('[aria-label="Log"]'))).toBe(true);
  expect(studio.requests.filter(request => request.path.startsWith(logPath)).map(request => request.path)).toEqual([logPath, `${logPath}?after=1`]);
  expect(studio.requests.filter(request => request.method === "POST")).toEqual([]);
});

test("switching jobs loads the selected log even when an earlier empty replay is pending", async ({ page, studio }) => {
  const first: JobView = { ...older, id: "slow-first-activity", title: "Slow fixture operation", startedAt: NOW, lastSeq: 0 };
  const second: JobView = { ...newer, id: "selected-second-activity", title: "Second fixture operation", lastSeq: 1 };
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let firstReads = 0;
  let secondReads = 0;
  studio.reply("GET", "/api/operations", route => route.fulfill({ json: { ...overview(), jobs: [first, second] } }));
  studio.reply("GET", `/api/operations/${first.id}/log`, async route => {
    firstReads++;
    await pending;
    await route.fulfill({ json: { job: first, lines: [] } });
  });
  studio.reply("GET", `/api/operations/${second.id}/log`, async route => {
    secondReads++;
    await pending;
    await route.fulfill({ json: { job: second, lines: [line(1, "Fixture selected log loaded independently")] } });
  });
  await studio.goto("/graphql");
  const activity = page.getByRole("region", { name: "Activity", exact: true });
  await activity.getByRole("button", { name: /^Activity/ }).click();
  await expect.poll(() => firstReads).toBe(1);
  const selected = activity.getByRole("list", { name: "Operations", exact: true }).getByRole("button", { name: /^Second fixture operation/ });
  await selected.click();
  await expect(selected).toHaveAttribute("aria-current", "true");
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  release();
  await expect(activity.getByLabel("Log", { exact: true })).toContainText("Fixture selected log loaded independently");
  await expect(selected).toHaveAttribute("aria-current", "true");
  expect(firstReads).toBe(1);
  expect(secondReads).toBe(1);
  expect(studio.requests.filter(request => request.method === "POST")).toEqual([]);
});

test("Activity loading and failed reads remain visible and recover through retry on another route", async ({ page, studio }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let fail = true;
  studio.reply("GET", "/api/operations", async route => {
    await pending;
    await route.fulfill(fail ? { status: 503, json: { error: "Fixture activity history is unavailable" } } : { json: overview() });
  });
  await studio.goto("/graphql");
  const activity = page.getByRole("region", { name: "Activity", exact: true });
  const toggle = activity.getByRole("button", { name: /^Activity/ });
  await expect(toggle).toContainText("Reading activity");
  await toggle.click();
  await expect(activity.getByRole("status").filter({ hasText: "Reading activity…" })).toBeVisible();
  release();
  await expect(activity.getByRole("alert")).toContainText("Fixture activity history is unavailable", { timeout: 15_000 });
  fail = false;
  await activity.getByRole("button", { name: "Retry activity", exact: true }).click();
  await expect(activity.getByRole("alert")).toHaveCount(0);
  await expect(toggle).toContainText("Nothing has run yet.");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(studio.requests.filter(request => request.method === "POST")).toEqual([]);
});

test("uncertain operations expose recovery and a workspace link without offering replay", async ({ page, studio }) => {
  const uncertain: JobView = { ...older, id: "uncertain-operation", status: "interrupted", execution: "lost", outcome: "uncertain", origin: "/deploy", lastSeq: 1,
    recovery: "Inspect the recorded deployment and AWS before creating a new plan. This apply will not run again." };
  studio.reply("GET", "/api/operations", route => route.fulfill({ json: { jobs: [uncertain] } }));
  studio.reply("GET", `/api/operations/${uncertain.id}/log`, route => route.fulfill({ json: { job: uncertain, lines: [line(1, "Deployment accepted before worker loss")] } }));
  await studio.goto("/graphql");
  const activity = page.getByRole("region", { name: "Activity", exact: true });
  await activity.getByRole("button", { name: /^Activity/ }).click();
  await expect(activity.getByRole("status").filter({ hasText: uncertain.recovery! })).toBeVisible();
  await expect(activity).toContainText("Outcome uncertain");
  await expect(activity.getByRole("button", { name: /Cancel|Stop command|Retry operation/ })).toHaveCount(0);
  const link = activity.getByRole("link", { name: "Open workspace" });
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/deploy$/);
  await expect(activity.getByLabel("Log", { exact: true })).toContainText("Deployment accepted before worker loss");
  expect(studio.requests.filter(request => request.method === "POST")).toEqual([]);
  await assertAccessible(page);
});

test("unavailable process observation is visible and clears when host inspection recovers", async ({ page, studio }) => {
  const observed: JobView = { ...older, id: "unknown-process-observation", execution: "running", lastSeq: 1,
    observationProblem: "Host process identity is temporarily unavailable. Its resource claims remain held." };
  studio.reply("GET", "/api/operations", route => route.fulfill({ json: { jobs: [observed] } }));
  studio.reply("GET", `/api/operations/${observed.id}/log`, route => route.fulfill({ json: { job: observed, lines: [line(1)] } }));
  await studio.goto("/graphql");
  const activity = page.getByRole("region", { name: "Activity", exact: true });
  await activity.getByRole("button", { name: /^Activity/ }).click();
  await expect(activity.getByRole("status").filter({ hasText: observed.observationProblem! })).toBeVisible();
  await studio.emit("operation-job", { ...observed, observationProblem: undefined });
  await expect(activity.getByRole("status").filter({ hasText: observed.observationProblem! })).toHaveCount(0);
  await expect(activity.getByLabel("Log", { exact: true })).toContainText("Fixture activity line 1");
  expect(studio.requests.filter(request => request.method === "POST")).toEqual([]);
});

test("a failed historical log read is explicit and retry fills the missing cursor", async ({ page, studio }) => {
  const recorded: JobView = { ...older, id: "retry-log-operation", lastSeq: 2 };
  let fail = true;
  studio.reply("GET", "/api/operations", route => route.fulfill({ json: { jobs: [recorded] } }));
  studio.reply("GET", `/api/operations/${recorded.id}/log`, (route, url) => route.fulfill(fail
    ? { status: 503, json: { error: "The operation log is temporarily unavailable." } }
    : { json: { job: recorded, lines: [line(1), line(2)].filter(entry => entry.seq > Number(url.searchParams.get("after") ?? 0)) } }));
  await studio.goto("/graphql");
  const activity = page.getByRole("region", { name: "Activity", exact: true });
  await activity.getByRole("button", { name: /^Activity/ }).click();
  await expect(activity.getByRole("alert")).toContainText("log is temporarily unavailable");
  fail = false;
  await activity.getByRole("button", { name: "Retry log" }).click();
  await expect(activity.getByRole("alert")).toHaveCount(0);
  await expect(activity.getByLabel("Log", { exact: true })).toHaveText("Fixture activity line 1\nFixture activity line 2\n");
  expect(studio.requests.filter(request => request.method === "POST")).toEqual([]);
});

test("revealing an accepted operation and requesting cancellation work while the live stream is unavailable", async ({ page, studio }) => {
  let jobs: JobView[] = [];
  const accepted: JobView = { ...older, id: "accepted-offline-activity", execution: "accepted", lastSeq: 1 };
  studio.reply("GET", "/api/operations", route => route.fulfill({ json: { jobs } }));
  studio.reply("GET", `/api/operations/${accepted.id}/log`, route => route.fulfill({ json: {
    job: accepted, lines: [line(1, "Durably accepted while events were disconnected")],
  } }));
  studio.reply("POST", `/api/operations/${accepted.id}/cancel`, route => route.fulfill({ json: { ...accepted, cancelRequested: true } }));
  await studio.goto("/graphql");
  const activity = page.getByRole("region", { name: "Activity", exact: true });
  await expect(activity).toContainText("Nothing has run yet.");
  await studio.emit("error", {});
  jobs = [accepted];
  await page.evaluate(id => window.dispatchEvent(new CustomEvent("studio:activity", { detail: id })), accepted.id);
  await expect(activity.getByLabel("Log", { exact: true })).toContainText("Durably accepted while events were disconnected");
  await expect(activity).toContainText("Accepted");
  const cancel = activity.getByRole("button", { name: "Stop command; AWS may continue", exact: true });
  await cancel.click();
  await expect(cancel).toBeDisabled();
  await expect(activity).toContainText("Stopping");
  expect(studio.requests.filter(request => request.method === "POST").map(request => request.path)).toEqual([`/api/operations/${accepted.id}/cancel`]);
});
