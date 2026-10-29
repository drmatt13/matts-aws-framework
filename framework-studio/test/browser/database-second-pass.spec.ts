import type { Locator, Page } from "@playwright/test";
import type { DatabaseHistory, DatabaseMigrationReview, DatabaseSchemaComparison } from "../../shared/database-history";
import type { DatabaseObservation } from "../../shared/database-workbench";
import type { SqlCatalog, SqlExecutionReview, SqlSourceReview } from "../../shared/database-sql";
import type { DatabaseCloudDestination } from "../../shared/database-cloud";
import type { DatabaseApplicationReview } from "../../shared/database-application";
import type { DatabaseCloudApproval } from "../../shared/database-cloud";
import { test, expect } from "./support/test";
import { NOW, workbench } from "./support/scenarios";

const hash = "a".repeat(64), path = "packages/database/sql/inspection/inspect_application_records.sql";
const sql = "SELECT id, title FROM application_records_with_a_long_physical_name WHERE title = $1;";
const command = { name: "inspect_application_records", kind: "inspection", intent: "repeatable", description: "Inspect explicitly selected application rows without changing them.", parameters: ["title"], sql } as const;
const operation = { id: "create-records", label: "Create application_records_with_a_long_physical_name", operationClass: "additive", statements: [{ phase: "execute" as const, sql: "CREATE TABLE application_records_with_a_long_physical_name (id uuid PRIMARY KEY, title text NOT NULL);" }] };
const history: DatabaseHistory = { revision: "deep-history", sourceHash: "db-browser", observedAt: NOW, heads: [hash], refs: [], issues: [],
  migrations: [{ id: "app/create-records", space: "app", name: "20261028T1200_create_application_records_with_a_long_physical_name", from: null, to: hash, createdAt: NOW, migrationHash: hash, integrity: "verified", operations: [operation], source: operation.statements[0].sql, sourcePath: "migrations/app/create-records/migration.ts", sourceVerification: "not-executed", pendingPlaceholders: false, issues: [] }],
  snapshots: [{ hash, path: `snapshots/${hash}/contract.json`, available: true, provenance: "semantic-contract", contract: {}, issues: [] }] };
const comparison: DatabaseSchemaComparison = { from: "empty", to: hash, sourceHash: "db-browser", historyRevision: history.revision, fromStorageHash: null, toStorageHash: hash, storageChanged: true, executionChanged: false, domainChanged: true, changes: [{ kind: "added", plane: "storage", path: ["database", "namespaces", "public", "application_records_with_a_long_physical_name"], entity: "table", after: { name: "application_records_with_a_long_physical_name" } }], limitations: ["No database was contacted."], observedAt: NOW };
const migrationReview: DatabaseMigrationReview = { id: "deep-migration-review", sourceHash: "db-browser", historyRevision: history.revision, from: hash, to: "b".repeat(64), noOp: false, summary: "Review the proposed forward migration.", operations: [operation], artifacts: [{ path: "packages/database/prisma/migrations/app/create_application_records_with_a_long_physical_name/migration.ts", contents: operation.statements[0].sql, hash }], pendingPlaceholders: false, warnings: [], createdAt: NOW, expiresAt: "2099-01-01T00:00:00Z", effects: { source: "unchanged", migrations: "review-only", database: "not-contacted" } };
const target = { id: "local:postgres" as const, label: "Local PostgreSQL", available: true, identity: "deep-local-target", detail: "Fixture only. No connection is opened." };
const observation: DatabaseObservation = { id: "deep-observation", targetId: target.id, targetIdentity: target.identity, observedAt: NOW, savedRevision: "db-browser", historyRevision: history.revision, baseline: { label: "Saved authored source", storageHash: hash }, status: "observed", marker: { status: "matches", storageHash: hash }, physical: { status: "matches", issues: [], warnings: [] }, migrationState: { status: "current", message: "At saved storage contract." }, ledger: [{ migrationHash: hash, name: history.migrations[0].name, from: null, to: hash, appliedAt: NOW }], message: "Fixture physical schema matches the saved contract.", limits: ["Data correctness and backfill completion are separate evidence."] };
const destination: DatabaseCloudDestination = { id: "deep-destination", expiresAt: "2099-01-01T00:00:00Z", profile: "fixture", protocol: 1, binding: "fixture-only", identity: { deployment: "browser-production", account: "123456789012", region: "us-east-1", taskDefinitionArn: "arn:aws:ecs:us-east-1:123456789012:task-definition/browser-production-database-migration-task:1" }, effects: ["Starts a billed task only after a separate typed approval."], launch: { cluster: "arn:aws:ecs:us-east-1:123456789012:cluster/browser-production", containerName: "Main", launchType: "FARGATE", platformVersion: "LATEST", subnets: ["subnet-fixture"], securityGroups: ["sg-fixture"], assignPublicIp: false }, logs: { group: "browser-production-database-task", streamPrefix: "task" } };

