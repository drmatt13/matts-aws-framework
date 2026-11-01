import type { SnapshotResponse } from "../../shared/api";
import type { DeploymentInputDetails, DeploymentInputEntry, DeploymentInputPlan } from "../../shared/deployment-inputs";
import type { Mode, ModelEdge, ModelResource } from "../../shared/model";
import { test, expect, assertAccessible, type Handler } from "./support/test";

const environmentId = "envfile:cdk";
const inputId = "resource:browserEnvironment.publicSetting";
const secretId = "resource:browserEnvironment.apiToken";
const inputName = "BROWSER_PUBLIC_SETTING";
const secretName = "BROWSER_API_TOKEN";
const requiredName = "BROWSER_REQUIRED_LABEL";
const file = (mode: Mode) => `cdk-app/.env.${mode}`;
type Fixture = { response: SnapshotResponse; reply(method: string, path: string, handler: Handler): void };

/** These are synthetic browser-only values. No private files or Studio server are read. */
function environmentFixture(studio: Fixture) {
  const values: Record<Mode, string> = { dev: "browser-development", prod: "browser-production" };
  const entries = (mode: Mode): DeploymentInputEntry[] => [
    { name: inputName, status: "configured", counterpart: "configured", sensitive: false, defaulted: false, targets: [inputId] },
    { name: secretName, status: "configured", counterpart: "configured", sensitive: true, defaulted: false, targets: [secretId] },
    { name: requiredName, status: "missing", counterpart: "missing", sensitive: false, defaulted: false, targets: [],
      requirements: [{ resource: "resource:browserRequired", name: requiredName, mode, file: file(mode), required: true, status: "missing", reasons: ["Required by the browser fixture."] }] },
  ];
  const physical = (mode: Mode, graph: Mode): ModelResource => ({
    id: `envfile:${mode}`, kind: "envFile", path: [file(mode)], absent: mode !== graph,
    deploymentFile: { mode, path: file(mode), template: `${file(mode)}.template`, exists: true, entries: entries(mode) },
  });
  const logical: ModelResource = {
    id: environmentId, kind: "envFile", path: ["CDK environment"], absent: false,
    deploymentFiles: { dev: "envfile:dev", prod: "envfile:prod" },
  };
  const modes = { dev: { present: true, required: false }, prod: { present: true, required: false } };
  const inputs: ModelResource[] = [
    { id: inputId, kind: "input", path: ["browserEnvironment", "publicSetting"], fromEnv: inputName, absent: false, modes },
    { id: secretId, kind: "secret", path: ["browserEnvironment", "apiToken"], fromEnv: secretName, absent: false, modes },
  ];
  const supplies: ModelEdge[] = (["dev", "prod"] as const).flatMap(mode => [
    [inputName, inputId], [secretName, secretId],
  ].map(([name, target]) => ({
    id: `input-source:${mode}:${name}:${target}`, relation: "supplies", from: `envfile:${mode}`, to: target!, provenance: "source", label: name!,
    inputRequirement: { resource: target!, name: name!, mode, file: file(mode), required: false, status: "configured", reasons: [] },
  })));
  for (const model of Object.values(studio.response.snapshot.models)) Object.assign(model, {
    resources: [...model.resources, logical, physical("dev", model.mode), physical("prod", model.mode), ...inputs],
    edges: [...model.edges, ...supplies],
  });
  const details = (mode: Mode): DeploymentInputDetails => ({
    file: file(mode), hash: `browser-file-${mode}`, entries: [
      { name: inputName, value: values[mode], sensitive: false },
      { name: secretName, value: "", sensitive: true, hidden: true },
    ],
  });
  studio.reply("GET", "/api/deployment-inputs/details", async (route, url) => {
    await route.fulfill({ json: details(url.searchParams.get("mode") === "prod" ? "prod" : "dev") });
  });
  studio.reply("GET", "/api/deployment-inputs/value", async (route, url) => {
    await route.fulfill({ json: { name: secretName, value: `browser-only-${url.searchParams.get("mode")}-secret` } });
  });
  studio.reply("GET", "/api/resources/details", async (route, url) => {
    const mode = url.searchParams.get("mode") === "prod" ? "prod" : "dev";
    await route.fulfill({ json: { configured: true, value: values[mode], file: file(mode), inputFile: { exists: true, hash: `browser-file-${mode}` } } });
  });
  return { values, details };
}

const environmentName = (mode: Mode) => (mode === "dev" ? "Development" : "Production");

