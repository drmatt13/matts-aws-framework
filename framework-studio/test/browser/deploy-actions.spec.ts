import type { JobView, OperationRequest, PlanSummaryView, PlanView } from "../../shared/deploy";
import { test as base, expect, assertAccessible } from "./support/test";
import { deploymentPlan, NOW, overview } from "./support/scenarios";

interface DeploymentScenario {
  readonly jobs: JobView[];
  readonly submitted: OperationRequest[];
  save(plan: PlanView): void;
  finish(plan?: PlanView): Promise<void>;
  fail(message: string): Promise<void>;
}

function prepared(patch: Partial<PlanView> = {}): PlanView {
  return {
    ...deploymentPlan(),
    key: "prepared-development", planId: "prepared-development-id",
    synthesis: { current: true },
    confirmation: { level: "click", reasons: [] }, uncertainties: [],
    stacks: [{ name: "browser-dev-CognitoStack", fingerprint: { exists: false }, exportsInUse: [], noChanges: false,
      changes: [{ logicalId: "UserPool", type: "AWS::Cognito::UserPool", action: "add", replacement: "False", stateful: true }] }],
    ...patch,
  };
}

function summary(plan: PlanView): PlanSummaryView {
  return {
    key: plan.key, deployment: plan.identity.deployment, mode: plan.identity.mode,
    profile: plan.profile, account: plan.identity.account, region: plan.identity.region,
    status: plan.status, createdAt: plan.createdAt, expired: plan.expired,
    synthesis: plan.synthesis,
    ...(plan.result ? { applied: plan.result.status } : {}),
  };
}

/** Exercise the real compiled UI while every operation remains a browser fixture. */
const test = base.extend<{ deployment: DeploymentScenario }>({
  deployment: [async ({ studio }, use) => {
    const jobs: JobView[] = [], submitted: OperationRequest[] = [];
    const plans = new Map<string, PlanView>();
    const save = (plan: PlanView) => {
      plans.set(plan.key, plan);
      studio.reply("GET", `/api/deploy/plans/${plan.key}`, route => route.fulfill({ json: plans.get(plan.key) }));
    };
    studio.reply("GET", "/api/deploy/overview", route => route.fulfill({ json: { ...overview(), jobs } }));
    studio.reply("GET", "/api/operations", route => route.fulfill({ json: { jobs } }));
    studio.reply("GET", "/api/deploy/plans", route => route.fulfill({ json: [...plans.values()].map(summary) }));
    studio.reply("POST", "/api/deploy/operations", async route => {
      const request = route.request().postDataJSON() as OperationRequest;
      submitted.push(request);
      const job: JobView = {
        id: `fixture-deployment-${submitted.length}`, kind: request.kind,
        title: request.kind === "deploy-plan" ? "Synthesize browser-dev" : "Deploy browser-dev",
        params: request.params, deployment: String(request.params.deployment ?? "browser-dev"),
        status: "running", startedAt: NOW, lastSeq: 0,
        ...(request.kind === "deploy-plan" ? { planId: "prepared-development" } : {}),
        steps: [{ label: request.kind === "deploy-plan" ? "Synthesize and compare" : "Deploy and verify", status: "running" }],
      };
      jobs.unshift(job);
      studio.reply("GET", `/api/operations/${job.id}/log`, logRoute => logRoute.fulfill({ json: { job: jobs.find(entry => entry.id === job.id), lines: [] } }));
      await route.fulfill({ json: job });
    });
    const settle = async (status: "succeeded" | "failed", plan?: PlanView, message?: string) => {
      const previous = jobs[0];
      if (!previous) throw new Error("No fixture operation is running.");
      if (plan) save(plan);
      const job: JobView = {
        ...previous, status, endedAt: NOW,
        ...(plan ? { planId: plan.key } : {}),
        summary: message ?? "Synthesis complete.",
        steps: previous.steps?.map(step => ({ ...step, status: status === "succeeded" ? "done" : "failed" })),
      };
      jobs[0] = job;
      await studio.emit("operation-job", job);
      await studio.emit("deploy-job", job);
      await studio.emit("deploy-changed", { deployment: job.deployment, profile: job.params.profile });
    };
    await use({ jobs, submitted, save,
      finish: plan => settle("succeeded", plan ?? prepared()),
      fail: message => settle("failed", undefined, message),
    });
  }, { auto: true }],
});

