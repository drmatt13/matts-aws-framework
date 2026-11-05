import type { Page, TestInfo } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Sightline } from "../../src/sightline/types";
import type { JobView } from "../../shared/operations";
import type { DatabaseHistory } from "../../shared/database-history";
import { test, expect, assertAccessible } from "./support/test";
import { NOW, discoveryFor, workbench } from "./support/scenarios";

const tray = (page: Page) => page.getByRole("region", { name: "Activity", exact: true });
const agent = (page: Page) => tray(page).getByRole("tabpanel", { name: /^Agent/ });
const sightline = (page: Page) => page.getByRole("region", { name: "Sightline", exact: true });
const conversation = (page: Page) => tray(page).getByRole("tab", { name: "Conversation", exact: true });
const toggle = (page: Page) => tray(page).getByRole("button", { name: /^(Activity|Agent): (expand|collapse) panel$/ });
const question = (page: Page) => agent(page).getByRole("textbox", { name: "Ask the agent", exact: true });
/** Enter does nothing until the agent check has finished, which Send shows by enabling. */
async function ask(page: Page, text: string) {
  await question(page).fill(text);
  await expect(agent(page).getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await question(page).press("Enter");
}

test.beforeEach(async ({ context, studio }) => {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text: string) => { Object.assign(window, { __sightlineCopied: text }); },
    } });
  });
  studio.reply("GET", "/api/agent-lab/status", route => route.fulfill({ json: {
    providers: ["codex", "claude"].map(id => ({ id, label: id === "codex" ? "Codex" : "Claude", available: true, detail: "Fixture signed in" })), busy: false,
  } }));
  studio.reply("GET", "/api/agent-lab/models", (route, url) => route.fulfill({ json: {
    provider: url.searchParams.get("provider"), source: "cli", models: [],
  } }));
});

async function openAgent(page: Page) {
  await tray(page).getByRole("tab", { name: /^Agent/ }).click();
  if (await toggle(page).getAttribute("aria-expanded") === "false") await toggle(page).click();
  await expect(agent(page)).toBeVisible();
}

async function openSightline(page: Page) {
  await openAgent(page);
  await tray(page).getByRole("tab", { name: "Sightline", exact: true }).click();
  await expect(sightline(page)).toBeVisible();
}

/** Capture through the public Copy JSON control, never a test-only application store. */
async function copied(page: Page): Promise<{ text: string; value: Sightline }> {
  await sightline(page).getByRole("button", { name: "Copy JSON", exact: true }).click();
  const text = await page.evaluate(() => (window as unknown as { __sightlineCopied: string }).__sightlineCopied);
  expect(typeof text).toBe("string");
  const value = JSON.parse(text) as Sightline;
  expect(value.schemaVersion).toBe(1);
  expect(text.length).toBeLessThanOrEqual(12_000);
  expect(value).toHaveProperty("location");
  expect(value).toHaveProperty("source");
  expect(value).toHaveProperty("deployments.dev");
  expect(value).toHaveProperty("deployments.prod");
  expect(value).toHaveProperty("activity");
  expect(value).toHaveProperty("omitted");
  return { text, value };
}

async function matches(page: Page, expected: Record<string, unknown>) {
  await expect.poll(async () => (await copied(page)).value).toMatchObject(expected);
}