for (const width of [1440, 390]) test(`CDK environment edits both files side by side and reviews them together at ${width}px`, async ({ page, studio }, info) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width, height: 1000 });
  const fixture = environmentFixture(studio);
  let planned: { files: { mode: Mode; hash: string; edits: { name: string; value: string }[] }[]; revision: string } | undefined;
  studio.reply("POST", "/api/deployment-inputs/plan", async route => {
    planned = route.request().postDataJSON();
    const plan: DeploymentInputPlan = { planId: "browser-private-review", ok: true,
      summaries: planned!.files.flatMap(item => item.edits.map(edit => `Update ${edit.name} in .env.${item.mode}`)),
      changes: planned!.files.map(item => ({ file: file(item.mode), diff: { unified: `${inputName}=<hidden>`, lines: [{ kind: "add", text: `${inputName}=<hidden>`, newLine: 1 }] } })) };
    await route.fulfill({ json: plan });
  });
  studio.reply("POST", "/api/deployment-inputs/apply", async route => {
    for (const item of planned!.files) fixture.values[item.mode] = item.edits.find(edit => edit.name === inputName)!.value;
    await route.fulfill({ json: { status: "applied", message: `Saved ${planned!.files.map(item => file(item.mode)).join(" and ")}.`, revision: studio.response.snapshot.revision } });
  });
  await studio.goto(`/?select=${encodeURIComponent(environmentId)}`);
  const panel = page.getByRole("complementary", { name: "Inspector", exact: true });
  const source = page.getByRole("group", { name: "Source environment", exact: true });
  const row = (name: string) => panel.locator(`[data-slot="environment-variable"][data-variable="${name}"]`);
  const value = (name: string, mode: Mode) => panel.getByRole("textbox", { name: `Value for ${name} in ${environmentName(mode)}`, exact: true });
  const readiness = (mode: Mode) => panel.locator(`[data-slot="environment-readiness-row"][data-environment="${mode}"]`);
  await expect(panel.getByRole("heading", { name: "CDK environment", exact: true })).toBeVisible();
  await expect(panel.locator('[data-slot="cdk-environment-files"]')).toContainText(file("dev"));
  await expect(panel.locator('[data-slot="cdk-environment-files"]')).toContainText(file("prod"));
  for (const mode of ["dev", "prod"] as const) await expect(readiness(mode)).toContainText("1 required value missing");
  await expect(row(inputName).locator('summary [data-environment="dev"]')).toHaveAttribute("data-enabled", "true");
  await expect(row(requiredName).locator('summary [data-environment="prod"]')).toHaveAttribute("data-attention", "true");

  await row(inputName).locator("summary").click();
  await expect(value(inputName, "dev")).toHaveValue(fixture.values.dev);
  await expect(value(inputName, "prod")).toHaveValue(fixture.values.prod);
  await row(secretName).locator("summary").click();
  await expect(panel.locator(`input[aria-label="Value for ${secretName} in Development"]`)).toHaveAttribute("type", "password");
  expect(studio.requests.filter(request => request.path.startsWith("/api/deployment-inputs/value"))).toHaveLength(0);

  await value(inputName, "dev").fill("browser-reviewed-development");
  await value(inputName, "prod").fill("browser-reviewed-production");
  await expect(row(inputName).locator('[data-slot="environment-variable-edited"]')).toBeVisible();
  await expect(source.getByRole("button", { name: "Development", exact: true })).toHaveAttribute("aria-pressed", "true");
  await panel.getByRole("button", { name: "Review Changes", exact: true }).click();
  const review = page.getByRole("dialog");
  await expect(review).toContainText(file("dev"));
  await expect(review).toContainText(file("prod"));
  await expect(review).not.toContainText("browser-reviewed");
  expect(studio.requests.filter(request => request.path === "/api/deployment-inputs/plan").at(-1)!.body).toMatchObject({ files: [
    { mode: "dev", hash: "browser-file-dev", edits: [{ name: inputName, value: "browser-reviewed-development" }] },
    { mode: "prod", hash: "browser-file-prod", edits: [{ name: inputName, value: "browser-reviewed-production" }] },
  ] });
  await review.getByRole("button", { name: "Apply All", exact: true }).click();
  await expect(review).not.toBeVisible();
  await expect(row(inputName)).toHaveJSProperty("open", true);
  await expect(value(inputName, "dev")).toHaveValue("browser-reviewed-development");
  await expect(value(inputName, "prod")).toHaveValue("browser-reviewed-production");

  // Readiness narrows the list to what one environment still needs, opened and ready to fill.
  await readiness("prod").getByRole("button", { name: "Show what Production still needs", exact: true }).click();
  await expect(panel.locator('[data-slot="environment-variable"]')).toHaveCount(1);
  await expect(value(requiredName, "prod")).toBeVisible();
  await value(requiredName, "prod").fill("browser-label");
  await expect(readiness("prod")).toContainText("Every required value is set");
  await expect(panel.locator('[data-slot="environment-variable"]')).toHaveCount(1);
  await readiness("prod").getByRole("button", { name: "Show all variables", exact: true }).click();
  await expect(panel.locator('[data-slot="environment-variable"]')).toHaveCount(3);
  await assertAccessible(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.screenshot({ path: info.outputPath("combined-environment.png"), animations: "disabled" });
  expect(studio.requests.filter(request => request.path === "/api/deployment-inputs/apply")).toHaveLength(1);
  expect(studio.requests.filter(request => request.path === "/api/deployment-inputs/create")).toHaveLength(0);
});