for (const width of [1440, 390])
  test(`synthesis creates a reviewable plan and deployment stays inside review at ${width}px`, async ({ page, studio, deployment }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await studio.goto("/deploy");
    const header = page.locator("main h1").locator("xpath=ancestor::header");
    const synthesize = header.getByRole("button", { name: "Synthesize", exact: true });
    await expect(synthesize).toBeEnabled();
    await expect(header.getByRole("button", { name: /^(Deploy|Review plan)$/ })).toHaveCount(0);
    await synthesize.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => deployment.submitted.length).toBe(1);
    expect(deployment.submitted[0]).toMatchObject({ kind: "deploy-plan", params: { deployment: "browser-dev", profile: "browser", review: "template" } });
    await expect(page.getByRole("button", { name: "Synthesizing…", exact: true })).toBeDisabled();
    await expect(page.getByRole("region", { name: "Activity", exact: true }).getByRole("button", { name: "Activity: collapse panel", exact: true })).toBeVisible();
    await deployment.finish();
    const card = page.getByRole("article").filter({ hasText: "Plan ready for review" });
    await expect(card).toBeVisible();
    await expect(header.getByRole("button", { name: /^(Deploy|Review plan)$/ })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Review plan", exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Discard", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog", { name: /Review deployment/ })).toHaveCount(0);
    await card.getByRole("button", { name: "Review plan", exact: true }).click();
    const review = page.getByRole("dialog", { name: /^Review deployment for browser-dev\b/ });
    await expect(review).toBeVisible();
    expect(deployment.submitted).toHaveLength(1);
    expect(deployment.submitted.some(request => request.kind === "deploy-apply")).toBe(false);
    await assertAccessible(page);
    await page.screenshot({ path: testInfo.outputPath("prepared-deployment-review.png"), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await review.getByRole("button", { name: "Deploy development", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => deployment.submitted.length).toBe(2);
    expect(deployment.submitted[1]).toMatchObject({ kind: "deploy-apply", params: { plan: "prepared-development", profile: "browser", currentSource: true } });
    expect(deployment.submitted.filter(request => request.kind === "deploy-plan")).toHaveLength(1);
  });

test("reviewing a saved current plan preserves the artifact and returns focus to its card", async ({ page, studio, deployment }) => {
  deployment.save(prepared());
  await studio.goto("/deploy");
  const header = page.locator("main h1").locator("xpath=ancestor::header");
  await expect(header.getByRole("button", { name: /^(Deploy|Review plan)$/ })).toHaveCount(0);
  const reviewPlan = page.getByRole("button", { name: "Review plan", exact: true });
  await reviewPlan.click();
  const review = page.getByRole("dialog", { name: /^Review deployment for browser-dev\b/ });
  await expect(review).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(review).toBeHidden();
  await expect(reviewPlan).toBeFocused();
  expect(deployment.submitted).toEqual([]);
  await page.keyboard.press("Enter");
  await expect(review).toBeVisible();
  expect(deployment.submitted).toEqual([]);
});

for (const width of [1440, 390])
  test(`only the newest plan is current and earlier plans remain reviewable at ${width}px`, async ({ page, studio, deployment }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const earlier = prepared({ key: "earlier-development", planId: "earlier-development-id", createdAt: "2026-10-28T11:00:00.000Z" });
    const current = prepared({ createdAt: "2026-10-28T12:00:00.000Z" });
    deployment.save(earlier);
    deployment.save(current);
    // Plans belonging to another connection are never part of this destination's history.
    deployment.save(prepared({ key: "foreign-profile", planId: "foreign-profile-id", profile: "another-profile", createdAt: "2026-10-28T13:00:00.000Z" }));
    await studio.goto("/deploy");
    const cards = page.getByRole("article").filter({ hasText: "Plan ready for review" });
    await expect(cards).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Review plan", exact: true })).toHaveCount(1);
    await cards.getByRole("button", { name: "Review plan", exact: true }).click();
    const review = page.getByRole("dialog", { name: /^Review deployment for browser-dev\b/ });
    await expect(review).toBeVisible();
    await expect(review.getByRole("button", { name: "Deploy development", exact: true })).toBeEnabled();
    await page.keyboard.press("Escape");
    const earlierPlans = page.locator("summary").filter({ hasText: /^Earlier plans \(1\)$/ });
    await expect(earlierPlans).toBeVisible();
    await earlierPlans.focus();
    await page.keyboard.press("Enter");
    await expect(cards).toHaveCount(2);
    const history = earlierPlans.locator("xpath=..");
    const earlierReview = history.getByRole("button", { name: "Review plan", exact: true });
    await expect(earlierReview).toBeVisible();
    await expect(history.getByRole("button", { name: "Discard", exact: true })).toBeVisible();
    await assertAccessible(page);
    await page.screenshot({ path: testInfo.outputPath("current-plan-and-history.png"), fullPage: true });
    await earlierReview.click();
    await expect(review).toBeVisible();
    await review.getByRole("button", { name: "Deploy development", exact: true }).click();
    await expect.poll(() => deployment.submitted.length).toBe(1);
    expect(deployment.submitted[0]).toMatchObject({ kind: "deploy-apply", params: { plan: earlier.key, profile: "browser" } });
    expect(deployment.submitted[0]?.params.currentSource).toBeUndefined();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

test("permission broadening keeps its warning visible while security details expand by keyboard", async ({ page, studio, deployment }) => {
  const security = "Fixture security detail: grant the event Lambda access to the replay bucket.";
  deployment.save(prepared({ iamBroadening: true, reviewEvidence: {
    security, templates: "Fixture template comparison.", problems: [],
  } }));
  await studio.goto("/deploy");
  await page.getByRole("button", { name: "Review plan", exact: true }).click();
  const review = page.getByRole("dialog", { name: /^Review deployment for browser-dev\b/ });
  const warning = review.getByText("IAM or security permissions broaden. Inspect the security diff before deploying.", { exact: true });
  const details = review.getByText(security, { exact: true });
  await expect(warning).toBeVisible();
  await expect(details).toBeHidden();
  const disclosure = review.locator("summary").filter({ hasText: /^IAM and security diff$/ });
  await disclosure.focus();
  await page.keyboard.press("Enter");
  await expect(details).toBeVisible();
  await expect(disclosure).toBeFocused();
  await page.keyboard.press("Space");
  await expect(details).toBeHidden();
  await expect(warning).toBeVisible();
  expect(deployment.submitted).toEqual([]);
});

test("a synthesis finishing after a mode switch stays bound to its original destination", async ({ page, studio, deployment }) => {
  await studio.goto("/deploy");
  await page.getByRole("button", { name: "Synthesize", exact: true }).click();
  await expect.poll(() => deployment.submitted.length).toBe(1);
  const mode = page.getByRole("group", { name: "Source environment", exact: true });
  await mode.getByRole("button", { name: "Production", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^browser-prod/ })).toBeVisible();
  await deployment.finish();
  await expect(page.getByRole("dialog", { name: /Review deployment/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review plan", exact: true })).toHaveCount(0);
  expect(deployment.submitted).toHaveLength(1);
  await mode.getByRole("button", { name: "Development", exact: true }).click();
  await expect(page.getByText("Plan ready for review", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "GraphQL", exact: true }).click();
  await page.getByRole("link", { name: "Deploy", exact: true }).click();
  await page.getByRole("button", { name: "Review plan", exact: true }).click();
  await expect(page.getByRole("dialog", { name: /^Review deployment for browser-dev\b/ })).toBeVisible();
  expect(deployment.submitted).toHaveLength(1);
});

test("stale current plans cannot deploy and a new no-change synthesis never applies", async ({ page, studio, deployment }) => {
  deployment.save(prepared({ synthesis: { current: false, reason: "Deployment sources changed. Synthesize again." } }));
  await studio.goto("/deploy");
  await page.getByRole("button", { name: "Review plan", exact: true }).click();
  const review = page.getByRole("dialog", { name: /^Review deployment for browser-dev\b/ });
  await expect(review.getByText("Deployment sources changed. Synthesize again.", { exact: true })).toBeVisible();
  await expect(review.getByRole("button", { name: "Deploy development", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Synthesize", exact: true }).click();
  await expect.poll(() => deployment.submitted.length).toBe(1);
  expect(deployment.submitted[0]?.kind).toBe("deploy-plan");
  await deployment.finish(prepared({ status: "no-changes", stacks: [] }));
  await expect(page.getByRole("dialog", { name: /Review deployment/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Review plan", exact: true }).click();
  await expect(review).toBeVisible();
  await expect(review.getByRole("button", { name: "Deploy development", exact: true })).toHaveCount(0);
  expect(deployment.submitted.some(request => request.kind === "deploy-apply")).toBe(false);
});

test("source changes during preparation require another synthesis before deployment", async ({ page, studio, deployment }) => {
  await studio.goto("/deploy");
  await page.getByRole("button", { name: "Synthesize", exact: true }).click();
  await expect.poll(() => deployment.submitted.length).toBe(1);
  const previousReads = studio.requests.filter(request => request.path === "/api/snapshot").length;
  Object.assign(studio.response.snapshot!, { revision: "changed-deployment-source" });
  await studio.emit("snapshot", { revision: "changed-deployment-source", external: [] });
  await expect.poll(() => studio.requests.filter(request => request.path === "/api/snapshot").length).toBeGreaterThan(previousReads);
  await deployment.finish(prepared({ synthesis: { current: false, reason: "Deployment sources changed. Synthesize again." } }));
  await expect(page.getByRole("dialog", { name: /Review deployment/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Review plan", exact: true }).click();
  const review = page.getByRole("dialog", { name: /^Review deployment for browser-dev\b/ });
  await expect(review.getByRole("button", { name: "Deploy development", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Synthesize", exact: true }).click();
  await expect.poll(() => deployment.submitted.length).toBe(2);
  expect(deployment.submitted.every(request => request.kind === "deploy-plan")).toBe(true);
});

test("synthesis errors stay in Activity without creating a review or deployment", async ({ page, studio, deployment }) => {
  await studio.goto("/deploy");
  await page.getByRole("button", { name: "Synthesize", exact: true }).click();
  await expect.poll(() => deployment.submitted.length).toBe(1);
  await deployment.fail("Invalid resource reference in the declaration.");
  const activity = page.getByRole("region", { name: "Activity", exact: true });
  await expect(activity).toContainText("Invalid resource reference in the declaration.");
  await expect(page.getByRole("dialog", { name: /Review deployment/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review plan", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Synthesize", exact: true })).toBeEnabled();
  expect(deployment.submitted.some(request => request.kind === "deploy-apply")).toBe(false);
});