async function bounded(page: Page, scope: Locator = page.locator("main")) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
  const bad = await scope.locator("input,select,textarea,button,h2,h3,summary").evaluateAll(elements => elements.filter(element => {
    const bounds = element.getBoundingClientRect();
    return bounds.width && bounds.height && element.checkVisibility() && !element.closest("nav,[aria-label='Database relationship diagram']") && (bounds.left < -1 || bounds.right > innerWidth + 1);
  }).map(element => ({ tag: element.tagName, name: element.getAttribute("aria-label") ?? element.textContent?.slice(0, 100) })));
  expect(bad, "Visible controls and headings stay inside the viewport").toEqual([]);
}

for (const width of [320, 1440]) {
  test(`database local and production SQL approvals stay bounded at ${width}px`, async ({ page, studio }, info) => {
    await page.setViewportSize({ width, height: 900 });
    let initializing = false;
    const initialization = { operations: [{ id: operation.id, label: operation.label, operationClass: "additive" }], sql: [operation.statements[0].sql], controlSql: [{ sql: "CREATE SCHEMA prisma_control;" }] };
    const application: DatabaseApplicationReview = { id: "deep-application", targetId: target.id, targetLabel: target.label, targetIdentity: target.identity, sourceHash: "db-browser", historyRevision: history.revision, from: "b".repeat(64), to: hash, createdAt: NOW, expiresAt: "2099-01-01T00:00:00Z", confirmation: "Apply reviewed migration to Local PostgreSQL", effects: ["Changes the selected fixture database only after explicit approval."], migrations: [{ ...history.migrations[0], from: "b".repeat(64), source: operation.statements[0].sql }] };
    const cloudApproval: DatabaseCloudApproval = { id: "deep-cloud-review", profile: "fixture", expiresAt: "2099-01-01T00:00:00Z", confirmation: "Apply browser-production", destination, review: { version: 1, identity: destination.identity, inputsDigest: hash, markerHash: "b".repeat(64), markerIdentity: hash, ledgerIdentity: hash, storageHash: hash, helpers: [{ file: "migration_helpers/application_records.ts", source: "// Read as text; never executed by this browser test." }], migrations: [{ spaceId: "app", dirName: history.migrations[0].name, migrationHash: hash, from: "b".repeat(64), to: hash, source: operation.statements[0].sql, sql: operation.statements }], digest: hash } };
    studio.reply("GET", "/api/database/workbench", async route => { await route.fulfill({ json: { ...workbench(), targets: [target, { id: "production", label: "Production RDS", available: false, identity: "deep-production", detail: "Fixture only.", handoffs: [{ deployment: "browser-production", command: "fixture", detail: "Fixture only." }] }] } }); });
    studio.reply("GET", "/api/database/history", async route => { await route.fulfill({ json: history }); });
    studio.reply("GET", "/api/database/application/operations", async route => { await route.fulfill({ json: [] }); });
    studio.reply("POST", "/api/database/workbench/inspect", async route => { await route.fulfill({ json: { ...observation, marker: { status: initializing ? "missing" : "differs" }, migrationState: { status: initializing ? "unknown" : "pending", message: "Fixture evidence." } } }); });
    studio.reply("POST", "/api/database/application/review", async route => { await route.fulfill({ json: initializing ? { ...application, kind: "initialize", initialization, migrations: [] } : application }); });
    studio.reply("POST", "/api/database/cloud/prepare", async route => { await route.fulfill({ json: destination }); });
    studio.reply("POST", "/api/database/cloud/review", async route => { await route.fulfill({ json: initializing ? { ...cloudApproval, review: { ...cloudApproval.review, kind: "initialize", initialization, migrations: [] } } : cloudApproval }); });
    const capture = async (name: string) => {
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await bounded(page, dialog);
      const body = dialog.locator('[data-ui=body]');
      expect(await body.evaluate(element => element.scrollWidth <= element.clientWidth + 1), "Dialog body does not scroll sideways").toBe(true);
      await page.screenshot({ path: info.outputPath(`${name}-${width}.png`), fullPage: true });
      await dialog.getByRole("textbox").fill("Wrong approval");
      await expect(dialog.getByRole("button").last()).toBeDisabled();
      await page.keyboard.press("Escape");
    };
    await studio.goto("/database");
    await page.getByRole("button", { name: "Database status", exact: true }).click();
    await page.getByRole("combobox", { name: "Database target", exact: true }).selectOption("local:postgres");
    await page.getByRole("button", { name: "Inspect database", exact: true }).click();
    await page.getByRole("button", { name: "Review database application", exact: true }).click();
    await capture("local-migration-approval");
    initializing = true;
    await page.getByRole("button", { name: "Inspect database", exact: true }).click();
    await page.getByRole("button", { name: "Review empty database initialization", exact: true }).click();
    await capture("local-initialization-approval");
    await page.getByRole("combobox", { name: "Database target", exact: true }).selectOption("production");
    await page.getByRole("combobox", { name: "Production database deployment" }).selectOption("browser-production");
    for (const mode of ["migration", "initialization"]) {
      initializing = mode === "initialization";
      await page.getByRole("button", { name: "Check database task destination" }).click();
      await page.getByRole("textbox", { name: "Confirm production database action" }).fill("Inspect browser-production");
      await page.getByRole("button", { name: "Start billed read-only task" }).click();
      await expect(page.getByRole("dialog")).toHaveAccessibleName(initializing ? "Review empty production database initialization" : "Review production SQL and authorize application");
      await expect.poll(() => page.getByRole("dialog").locator('[data-ui=body]').evaluate(element => element.scrollTop)).toBe(0);
      await capture(`production-${mode}-approval`);
    }
    expect(studio.requests.filter(request => /\/(save|install|execute|apply)$/.test(request.path))).toEqual([]);
  });
}