async function evidence(page: Page, info: TestInfo, name: string, json: string) {
  const directory = path.resolve(__dirname, "../../../output/playwright/sightline/browser", info.project.name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${name}.json`), json);
  await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true });
  await info.attach(`${name}.json`, { body: json, contentType: "application/json" });
}

for (const width of [1440, 390]) test(`Sightline follows map selection, Source and history at ${width}px`, async ({ page, studio }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  await studio.goto();
  await openSightline(page);
  await matches(page, { location: { pathname: "/", workspace: "map" }, focus: null, source: { mode: "dev" } });

  await page.getByRole("searchbox", { name: "Search isometric map" }).fill("fixture-0");
  await matches(page, { workspace: { localView: { search: "fixture-0" } } });
  await page.getByRole("button", { name: "Clear map search", exact: true }).click();
  await page.getByRole("button", { name: "Resources", exact: true }).click();
  await page.locator('[data-resource-id="lambda:fixture-0"]').focus();
  await page.keyboard.press("Enter");
  await matches(page, { focus: { id: "lambda:fixture-0", kind: "target", status: "found" } });

  await page.getByRole("group", { name: "Source environment", exact: true }).getByRole("button", { name: "Production", exact: true }).click();
  await matches(page, { source: { mode: "prod" }, focus: { id: "lambda:fixture-0" } });
  const nav = page.getByRole("navigation", { name: "Views", exact: true });
  await nav.getByRole("link", { name: "Database", exact: true }).click();
  await matches(page, { location: { pathname: "/database", workspace: "database" }, workspace: { kind: "database" }, source: { mode: "prod" } });
  await nav.getByRole("link", { name: "GraphQL", exact: true }).click();
  await matches(page, { location: { pathname: "/graphql", workspace: "graphql" }, workspace: { kind: "graphql" } });
  await page.goBack();
  await matches(page, { location: { pathname: "/database", workspace: "database" } });
  await page.goBack();
  await matches(page, { location: { pathname: "/", workspace: "map" }, focus: { id: "lambda:fixture-0" } });
  await page.goForward();
  await matches(page, { location: { pathname: "/database", workspace: "database" } });

  const rootDisclosure = sightline(page).getByRole("button", { name: "Collapse JSON group", exact: true }).first();
  await rootDisclosure.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("group", { name: "Source environment", exact: true }).getByRole("button", { name: "Development", exact: true }).click();
  await matches(page, { source: { mode: "dev" } });
  const closedRoot = sightline(page).getByRole("button", { name: "Expand JSON group", exact: true }).first();
  await expect(closedRoot).toHaveAttribute("aria-expanded", "false");
  await closedRoot.focus();
  await page.keyboard.press("Enter");
  await expect(sightline(page).getByRole("button", { name: "Collapse JSON group", exact: true }).first()).toHaveAttribute("aria-expanded", "true");
  const expand = sightline(page).getByRole("button", { name: "Expand all", exact: true });
  await expand.focus();
  await page.keyboard.press("Enter");
  await expect(expand).toBeFocused();
  const collapse = sightline(page).getByRole("button", { name: "Collapse all", exact: true });
  await collapse.focus();
  await page.keyboard.press("Space");
  await expect(collapse).toBeFocused();
  await expand.click();
  // Check the debug view on a quiet workspace; Database's diagram has its own
  // presentation coverage and is not needed for Sightline's accessibility check.
  await nav.getByRole("link", { name: "GraphQL", exact: true }).click();
  await matches(page, { location: { pathname: "/graphql", workspace: "graphql" } });
  const captured = await copied(page);
  await expect(sightline(page).getByText(`${captured.text.length.toLocaleString("en-US")} characters`, { exact: true })).toBeVisible();
  await evidence(page, info, `sightline-${width}`, captured.text);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  const bounds = await sightline(page).getByRole("button", { name: "Copy JSON", exact: true }).boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(1000);
  await assertAccessible(page);
});

test("Sightline is available on every workspace and Cognito subsection", async ({ page, studio }, info) => {
  test.setTimeout(60_000);
  await studio.goto("/graphql");
  await openSightline(page);
  const nav = page.getByRole("navigation", { name: "Views", exact: true });
  const captures: Sightline[] = [];
  const destinations = [
    ["Map", "/", "map"], ["Database", "/database", "database"], ["Deploy", "/deploy", "deploy"],
    ["GraphQL", "/graphql", "graphql"], ["Cognito", "/cognito", "cognito"],
    ["Domains", "/domains", "domains"], ["WebSockets", "/websockets", "websockets"], ["Agent test", "/test", "test"],
  ] as const;
  for (const [label, pathname, kind] of destinations) {
    await nav.getByRole("link", { name: label, exact: true }).click();
    await matches(page, { location: { pathname, workspace: kind }, workspace: { kind } });
    captures.push((await copied(page)).value);
    if (kind === "graphql") expect(JSON.stringify(captures.at(-1)!.workspace)).toMatch(/placeholder/);
  }
  await nav.getByRole("link", { name: "Cognito", exact: true }).click();
  for (const [label, subsection] of [["User Pools", "user-pools"], ["Identity Pools", "identity-pools"], ["Providers", "providers"], ["Permissions & RBAC", "permissions"]] as const) {
    await page.getByRole("navigation", { name: "Cognito sections", exact: true }).getByRole("link", { name: label, exact: true }).click();
    await matches(page, { location: { pathname: `/cognito/${subsection}`, workspace: "cognito", subsection } });
    captures.push((await copied(page)).value);
  }
  await evidence(page, info, "workspace-sightlines", JSON.stringify(captures, null, 2));
  expect(studio.requests.filter(request => /\/(apply|execute|inspect|plan|save|chat)$/.test(request.path))).toEqual([]);
});

test("Sightline preserves conversation, draft and scroll and leaves the chat request unchanged", async ({ page, studio }) => {
  const answer = Array.from({ length: 35 }, (_, index) => `Paragraph ${index + 1}: source declarations and observed deployments have separate evidence.`).join("\n\n");
  studio.reply("POST", "/api/agent-lab/chat", route => route.fulfill({ json: { answer } }));
  await studio.goto("/graphql");
  await openAgent(page);
  await ask(page, "Explain the framework.");
  await expect(agent(page).getByRole("article", { name: "Codex answer", exact: true })).toContainText("Paragraph 35");
  await question(page).fill("An unfinished follow-up");
  const transcript = agent(page).locator('[data-ui="agent-panel"] [aria-label="Conversation"]');
  const original = await transcript.elementHandle();
  await transcript.evaluate(element => { element.scrollTop = 180; element.dispatchEvent(new Event("scroll")); });
  const scroll = await transcript.evaluate(element => element.scrollTop);
  expect(scroll).toBeGreaterThan(0);
  await tray(page).getByRole("tab", { name: "Sightline", exact: true }).click();
  await matches(page, { location: { workspace: "graphql" } });
  await page.getByRole("navigation", { name: "Views", exact: true }).getByRole("link", { name: "WebSockets", exact: true }).click();
  await matches(page, { location: { workspace: "websockets" } });
  await conversation(page).click();
  await expect(question(page)).toHaveValue("An unfinished follow-up");
  expect(await original!.evaluate(element => element.isConnected)).toBe(true);
  expect(await transcript.evaluate(element => element.scrollTop)).toBe(scroll);
  await expect(agent(page).getByRole("article", { name: "Codex answer", exact: true })).toContainText("Paragraph 35");
  await question(page).press("Enter");
  await expect.poll(() => studio.requests.filter(request => request.path === "/api/agent-lab/chat").length).toBe(2);
  const requests = studio.requests.filter(request => request.path === "/api/agent-lab/chat");
  expect(requests[0].body).toEqual({ provider: "codex", messages: [{ role: "user", content: "Explain the framework." }] });
  expect(requests[1].body).toEqual({ provider: "codex", messages: [
    { role: "user", content: "Explain the framework." }, { role: "assistant", content: answer }, { role: "user", content: "An unfinished follow-up" },
  ] });
});

test("a reply arriving while Sightline is visible stays unread until Conversation opens", async ({ page, studio }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  studio.reply("POST", "/api/agent-lab/chat", async route => {
    await pending;
    await route.fulfill({ json: { answer: "The hidden conversation has a reply." } });
  });
  await studio.goto("/graphql");
  await openAgent(page);
  await ask(page, "Explain this declaration.");
  await expect.poll(() => studio.requests.filter(request => request.path === "/api/agent-lab/chat").length).toBe(1);
  await tray(page).getByRole("tab", { name: "Sightline", exact: true }).click();
  await expect(sightline(page)).toBeVisible();
  release();
  await expect(tray(page).getByLabel("New reply", { exact: true })).toBeVisible();
  await conversation(page).click();
  await expect(agent(page).getByRole("article", { name: "Codex answer", exact: true })).toContainText("hidden conversation");
  await expect(tray(page).getByLabel("New reply", { exact: true })).toHaveCount(0);
});

test("opening Sightline adds no API reads or event streams compared with the closed view", async ({ page, studio }) => {
  await studio.goto("/graphql");
  await openAgent(page);
  await expect(agent(page).getByRole("combobox", { name: "Agent model", exact: true })).toBeEnabled();
  await expect.poll(() => studio.requests.filter(request => request.path.startsWith("/api/deploy/status?")).length).toBe(2);
  await expect.poll(() => studio.requests.filter(request => request.path.startsWith("/api/agent-lab/models?")).length).toBe(1);
  await studio.settle();
  const streams = () => page.evaluate(() => (window as unknown as { __studioBrowserEvents: { active(): number } }).__studioBrowserEvents.active());
  const closedStreams = await streams();
  const beforeClosed = studio.requests.length;
  await page.waitForTimeout(600);
  const closed = studio.requests.slice(beforeClosed).map(request => `${request.method} ${request.path}`);
  const beforeOpen = studio.requests.length;
  await tray(page).getByRole("tab", { name: "Sightline", exact: true }).click();
  await expect(sightline(page)).toBeVisible();
  await page.waitForTimeout(600);
  const opened = studio.requests.slice(beforeOpen).map(request => `${request.method} ${request.path}`);
  expect(opened).toEqual(closed);
  expect(opened).toEqual([]);
  expect(await streams()).toBe(closedStreams);
  expect(studio.sockets).toEqual([]);
  await toggle(page).click();
  await expect(sightline(page)).toHaveCount(0);
  await page.getByRole("navigation", { name: "Views", exact: true }).getByRole("link", { name: "Database", exact: true }).click();
  await expect(sightline(page)).toHaveCount(0);
  await toggle(page).click();
  await matches(page, { location: { workspace: "database" } });
});

test("Sightline updates from accepted drafts, source publications and cached operation evidence", async ({ page, studio }) => {
  const job: JobView = { id: "sightline-job", kind: "framework-check", title: "Private job title", params: { private: "SIGHTLINE_PRIVATE_OPERATION" }, status: "running", startedAt: NOW, lastSeq: 0, execution: "running", outcome: "pending" };
  studio.reply("GET", "/api/operations/sightline-job/log", route => route.fulfill({ json: { job, lines: [] } }));
  await studio.goto("/?select=lambda%3Afixture-0");
  await openSightline(page);
  await matches(page, { source: { draft: { dirty: false, conflicted: false } } });
  const description = page.getByRole("region", { name: "Node description", exact: true });
  await description.locator("summary").click();
  await description.getByRole("textbox", { name: "Description", exact: true }).fill("A local unsaved description.");
  await matches(page, { source: { draft: { dirty: true, conflicted: false } } });
  await studio.emit("status", { evaluating: true });
  await matches(page, { source: { evaluating: true } });
  Object.assign(studio.response.snapshot, { revision: "sightline-new-revision" });
  await studio.emit("snapshot", { revision: "sightline-new-revision", external: [] });
  await matches(page, { source: { revision: "browser-revision", latestRevision: "sightline-new-revision", draft: { dirty: true, conflicted: true } } });
  await studio.emit("status", { evaluating: false });
  await studio.emit("operation-job", job);
  await expect.poll(async () => (await copied(page)).value.activity).toMatchObject({ running: [expect.objectContaining({ id: job.id, status: "running" })] });
  const capture = await copied(page);
  expect(capture.text).not.toContain("SIGHTLINE_PRIVATE_OPERATION");
  expect(capture.text).not.toContain("Private job title");
  await studio.emit("operation-job", { ...job, status: "succeeded", execution: "finished", outcome: "confirmed", endedAt: NOW });
  await expect.poll(async () => (await copied(page)).value.activity).toMatchObject({ running: [], recent: [expect.objectContaining({ id: job.id, status: "succeeded" })] });
});

test("Sightline distinguishes missing profiles and live deployment cache evidence", async ({ context, page, studio }) => {
  await context.addInitScript(() => localStorage.setItem("aws-studio:mode-profiles:v1:/studio-fixture", JSON.stringify({})));
  await studio.goto("/deploy");
  await openSightline(page);
  await matches(page, { deployments: { dev: { availability: "missing-profile" }, prod: { availability: "missing-profile" } } });
  expect(studio.requests.filter(request => /\/api\/deploy\/(status|discover)/.test(request.path))).toEqual([]);
  await page.evaluate(() => {
    const key = "aws-studio:mode-profiles:v1:/studio-fixture", value = JSON.stringify({ dev: "browser", prod: "browser" });
    localStorage.setItem(key, value);
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: value, storageArea: localStorage }));
  });
  await matches(page, { deployments: { dev: { availability: "available", observed: { availability: "available" } }, prod: { availability: "available", observed: { availability: "available" } } } });
  studio.reply("GET", "/api/deploy/status", (route, url) => route.fulfill({ json: { ok: true, value: { ...discoveryFor(url), deployment: url.searchParams.get("deployment"), observedAt: "2026-10-28T12:01:00.000Z" } } }));
  Object.assign(studio.response.snapshot, { revision: "deployment-publication" });
  await studio.emit("snapshot", { revision: "deployment-publication", external: [] });
  await matches(page, { source: { revision: "deployment-publication" }, deployments: { dev: { observed: { observedAt: "2026-10-28T12:01:00.000Z" } } } });
  // Source publication and selected deployment are different contracts even on Deploy.
  const value = (await copied(page)).value;
  expect(value.source.mode).toBe("dev");
  expect(value.workspace.kind).toBe("deploy");
  expect(JSON.stringify(value.deployments)).not.toContain("123456789012");
});

test("Database publishes local choices and unsaved state without schema text or migration SQL", async ({ page, studio }) => {
  const hash = "a".repeat(64);
  const history: DatabaseHistory = {
    revision: "sightline-history", sourceHash: "db-browser", observedAt: NOW, heads: [hash], refs: [], issues: [], snapshots: [],
    migrations: [{ id: "app/create-note", space: "app", name: "20261028T1200_create_note", from: null, to: hash, createdAt: NOW,
      migrationHash: hash, integrity: "verified", operations: [], source: "SIGHTLINE_PRIVATE_MIGRATION_SQL",
      sourcePath: "migrations/app/create-note/migration.ts", sourceVerification: "not-executed", pendingPlaceholders: false, issues: [] }],
  };
  studio.reply("GET", "/api/database/history", route => route.fulfill({ json: history }));
  studio.reply("POST", "/api/database/history/compare", route => route.fulfill({ json: {
    from: "empty", to: hash, sourceHash: "db-browser", historyRevision: history.revision, fromStorageHash: null, toStorageHash: hash,
    storageChanged: true, executionChanged: false, domainChanged: true, changes: [], limitations: [], observedAt: NOW,
  } }));
  studio.reply("GET", "/api/database/workbench", route => route.fulfill({ json: {
    ...workbench(), targets: [{ id: "local:postgres", label: "Local PostgreSQL", available: true, identity: "sightline-local", detail: "SIGHTLINE_PRIVATE_DATABASE_DETAIL" }],
  } }));
  studio.reply("GET", "/api/database/application/operations", route => route.fulfill({ json: [] }));
  await studio.goto("/database");
  await openSightline(page);
  await matches(page, { workspace: { kind: "database", tab: "schema", editorMode: "split", draft: { dirty: false } } });
  await page.getByRole("button", { name: "Select table Note", exact: true }).click();
  await matches(page, { workspace: { selection: { table: "schema:public.Note" } } });
  await page.getByRole("button", { name: "Focus source", exact: true }).click();
  await matches(page, { workspace: { editorMode: "source" } });
  await page.getByRole("textbox", { name: "Prisma schema source", exact: true }).fill(`// SIGHTLINE_PRIVATE_UNSAVED_SCHEMA\n${workbench().source}`);
  await matches(page, { workspace: { draft: { dirty: true } } });
  await page.getByRole("button", { name: "History & migrations", exact: true }).click();
  await page.getByRole("navigation", { name: "Migration graph", exact: true }).getByRole("button").click();
  await matches(page, { workspace: { tab: "history", migration: { availability: "available", selectedId: "app/create-note" } } });
  await page.getByRole("button", { name: "Database status", exact: true }).click();
  await page.getByRole("combobox", { name: "Database target", exact: true }).selectOption("local:postgres");
  await matches(page, { workspace: { tab: "database", target: { id: "local:postgres" }, draft: { dirty: true } } });
  const capture = await copied(page);
  for (const marker of ["SIGHTLINE_PRIVATE_UNSAVED_SCHEMA", "SIGHTLINE_PRIVATE_DATABASE_DETAIL", "SIGHTLINE_PRIVATE_MIGRATION_SQL"]) expect(capture.text).not.toContain(marker);
  expect(studio.requests.filter(request => /\/(apply|inspect|save|plan)$/.test(request.path))).toEqual([]);
});