test("each environment's reads and reveals land in its own field across delayed responses and retries", async ({ page, studio }) => {
  const fixture = environmentFixture(studio);
  let releaseDetails!: () => void;
  const pendingDetails = new Promise<void>(resolve => { releaseDetails = resolve; });
  let state: "error" | "ready" = "error";
  studio.reply("GET", "/api/deployment-inputs/details", async (route, url) => {
    const mode = url.searchParams.get("mode") === "prod" ? "prod" : "dev";
    if (mode === "dev") await pendingDetails;
    if (mode === "prod" && state === "error") {
      await route.fulfill({ status: 503, json: { error: "Browser fixture could not read Production inputs." } }); return;
    }
    await route.fulfill({ json: fixture.details(mode) });
  });
  await studio.goto(`/?select=${encodeURIComponent(environmentId)}`);
  const panel = page.getByRole("complementary", { name: "Inspector", exact: true });
  const row = (name: string) => panel.locator(`[data-slot="environment-variable"][data-variable="${name}"]`);
  const value = (name: string, mode: Mode) => panel.getByRole("textbox", { name: `Value for ${name} in ${environmentName(mode)}`, exact: true });
  await expect(panel.getByRole("status").filter({ hasText: "Reading local values" })).toBeVisible();
  await expect(panel.getByRole("alert").filter({ hasText: "Browser fixture could not read Production inputs." })).toBeVisible();
  await row(inputName).locator("summary").click();
  await row(secretName).locator("summary").click();
  releaseDetails();
  await expect(value(inputName, "dev")).toHaveValue(fixture.values.dev);
  await expect(value(inputName, "prod")).toBeDisabled();
  state = "ready";
  await panel.getByRole("button", { name: "Retry reading", exact: true }).click();
  await expect(value(inputName, "prod")).toHaveValue(fixture.values.prod);
  await expect(value(inputName, "dev")).toHaveValue(fixture.values.dev);

  let releaseReveal!: () => void;
  const pendingReveal = new Promise<void>(resolve => { releaseReveal = resolve; });
  let failReveal = true;
  studio.reply("GET", "/api/deployment-inputs/value", async (route, url) => {
    const mode = url.searchParams.get("mode");
    if (failReveal) { await route.fulfill({ status: 503, json: { error: "Browser fixture could not reveal this input." } }); return; }
    if (mode === "prod") await pendingReveal;
    await route.fulfill({ json: { name: secretName, value: `browser-only-${mode}-secret` } });
  });
  const masked = panel.locator(`input[aria-label="Value for ${secretName} in Development"]`);
  await panel.getByRole("button", { name: `Reveal ${secretName} in Development`, exact: true }).click();
  await expect(panel.getByRole("alert").filter({ hasText: "Could not reveal this value. Try Reveal again." })).toBeVisible();
  await expect(masked).toHaveAttribute("type", "password");
  failReveal = false;
  // A slow production reveal never lands in the development field, or the reverse.
  await panel.getByRole("button", { name: `Reveal ${secretName} in Production`, exact: true }).click();
  await expect.poll(() => studio.requests.some(request => request.path.includes("/api/deployment-inputs/value?mode=prod"))).toBe(true);
  await panel.getByRole("button", { name: `Reveal ${secretName} in Development`, exact: true }).click();
  await expect(value(secretName, "dev")).toHaveValue("browser-only-dev-secret");
  releaseReveal();
  await expect(value(secretName, "prod")).toHaveValue("browser-only-prod-secret");
  await expect(value(secretName, "dev")).toHaveValue("browser-only-dev-secret");
  await panel.getByRole("button", { name: `Hide ${secretName} in Development`, exact: true }).click();
  await expect(masked).toHaveAttribute("type", "password");
  expect(studio.requests.filter(request => /\/deployment-inputs\/(plan|apply)$/.test(request.path))).toHaveLength(0);
});