for (const width of [320, 768, 1440]) {
  test(`database deep views and review dialogs remain usable at ${width}px`, async ({ page, studio }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    studio.reply("GET", "/api/database/workbench", async route => { await route.fulfill({ json: { ...workbench(), targets: [target, { id: "production", label: "Production RDS", available: false, identity: "deep-production", detail: "Private IAM/TLS task required.", handoffs: [{ deployment: "browser-production", command: "fixture", detail: "Fixture only.", account: "123456789012", region: "us-east-1" }] }] } }); });
    studio.reply("GET", "/api/database/history", async route => { await route.fulfill({ json: history }); });
    studio.reply("POST", "/api/database/history/compare", async route => { await route.fulfill({ json: comparison }); });
    studio.reply("POST", "/api/database/history/plan", async route => { await route.fulfill({ json: migrationReview }); });
    studio.reply("POST", "/api/database/history/discard", async route => { await route.fulfill({ json: { discarded: true } }); });
    studio.reply("GET", "/api/database/application/operations", async route => { await route.fulfill({ json: [] }); });
    studio.reply("POST", "/api/database/workbench/inspect", async route => { await route.fulfill({ json: observation }); });
    studio.reply("POST", "/api/database/cloud/prepare", async route => { await route.fulfill({ json: destination }); });
    const catalog: SqlCatalog = { directory: "packages/database/sql", commands: [{ path, revision: hash, command }], issues: [], history: [], targets: [target] };
    studio.reply("GET", "/api/database/sql", async route => { await route.fulfill({ json: catalog }); });
    const sourceReview: SqlSourceReview = { id: "deep-sql-source", path, before: sql, after: `${sql}\n-- reviewed fixture`, command, expiresAt: "2099-01-01T00:00:00Z" };
    studio.reply("POST", "/api/database/sql/review", async route => { await route.fulfill({ json: sourceReview }); });
    const executionReview: SqlExecutionReview = { id: "deep-sql-execution", path, revision: hash, command, targetId: target.id, targetLabel: target.label, targetIdentity: target.identity, parameters: ["Fixture value"], confirmation: "Run inspect_application_records on Local PostgreSQL", expiresAt: "2099-01-01T00:00:00Z", effects: ["Read-only fixture statement."] };
    studio.reply("POST", "/api/database/sql/execute-review", async route => { await route.fulfill({ json: executionReview }); });
    const capture = async (name: string) => {
      await studio.settle(); await bounded(page);
      const dialog = page.getByRole("dialog");
      if (await dialog.count()) {
        expect(await dialog.locator('[data-ui=body]').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        if (width <= 420) {
          const footer = dialog.locator("footer"), primary = footer.locator('[data-variant=primary]');
          if (await primary.count()) {
            const available = await footer.evaluate(element => element.clientWidth - parseFloat(getComputedStyle(element).paddingLeft) - parseFloat(getComputedStyle(element).paddingRight));
            expect((await primary.boundingBox())!.width).toBeCloseTo(available, 0);
          }
        }
      }
      await page.screenshot({ path: info.outputPath(`${name}-${width}.png`), fullPage: true });
    };
    await studio.goto("/database");
    await capture("schema");
    await page.getByRole("textbox", { name: "Prisma schema source" }).click();
    await page.keyboard.press("ControlOrMeta+f");
    await expect(page.getByRole("textbox", { name: "Find", exact: true })).toBeVisible();
    await capture("editor-search");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "History & migrations", exact: true }).click();
    await page.getByRole("navigation", { name: "Migration graph" }).getByRole("button").click();
    await page.getByText("Migration source", { exact: true }).click();
    await capture("history-expanded");
    await page.getByRole("button", { name: "Plan migration", exact: true }).click();
    let dialog = page.getByRole("dialog");
    await expect(dialog).toHaveAccessibleName("Plan a forward migration");
    await capture("migration-plan");
    await dialog.getByRole("textbox", { name: "Migration name" }).fill("add_application_records");
    await dialog.getByRole("combobox", { name: "Migration baseline" }).selectOption(hash);
    await dialog.getByRole("button", { name: "Create migration review" }).click();
    await expect(dialog).toHaveAccessibleName("Review migration artifacts");
    await capture("migration-review");
    await dialog.getByRole("button", { name: "Back to history" }).click();
    await page.getByRole("button", { name: "Database status", exact: true }).click();
    await page.getByRole("combobox", { name: "Database target", exact: true }).selectOption("local:postgres");
    await page.getByRole("button", { name: "Inspect database", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: observation.message })).toBeVisible();
    await capture("database-evidence");
    await page.getByRole("combobox", { name: "Database target", exact: true }).selectOption("production");
    await page.getByRole("combobox", { name: "Production database deployment" }).selectOption("browser-production");
    await page.getByRole("button", { name: "Check database task destination" }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog).toHaveAccessibleName("Authorize billed read-only database inspection");
    await capture("production-destination");
    await expect(dialog.getByRole("button", { name: "Start billed read-only task" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Saved SQL", exact: true }).click();
    await page.getByRole("combobox", { name: "Saved SQL command" }).selectOption(path);
    await capture("saved-sql");
    await page.getByRole("button", { name: "Review execution", exact: true }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog).toHaveAccessibleName("Approve SQL execution");
    await capture("sql-execution-review");
    await expect(dialog.getByRole("button", { name: "Execute reviewed SQL" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.getByRole("textbox", { name: "SQL description" }).fill("Changed fixture description");
    await page.getByRole("button", { name: "Review SQL source", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveAccessibleName("Review saved SQL source");
    await capture("sql-source-review");
    await page.keyboard.press("Escape");
    expect(studio.requests.filter(request => /\/(save|install|execute|apply)$/.test(request.path))).toEqual([]);
  });
}
