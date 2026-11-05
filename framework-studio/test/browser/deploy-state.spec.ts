import type { DiscoveredDeploymentView, JobView, OperationRequest, PlanSummaryView, PlanView, StatusView, TeardownPlanView } from "../../shared/deploy";
import { test, expect, assertAccessible } from "./support/test";
import { deploymentPlan, discoveryFor, NOW, overview } from "./support/scenarios";

const ACCOUNT = "123456789012";
const names = ["DevLambdaReplayStack", "AsynchronousLambdaFunctionsStack", "CognitoStack", "WebSocketLambdaFunctionsStack", "WebSocketApisStack"];

function deployment(mode: "dev" | "prod" = "dev", account = ACCOUNT): DiscoveredDeploymentView {
  const name = `browser-${mode}`;
  const stacks = names.map(suffix => ({ name: `${name}-${suffix}`, status: "UPDATE_COMPLETE", health: "complete" as const,
    evidence: "tags" as const, identity: { deployment: name, mode, contract: 2 as const } }));
  return { name, mode, account, region: "us-east-1", contracts: [2], state: { kind: "ready", stacks }, stacks, lastUpdated: NOW };
}

function observed(url: URL, detail?: DiscoveredDeploymentView, account = ACCOUNT): StatusView {
  const original = discoveryFor(url);
  return { ...original, deployment: url.searchParams.get("deployment")!,
    context: { ...original.context, account, arn: `arn:aws:iam::${account}:role/browser-fixture` },
    targets: original.targets.map(target => ({ ...target, status: detail?.name === target.name ? "deployed" as const : "absent" as const })),
    deployments: detail ? [detail] : [], ...(detail ? { detail: { ...detail, events: [], changeSets: [] } } : {}) };
}

function plan(key: string, createdAt: string): PlanView {
  return { ...deploymentPlan(), key, planId: `${key}-id`, createdAt, synthesis: { current: true },
    confirmation: { level: "click", reasons: [] }, uncertainties: [], stacks: [] };
}

function summary(value: PlanView): PlanSummaryView {
  return { key: value.key, deployment: value.identity.deployment, mode: value.identity.mode,
    account: value.identity.account, region: value.identity.region, profile: value.profile, status: value.status,
    createdAt: value.createdAt, expired: value.expired, synthesis: value.synthesis,
    ...(value.result ? { applied: value.result.status } : {}) };
}