test("legacy file links open the combined editor and inspector history restores its open rows", async ({ page, studio }) => {
  environmentFixture(studio);
  await studio.goto("/?select=envfile%3Aprod");
  const panel = page.getByRole("complementary", { name: "Inspector", exact: true });
  const row = panel.locator(`[data-slot="environment-variable"][data-variable="${inputName}"]`);
  await expect(panel.getByRole("heading", { name: "CDK environment", exact: true })).toBeVisible();
  await row.locator("summary").click();
  await panel.getByRole("button", { name: "browserEnvironment.publicSetting", exact: true }).first().click();
  await expect(panel.getByRole("heading", { name: "publicSetting", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Back to CDK environment", exact: true }).click();
  await expect(row).toHaveJSProperty("open", true);
  await page.goForward();
  await expect(panel.getByRole("heading", { name: "publicSetting", exact: true })).toBeVisible();
  await page.goBack();
  await expect(row).toHaveJSProperty("open", true);
  await panel.getByRole("button", { name: "Back to Resources", exact: true }).click();
  const resources = page.getByRole("complementary", { name: "Resources", exact: true });
  await expect(resources.locator(`[data-resource-id="${environmentId}"]`)).toHaveCount(1);
  await expect(resources.locator('[data-resource-id="envfile:dev"], [data-resource-id="envfile:prod"]')).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Search isometric map", exact: true }).fill(".env.prod");
  await expect(resources.locator(`[data-resource-id="${environmentId}"]`)).toBeVisible();
  await resources.locator(`[data-resource-id="${environmentId}"]`).click();
  await expect(panel.getByRole("heading", { name: "CDK environment", exact: true })).toBeVisible();
  expect(studio.requests.filter(request => /\/deployment-inputs\/(create|plan|apply)$/.test(request.path))).toHaveLength(0);
});

test("a combined supply keeps one input row with both environment pills and original file evidence", async ({ page, studio }) => {
  environmentFixture(studio);
  const connection = `connection:${encodeURIComponent(environmentId)}:${encodeURIComponent(inputId)}:supplies`;
  await studio.goto(`/?select=${encodeURIComponent(connection)}`);
  const panel = page.getByRole("complementary", { name: "Inspector", exact: true });
  const members = panel.locator('[data-slot="connection-map-member"]');
  await expect(members).toHaveCount(1);
  const summary = members.locator(":scope > summary");
  await expect(summary).toContainText(inputName);
  await expect(summary.locator('[data-environment="dev"]')).toHaveAttribute("data-enabled", "true");
  await expect(summary.locator('[data-environment="prod"]')).toHaveAttribute("data-enabled", "true");
  await summary.click();
  const evidence = members.locator('[data-slot="connection-source-environment"]');
  await expect(evidence).toHaveCount(2);
  await expect(evidence.nth(0)).toContainText(file("dev"));
  await expect(evidence.nth(1)).toContainText(file("prod"));
  await expect(panel).not.toContainText("browser-development");
  await expect(panel).not.toContainText("browser-production");
  expect(studio.requests.filter(request => request.path.startsWith("/api/deployment-inputs/"))).toHaveLength(0);
});

test("failed automatic setup can retry only its missing environment", async ({ page, studio }) => {
  environmentFixture(studio);
  for (const model of Object.values(studio.response.snapshot.models)) {
    const prod = model.resources.find(resource => resource.id === "envfile:prod")!.deploymentFile!;
    Object.assign(prod, { exists: false, entries: [], setupProblem: "Could not create cdk-app/.env.prod. Check directory permissions and retry." });
  }
  studio.reply("POST", "/api/deployment-inputs/create", async route => {
    expect(route.request().postDataJSON()).toEqual({ mode: "prod" });
    for (const model of Object.values(studio.response.snapshot.models))
      Object.assign(model.resources.find(resource => resource.id === "envfile:prod")!.deploymentFile!, { exists: true, setupProblem: undefined });
    Object.assign(studio.response.snapshot, { revision: "browser-after-setup" });
    await route.fulfill({ json: { file: file("prod"), created: true } });
  });
  await studio.goto("/?select=envfile%3Aprod");
  const panel = page.getByRole("complementary", { name: "Inspector", exact: true });
  await expect(panel.getByText("Could not create cdk-app/.env.prod.")).toBeVisible();
  await expect(panel.locator('[data-slot="environment-readiness-row"][data-environment="prod"]')).toContainText("File missing");
  expect(studio.requests.filter(request => request.path === "/api/deployment-inputs/create")).toHaveLength(0);
  const row = panel.locator(`[data-slot="environment-variable"][data-variable="${inputName}"]`);
  await row.locator("summary").click();
  await expect(row.locator('[data-slot="environment-value"][data-environment="prod"]')).toContainText("cdk-app/.env.prod is missing.");
  await expect(panel.getByRole("textbox", { name: `Value for ${inputName} in Development`, exact: true })).toHaveValue("browser-development");
  await panel.getByRole("button", { name: "Create .env.prod from template", exact: true }).click();
  await expect(panel.getByRole("textbox", { name: `Value for ${inputName} in Production`, exact: true })).toHaveValue("browser-production");
  await expect(panel.getByRole("button", { name: /^Create \.env/ })).toHaveCount(0);
  expect(studio.requests.filter(request => request.path === "/api/deployment-inputs/create")).toHaveLength(1);
});