test("WebSocket connection state updates without URLs, tokens or messages", async ({ page, studio }) => {
  studio.reply("GET", "/api/websockets/defaults", route => route.fulfill({ json: {
    local: "ws://studio-fixture.invalid/local?token=SIGHTLINE_PRIVATE_SOCKET_TOKEN", apiGateway: "wss://studio-fixture.invalid/gateway?token=SIGHTLINE_PRIVATE_AWS_TOKEN",
  } }));
  await studio.goto("/websockets");
  await openSightline(page);
  await matches(page, { workspace: { panels: { local: { connection: "disconnected", configured: true, valid: true }, aws: { connection: "disconnected" } } } });
  const local = page.getByRole("region", { name: "Local", exact: true });
  await local.getByRole("button", { name: "Connect", exact: true }).click();
  await matches(page, { workspace: { panels: { local: { connection: "connected" }, aws: { connection: "disconnected" } } } });
  await local.getByRole("textbox", { name: "Send payload", exact: true }).fill('{"text":"SIGHTLINE_PRIVATE_SOCKET_PAYLOAD"}');
  await local.getByRole("button", { name: "Send payload to Local", exact: true }).click();
  await expect.poll(() => studio.sockets).toEqual(['{"text":"SIGHTLINE_PRIVATE_SOCKET_PAYLOAD"}']);
  await expect(local.getByRole("log").getByText("1 item", { exact: true })).toBeVisible();
  const capture = await copied(page);
  for (const marker of ["SIGHTLINE_PRIVATE_SOCKET_TOKEN", "SIGHTLINE_PRIVATE_AWS_TOKEN", "SIGHTLINE_PRIVATE_SOCKET_PAYLOAD", "studio-fixture.invalid"]) expect(capture.text).not.toContain(marker);
  await local.getByRole("button", { name: "Disconnect", exact: true }).click();
  await matches(page, { workspace: { panels: { local: { connection: "disconnected" } } } });
});