for (const width of [1440, 390])
  test(`applying the newest plan never promotes an older proposal at ${width}px`, async ({ page, studio }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const older = plan("older-development", "2026-10-28T11:00:00.000Z");
    const latest = plan("latest-development", NOW);
    const plans = [older, latest];
    const submitted: OperationRequest[] = [];
    const jobs: JobView[] = [];
    studio.reply("GET", "/api/deploy/overview", route => route.fulfill({ json: { ...overview(), jobs } }));
    studio.reply("GET", "/api/operations", route => route.fulfill({ json: { jobs } }));
    studio.reply("GET", "/api/deploy/plans", route => route.fulfill({ json: plans.map(summary) }));
    for (const value of plans) studio.reply("GET", `/api/deploy/plans/${value.key}`, route => route.fulfill({ json: value }));
    studio.reply("GET", "/api/deploy/status", (route, url) => route.fulfill({ json: { ok: true,
      value: observed(url, url.searchParams.get("deployment") === "browser-dev" ? deployment() : undefined) } }));
    studio.reply("POST", "/api/deploy/operations", async route => {
      const request = route.request().postDataJSON() as OperationRequest;
      submitted.push(request);
      Object.assign(latest, { result: { status: "succeeded", deferred: [], verification: { verified: true, stacks: [] } } });
      const job: JobView = { id: "fixture-apply-latest", kind: request.kind, params: request.params, deployment: "browser-dev",
        planId: latest.key, title: "Deploy browser-dev", status: "succeeded", startedAt: NOW, endedAt: NOW,
        summary: "browser-dev is deployed and verified.", lastSeq: 0 };
      jobs.push(job);
      studio.reply("GET", `/api/operations/${job.id}/log`, logRoute => logRoute.fulfill({ json: { job, lines: [] } }));
      await route.fulfill({ json: job });
    });
    await studio.goto("/deploy");
    const current = page.getByRole("article").filter({ hasText: "Plan ready for review" });
    await expect(current).toHaveCount(1);
    await current.getByRole("button", { name: "Review plan", exact: true }).click();
    const review = page.getByRole("dialog", { name: /^Review deployment for browser-dev\b/ });
    await review.getByRole("button", { name: "Deploy development", exact: true }).click();
    await expect.poll(() => submitted.length).toBe(1);
    expect(submitted[0]).toMatchObject({ kind: "deploy-apply", params: { plan: latest.key, currentSource: true } });
    await studio.emit("deploy-changed", { deployment: "browser-dev", profile: "browser", account: ACCOUNT, region: "us-east-1" });
    await expect(current).toHaveCount(0);
    const earlier = page.locator("summary").filter({ hasText: /^Earlier plans \(1\)$/ });
    await expect(earlier).toBeVisible();
    await expect(page.getByRole("button", { name: "Review plan", exact: true })).toHaveCount(0);
    await earlier.focus();
    await page.keyboard.press("Enter");
    await expect(earlier.locator("xpath=..").getByRole("button", { name: "Review plan", exact: true })).toBeVisible();
    await expect(page.locator("summary").filter({ hasText: /^Deployed · 5 stacks$/ })).toBeVisible();
    await assertAccessible(page);
    await page.screenshot({ path: testInfo.outputPath("applied-plan-and-earlier-proposal.png"), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

for (const width of [1440, 390])
  test(`deployed stacks expand and destruction requires a separate review at ${width}px`, async ({ page, studio }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const deployed = deployment();
    studio.reply("GET", "/api/deploy/status", (route, url) => route.fulfill({ json: { ok: true,
      value: observed(url, url.searchParams.get("deployment") === "browser-dev" ? deployed : undefined) } }));
    const deletion: TeardownPlanView = { key: "delete-fixture-review", deployment: "browser-dev", mode: "dev", account: ACCOUNT,
      region: "us-east-1", createdAt: NOW, expiresAt: "2030-01-01T00:00:00.000Z", digest: "fixture-deletion-digest",
      stacks: deployed.stacks.map(stack => ({ name: stack.name, id: `arn:aws:cloudformation:us-east-1:${ACCOUNT}:stack/${stack.name}/fixture-id`,
        status: stack.status, terminationProtection: false, importedBy: [] })), leftInPlace: [], remains: [], secrets: [], record: true };
    studio.reply("GET", "/api/deploy/teardown", route => route.fulfill({ json: { ok: true, value: deletion } }));
    await studio.goto("/deploy");
    const deployedCard = page.getByRole("group", { name: "Deployed deployment", exact: true });
    const disclosure = deployedCard.locator("summary").filter({ hasText: /^Deployed · 5 stacks$/ });
    await expect(disclosure).toBeVisible();
    await expect(deployedCard.getByRole("region", { name: "Deployed stacks", exact: true })).toBeHidden();
    await disclosure.focus();
    await page.keyboard.press("Enter");
    const stacks = deployedCard.getByRole("region", { name: "Deployed stacks", exact: true });
    await expect(stacks).toBeVisible();
    for (const name of names) await expect(stacks).toContainText(`browser-dev-${name}`);
    await expect(stacks).toContainText("UPDATE_COMPLETE");
    await expect(deployedCard).toContainText(ACCOUNT);
    await expect(deployedCard).toContainText("us-east-1");
    const destroy = deployedCard.getByRole("button", { name: "Destroy…", exact: true });
    await expect(destroy).toBeEnabled();
    await assertAccessible(page);
    await page.screenshot({ path: testInfo.outputPath("deployed-stack-details.png"), fullPage: true });
    await destroy.click();
    const review = page.getByRole("dialog", { name: /^Delete browser-dev\b/ });
    await expect(review).toBeVisible();
    await expect.poll(() => studio.requests.filter(request => request.path.startsWith("/api/deploy/teardown?")).length).toBe(1);
    const requestedReview = studio.requests.find(request => request.path.startsWith("/api/deploy/teardown?"));
    expect(Object.fromEntries(new URL(requestedReview!.path, "http://fixture.invalid").searchParams)).toMatchObject({
      deployment: "browser-dev", mode: "dev", profile: "browser", region: "us-east-1",
    });
    const confirm = review.getByRole("button", { name: "Delete browser-dev", exact: true });
    await expect(confirm).toBeDisabled();
    await review.getByRole("textbox", { name: "Type browser-dev to delete it", exact: true }).fill("another-deployment");
    await expect(confirm).toBeDisabled();
    await review.getByRole("textbox", { name: "Type browser-dev to delete it", exact: true }).fill("browser-dev");
    await expect(confirm).toBeEnabled();
    await assertAccessible(page);
    await review.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(review).toBeHidden();
    await expect(destroy).toBeFocused();
    expect(studio.requests.filter(request => request.method !== "GET")).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

test("synthesis and same-destination source refresh preserve deployed evidence", async ({ page, studio }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let delay = false;
  const jobs: JobView[] = [];
  studio.reply("GET", "/api/deploy/overview", route => route.fulfill({ json: { ...overview(), jobs } }));
  studio.reply("GET", "/api/operations", route => route.fulfill({ json: { jobs } }));
  studio.reply("GET", "/api/deploy/status", async (route, url) => {
    if (delay) await pending;
    await route.fulfill({ json: { ok: true, value: observed(url, url.searchParams.get("deployment") === "browser-dev" ? deployment() : undefined) } });
  });
  studio.reply("POST", "/api/deploy/operations", async route => {
    const request = route.request().postDataJSON() as OperationRequest;
    const job: JobView = { id: "fixture-synthesis-running", kind: request.kind, params: request.params, deployment: "browser-dev",
      title: "Synthesize browser-dev", status: "running", startedAt: NOW, lastSeq: 0 };
    jobs.push(job);
    studio.reply("GET", `/api/operations/${job.id}/log`, logRoute => logRoute.fulfill({ json: { job, lines: [] } }));
    await route.fulfill({ json: job });
  });
  await studio.goto("/deploy");
  const deployed = page.locator("summary").filter({ hasText: /^Deployed · 5 stacks$/ });
  await expect(deployed).toBeVisible();
  await deployed.click();
  const stacks = page.getByRole("region", { name: "Deployed stacks", exact: true });
  await expect(stacks).toBeVisible();
  await page.getByRole("button", { name: "Synthesize", exact: true }).click();
  await expect(page.getByRole("button", { name: "Synthesizing…", exact: true })).toBeDisabled();
  delay = true;
  const before = studio.requests.filter(request => request.path.startsWith("/api/deploy/status?")).length;
  Object.assign(studio.response.snapshot, { revision: "source-after-synthesis-start" });
  await studio.emit("snapshot", { revision: "source-after-synthesis-start", external: [] });
  await expect.poll(() => studio.requests.filter(request => request.path.startsWith("/api/deploy/status?")).length).toBeGreaterThan(before);
  await expect(deployed).toBeVisible();
  await expect(stacks).toBeVisible();
  await expect(stacks).toContainText("browser-dev-CognitoStack");
  await expect(page.locator('[data-slot="deployment-context"]')).toContainText(`${ACCOUNT} · us-east-1`);
  await expect(page.getByRole("button", { name: "Development", exact: true }).locator('[data-deployment-state]')).toHaveAttribute("data-deployment-state", "deployed");
  await expect(page.getByText("Reading what the account holds…", { exact: true })).toHaveCount(0);
  release();
  await expect(deployed).toBeVisible();
});

test("mode dots follow their own deployed destination and clear on connection changes", async ({ page, studio }) => {
  let account = ACCOUNT;
  let productionReady = false;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let delay = false;
  studio.reply("GET", "/api/deploy/status", async (route, url) => {
    if (delay) await pending;
    const mode = url.searchParams.get("deployment") === "browser-prod" ? "prod" : "dev";
    const ready = account === ACCOUNT && (mode === "dev" || productionReady);
    await route.fulfill({ json: { ok: true, value: observed(url, ready ? deployment(mode) : undefined, account) } });
  });
  await studio.goto("/deploy");
  const source = page.getByRole("group", { name: "Source environment", exact: true });
  const development = source.getByRole("button", { name: "Development", exact: true });
  const production = source.getByRole("button", { name: "Production", exact: true });
  const devDot = development.locator('[data-deployment-state]');
  const prodDot = production.locator('[data-deployment-state]');
  await expect(devDot).toHaveAttribute("data-deployment-state", "deployed");
  await expect(prodDot).toHaveAttribute("data-deployment-state", "absent");
  await page.getByRole("link", { name: "GraphQL", exact: true }).click();
  await expect(devDot).toHaveAttribute("data-deployment-state", "deployed");
  await expect(prodDot).toHaveAttribute("data-deployment-state", "absent");
  productionReady = true;
  await studio.emit("deploy-changed", { deployment: "browser-prod", profile: "browser", account: ACCOUNT, region: "us-east-1" });
  await expect(prodDot).toHaveAttribute("data-deployment-state", "deployed");
  await expect(devDot).toHaveAttribute("data-deployment-state", "deployed");
  delay = true;
  await studio.emit("aws-connections", { profiles: ["browser"] });
  await expect(devDot).not.toHaveAttribute("data-deployment-state", "deployed");
  account = "999999999999";
  release();
  await expect(devDot).toHaveAttribute("data-deployment-state", "absent");
  await expect(prodDot).not.toHaveAttribute("data-deployment-state", "deployed");
  await page.getByRole("link", { name: "Deploy", exact: true }).click();
  await expect(page.locator('[data-slot="deployment-context"]')).toContainText("999999999999 · us-east-1");
  await expect(page.locator("summary").filter({ hasText: /^Deployed · 5 stacks$/ })).toHaveCount(0);
  expect(studio.requests.filter(request => request.method !== "GET")).toEqual([]);
});

test("a failed AWS refresh preserves deployed details and requires fresh evidence before destruction", async ({ page, studio }) => {
  let denied = false;
  studio.reply("GET", "/api/deploy/status", async (route, url) => {
    const dev = url.searchParams.get("deployment") === "browser-dev";
    await route.fulfill({ json: denied && dev
      ? { ok: false, problem: { kind: "denied", message: "Fixture AWS read access is unavailable." } }
      : { ok: true, value: observed(url, dev ? deployment() : undefined) } });
  });
  await studio.goto("/deploy");
  const deployed = page.getByRole("group", { name: "Deployed deployment", exact: true });
  await deployed.locator("summary").click();
  const stacks = deployed.getByRole("region", { name: "Deployed stacks", exact: true });
  const destroy = deployed.getByRole("button", { name: "Destroy…", exact: true });
  await expect(destroy).toBeEnabled();
  denied = true;
  await studio.emit("deploy-changed", { deployment: "browser-dev", profile: "browser", account: ACCOUNT, region: "us-east-1" });
  await expect(page.getByRole("alert")).toContainText("Fixture AWS read access is unavailable.");
  await expect(deployed).toBeVisible();
  await expect(stacks).toBeVisible();
  await expect(stacks).toContainText("browser-dev-CognitoStack");
  await expect(destroy).toBeDisabled();
  await expect(page.getByRole("button", { name: "Development", exact: true }).locator('[data-deployment-state]')).toHaveAttribute("data-deployment-state", "attention");
  expect(studio.requests.filter(request => request.method !== "GET")).toEqual([]);
  expect(studio.requests.some(request => request.path.startsWith("/api/deploy/teardown"))).toBe(false);
});
