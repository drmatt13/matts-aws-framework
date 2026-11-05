import type { Page } from "@playwright/test";
import { test, expect, assertAccessible } from "./support/test";
import { connectionCatalogFixture } from "./support/aws-connections";
import {
  CHANGE_SET_ID, STACK_ACCOUNT, STACK_ID, STACK_NAME, inspectionFixtures, inspectionStatus,
  installInspectionFixtures, replyInspection,
} from "./support/stack-inspection";

const inspector = (page: Page) => page.getByRole("dialog", { name: `Stack details · ${STACK_NAME}`, exact: true });
const stackReads = (requests: readonly { path: string }[]) => requests.filter(request => request.path.startsWith("/api/deploy/stack?"));
const sections = (requests: readonly { path: string }[]) => stackReads(requests).map(request => new URL(request.path, "http://fixture.invalid").searchParams.get("section"));

async function openStack(page: Page) {
  const card = page.getByRole("group", { name: "Deployed deployment", exact: true });
  await expect(card).toBeVisible();
  if (!await card.evaluate(element => (element as HTMLDetailsElement).open)) await card.locator("summary").click();
  const trigger = page.getByRole("button", { name: `Inspect ${STACK_NAME}`, exact: true });
  await trigger.click();
  await expect(inspector(page)).toBeVisible();
  return trigger;
}

for (const width of [1440, 390])
  test(`deployed stack inspector lazily shows CloudFormation evidence at ${width}px`, async ({ page, studio }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const fixtures = installInspectionFixtures(studio);
    await studio.goto("/deploy");
    expect(stackReads(studio.requests)).toEqual([]);
    const trigger = await openStack(page);
    const dialog = inspector(page);
    await expect(dialog).toContainText("Authentication resources managed by the fixture framework");
    await expect(dialog).toContainText(STACK_ID);
    await expect(dialog).toContainText("Fixture deployment finished");
    await expect(dialog).toContainText("CAPABILITY_NAMED_IAM");
    await expect(dialog).toContainText("IN_SYNC");
    await expect(dialog).toContainText("fixture-cloudformation");
    await expect(dialog).toContainText("fixture-parent-stack");
    await expect(dialog).toContainText("fixture-root-stack");
    await expect(dialog).toContainText("fixture-rollback");
    await expect(dialog).toContainText("fixture-stack-notifications");
    expect(sections(studio.requests)).toEqual(["overview"]);
    await assertAccessible(page);
    await page.screenshot({ path: testInfo.outputPath("stack-overview.png"), fullPage: true });

    await dialog.getByRole("tab", { name: "Resources", exact: true }).click();
    await expect(dialog).toContainText("FixtureUserPool");
    await expect(dialog).toContainText("AWS::Cognito::UserPool");
    await expect(dialog).toContainText("us-east-1_fixturePool");
    await dialog.locator("summary").filter({ hasText: /^Resource details$/ }).click();
    await expect(dialog.getByText("Authentication/FixtureUserPool", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Load more resources", exact: true }).click();
    await expect(dialog).toContainText("FixturePoolPolicy");
    await expect(dialog).toContainText("FixtureUserPool");
    await expect(dialog.getByRole("button", { name: "Load more resources", exact: true })).toHaveCount(0);
    await assertAccessible(page);

    await dialog.getByRole("tab", { name: "Events", exact: true }).click();
    await expect(dialog).toContainText("Fixture resource update completed");
    await dialog.locator("summary").filter({ hasText: /^Event details$/ }).click();
    await expect(dialog.getByText("fixture-client-request", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Load more events", exact: true }).click();
    await expect(dialog).toContainText("Earlier fixture policy event");
    await expect(dialog).toContainText("Fixture resource update completed");

    await dialog.getByRole("tab", { name: "Outputs", exact: true }).click();
    await expect(dialog).toContainText("UserPoolId");
    await expect(dialog).toContainText("us-east-1_fixturePool");
    await expect(dialog).toContainText("Pool used by the fixture application");
    await expect(dialog).toContainText("browser-dev:UserPoolId");

    await dialog.getByRole("tab", { name: "Parameters", exact: true }).click();
    await expect(dialog).toContainText("DeploymentStage");
    await expect(dialog).toContainText("AdminPassword");
    await expect(dialog).toContainText("****");
    await expect(dialog).toContainText("NoEcho");
    await assertAccessible(page);

    await dialog.getByRole("tab", { name: "Template", exact: true }).click();
    await expect(dialog).toContainText("Fixture original deployed template");
    await expect(dialog).toContainText("AdminPassword");
    await expect(dialog).toContainText("****");
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await dialog.getByRole("button", { name: "Copy template", exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(fixtures.template.body);
    await dialog.getByRole("combobox", { name: "Template version", exact: true }).selectOption("Processed");
    await expect(dialog).toContainText("Fixture processed deployed template");
    await expect(dialog).not.toContainText("Fixture original deployed template");
    await assertAccessible(page);

    await dialog.getByRole("tab", { name: "Tags", exact: true }).click();
    await expect(dialog).toContainText("framework:deployment");
    await expect(dialog).toContainText("Fixture team");

    await dialog.getByRole("tab", { name: "Change sets", exact: true }).click();
    await expect(dialog).toContainText("fixture-security-update");
    await expect(dialog).toContainText("AVAILABLE");
    await dialog.getByRole("button", { name: "Inspect change set fixture-security-update", exact: true }).click();
    await dialog.locator("summary").filter({ hasText: /Modify · FixtureUserPool/ }).click();
    const propertyChange = dialog.locator("details[open] pre").filter({ hasText: "ResourceChange" });
    await expect(propertyChange).toContainText("DirectModification");
    await expect(propertyChange).toContainText("UserPoolName");
    await dialog.locator("summary").filter({ hasText: /^Change set parameters$/ }).click();
    await expect(dialog).toContainText("AdminPassword");
    await expect(dialog).toContainText("****");

    await dialog.getByRole("tab", { name: "Dependencies", exact: true }).click();
    await expect(dialog).toContainText("browser-dev:UserPoolId");
    expect(sections(studio.requests)).not.toContain("export-imports");
    await dialog.locator("summary").filter({ hasText: /^Importing stacks for browser-dev:UserPoolId$/ }).click();
    await expect(dialog).toContainText("browser-dev-WebSocketApisStack");
    await expect(dialog).toContainText("browser-dev:ReplayQueueArn");
    await assertAccessible(page);
    await page.screenshot({ path: testInfo.outputPath("stack-dependencies.png"), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    const reads = stackReads(studio.requests).map(request => new URL(request.path, "http://fixture.invalid"));
    expect(Object.fromEntries(reads[0]!.searchParams)).toMatchObject({ profile: "browser", deployment: "browser-dev", mode: "dev", account: STACK_ACCOUNT, region: "us-east-1", stack: STACK_NAME, section: "overview" });
    expect(reads[0]!.searchParams.has("stackId")).toBe(false);
    for (const read of reads.slice(1)) expect(read.searchParams.get("stackId")).toBe(STACK_ID);
    expect(reads.some(read => read.searchParams.get("changeSetId") === CHANGE_SET_ID)).toBe(true);
    expect(reads.some(read => read.searchParams.get("cursor") === "fixture-resource-page-2")).toBe(true);
    expect(reads.some(read => read.searchParams.get("cursor") === "fixture-event-page-2")).toBe(true);
    expect(reads.some(read => read.searchParams.get("section") === "export-imports" && read.searchParams.get("exportName") === "browser-dev:UserPoolId")).toBe(true);
    expect(studio.requests.filter(request => request.method !== "GET")).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

test("stack inspector exposes loading, bounded read errors, retry, and retained refresh evidence", async ({ page, studio }) => {
  const fixtures = installInspectionFixtures(studio);
  let releaseOverview!: () => void;
  const initialRead = new Promise<void>(resolve => { releaseOverview = resolve; });
  let rejectResources = true;
  let refreshPending = false;
  let releaseRefresh!: () => void;
  const refresh = new Promise<void>(resolve => { releaseRefresh = resolve; });
  studio.reply("GET", "/api/deploy/stack", async (route, url) => {
    const section = url.searchParams.get("section");
    if (section === "overview") await initialRead;
    if (section === "resources" && refreshPending) await refresh;
    if (section === "resources" && rejectResources) {
      await route.fulfill({ json: { ok: false, problem: { kind: "denied", message: "Fixture resource read was denied." } } });
      return;
    }
    await replyInspection(route, url, fixtures);
  });
  await studio.goto("/deploy");
  await openStack(page);
  const dialog = inspector(page);
  await expect(dialog.getByRole("status")).toContainText(/Loading|Reading/);
  expect(sections(studio.requests)).toEqual(["overview"]);
  releaseOverview();
  await expect(dialog).toContainText("Authentication resources managed by the fixture framework");
  await dialog.getByRole("tab", { name: "Resources", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Fixture resource read was denied.");
  rejectResources = false;
  await dialog.getByRole("button", { name: "Retry resources", exact: true }).click();
  await expect(dialog).toContainText("FixtureUserPool");
  refreshPending = true;
  await dialog.getByRole("button", { name: "Refresh resources", exact: true }).click();
  await expect(dialog).toContainText("FixtureUserPool");
  await expect(dialog.getByRole("button", { name: "Refresh resources", exact: true })).toBeDisabled();
  rejectResources = true;
  releaseRefresh();
  await expect(dialog.getByRole("alert")).toContainText("Fixture resource read was denied.");
  await expect(dialog).toContainText("FixtureUserPool");
  await assertAccessible(page);
  rejectResources = false;
  await dialog.getByRole("button", { name: "Retry resources", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog).toContainText("FixtureUserPool");
  expect(studio.requests.filter(request => request.method !== "GET")).toEqual([]);
});

test("stack inspector explains empty sections and independently denied stack policy", async ({ page, studio }) => {
  const fixtures = inspectionFixtures();
  fixtures.overview = { ...fixtures.overview, policy: { ok: false, problem: { kind: "denied", message: "Fixture policy permission is unavailable." } } };
  for (const section of ["resources", "events", "outputs", "parameters", "tags", "change-sets"] as const)
    Object.assign(fixtures[section], { items: [], nextCursor: undefined });
  fixtures.dependencies = { ...fixtures.dependencies, exports: [], imports: [] };
  installInspectionFixtures(studio, fixtures);
  await studio.goto("/deploy");
  await openStack(page);
  const dialog = inspector(page);
  await expect(dialog).toContainText("Fixture policy permission is unavailable.");
  await expect(dialog).toContainText(STACK_ID);
  for (const label of ["Resources", "Events", "Outputs", "Parameters", "Tags", "Change sets", "Dependencies"]) {
    await dialog.getByRole("tab", { name: label, exact: true }).click();
    await expect(dialog.getByRole("tabpanel")).toContainText(/No /);
    await expect(dialog.getByRole("button", { name: /^Load more/ })).toHaveCount(0);
  }
  await assertAccessible(page);
});

test("keyboard tabs stay in the stack inspector and Escape restores the selected stack", async ({ page, studio }) => {
  installInspectionFixtures(studio);
  await studio.goto("/deploy");
  const trigger = await openStack(page);
  const dialog = inspector(page);
  const overview = dialog.getByRole("tab", { name: "Overview", exact: true });
  await expect(dialog).toContainText("Authentication resources managed by the fixture framework");
  await expect(overview).toBeEnabled();
  await overview.focus();
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByRole("tab", { name: "Resources", exact: true })).toBeFocused();
  await expect(dialog.getByRole("tab", { name: "Resources", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(dialog.getByRole("tab", { name: "Dependencies", exact: true })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(overview).toBeFocused();
  await expect(overview).toHaveAttribute("aria-selected", "true");
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press("Tab");
    const focus = await dialog.evaluate(element => ({ inside: element.contains(document.activeElement), tag: document.activeElement?.tagName }));
    if (!focus.inside) {
      // Native Chrome permits a stop in browser chrome. Background application
      // controls remain inert, and the next Tab must return to this dialog.
      expect(focus.tag, `Tab ${index + 1} must not focus the background application`).toBe("BODY");
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
    }
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(page.getByRole("group", { name: "Deployed deployment", exact: true })).toBeVisible();
  expect(studio.requests.filter(request => request.method !== "GET")).toEqual([]);
});

test("parameters explain conservative masking when template visibility is unavailable", async ({ page, studio }) => {
  const fixtures = inspectionFixtures();
  fixtures.parameters = { ...fixtures.parameters,
    maskingProblem: { kind: "denied", message: "Fixture deployed template permission is unavailable." },
    items: fixtures.parameters.items.map(parameter => ({ ...parameter, value: "****", masked: true })),
  };
  installInspectionFixtures(studio, fixtures);
  await studio.goto("/deploy");
  await openStack(page);
  const dialog = inspector(page);
  await expect(dialog).toContainText(STACK_ID);
  await dialog.getByRole("tab", { name: "Parameters", exact: true }).click();
  await expect(dialog.getByRole("note")).toContainText("Parameter values are masked because template visibility could not be verified");
  await expect(dialog.getByRole("note")).toContainText("Fixture deployed template permission is unavailable.");
  const rows = dialog.getByRole("table").getByRole("row");
  await expect(rows.filter({ hasText: "DeploymentStage" })).toContainText("****");
  await expect(rows.filter({ hasText: "AdminPassword" })).toContainText("****");
  await expect(rows.filter({ hasText: "DeploymentStage" })).toContainText("Masked");
  await assertAccessible(page);
});

test("source refresh preserves the selected stack while credential changes clear it", async ({ page, studio }) => {
  const fixtures = installInspectionFixtures(studio);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  studio.reply("GET", "/api/deploy/stack", async (route, url) => {
    if (url.searchParams.get("section") === "resources") await pending;
    await replyInspection(route, url, fixtures);
  });
  await studio.goto("/deploy");
  await openStack(page);
  const dialog = inspector(page);
  await expect(dialog).toContainText(STACK_ID);
  await dialog.getByRole("tab", { name: "Resources", exact: true }).click();
  const before = sections(studio.requests).filter(section => section === "overview").length;
  Object.assign(studio.response.snapshot, { revision: "fixture-source-after-stack-inspection" });
  await studio.emit("snapshot", { revision: "fixture-source-after-stack-inspection", external: [] });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("group", { name: "Deployed deployment", exact: true })).toHaveJSProperty("open", true);
  await expect.poll(() => sections(studio.requests).filter(section => section === "overview").length).toBeGreaterThan(before);
  release();
  await expect(dialog).toContainText("FixtureUserPool");
  await studio.emit("aws-connections", { profiles: ["browser"] });
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Authentication resources managed by the fixture framework", { exact: true })).toHaveCount(0);
});

test("stack evidence follows mode, profile, and account changes without reusing another destination", async ({ page, studio }) => {
  installInspectionFixtures(studio);
  let account = STACK_ACCOUNT;
  studio.reply("GET", "/api/deploy/status", (route, url) => route.fulfill({ json: { ok: true, value: inspectionStatus(url, account) } }));
  studio.reply("GET", "/api/aws-connections", route => route.fulfill({ json: connectionCatalogFixture([
    { name: "browser", kind: "sso", region: "us-east-1" }, { name: "fixture-secondary", kind: "sso", region: "us-east-1" },
  ]) }));
  await studio.goto("/deploy");
  await openStack(page);
  const dialog = inspector(page);
  await expect(dialog).toContainText(STACK_ID);
  await dialog.getByRole("button", { name: "Close stack details", exact: true }).click();
  await page.getByRole("button", { name: "Production", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^browser-prod/ })).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(STACK_ID, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Development", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^browser-dev/ })).toBeVisible();
  await page.getByRole("button", { name: /Development AWS profile:/ }).click();
  await page.getByRole("button", { name: "Configure AWS profiles", exact: true }).click();
  const configuration = page.getByRole("dialog", { name: "AWS profile configuration", exact: true });
  await configuration.getByRole("button", { name: /^fixture-secondary IAM Identity Center/ }).click();
  await configuration.getByRole("combobox", { name: "Use for", exact: true }).selectOption("dev");
  await configuration.getByRole("button", { name: "Close AWS profile configuration", exact: true }).click();
  await expect(page.getByRole("button", { name: "Development AWS profile: fixture-secondary", exact: true })).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await openStack(page);
  await expect(dialog).toContainText(STACK_ID);
  expect(stackReads(studio.requests).at(-1)!.path).toContain("profile=fixture-secondary");
  account = "999999999999";
  await studio.emit("aws-connections", { profiles: ["fixture-secondary"] });
  await expect(dialog).toBeHidden();
  await expect(page.locator('[data-slot="deployment-context"]')).toContainText(`${account} · us-east-1`);
  await expect(page.getByText(STACK_ID, { exact: true })).toHaveCount(0);
  expect(studio.requests.filter(request => request.method !== "GET" && !["/api/deploy/preferences", "/api/aws-connections/check"].includes(request.path))).toEqual([]);
});
