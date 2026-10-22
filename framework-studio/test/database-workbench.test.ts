import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { DatabaseWorkbenchService, compileDatabaseSource, databaseConfigurationRevision, databasePrismaConfig } from "../server/database-workbench";
import type { DatabaseHistory } from "../shared/database-history";
import { CONTRACT_FILE } from "../server/database";
import { sha256 } from "../server/files";
import { ok } from "@prisma/orm-framework/utils/result";

const repository = path.resolve(__dirname, "../..");
const roots: string[] = [];
const source = `// use prisma-8
// Keep this authored comment.
model Entry {
  id Uuid @id(map: "entry_pk")
  title String @map("entry_title") // preserve the physical name
  updatedAt temporal.timestamptzString(6, onCreate: now, onUpdate: now)
  @@map("entries")
}
`;

function fixture(text = source): { root: string; file: string; service: DatabaseWorkbenchService } {
  const root = mkdtempSync(path.join(repository, ".cache/framework-studio/workbench-test-"));
  roots.push(root);
  mkdirSync(path.join(root, "packages/database/prisma"), { recursive: true });
  writeFileSync(path.join(root, "packages/database/prisma.config.ts"), `import { definePrismaConfig } from "@prisma/cli-engine";
import { defineConfig } from "@prisma/orm-postgres/config";
export default definePrismaConfig({orm: defineConfig({contract:"prisma/contract.prisma",output:"src/generated",migrations:{dir:"prisma/migrations"}})});
`);
  const file = path.join(root, CONTRACT_FILE);
  writeFileSync(file, text);
  return { root, file, service: new DatabaseWorkbenchService(root) };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("real installed Prisma validates dialect semantics with exact UTF-16 source ranges without emitting", async () => {
  const { root, file, service } = fixture();
  const loaded = await service.load();
  assert.equal(loaded.validation.valid, true);
  assert.equal(loaded.validation.schema?.tables[0]?.columns[1]?.column, "entry_title");
  const bad = source.replace("title String", "title UnknownType");
  const invalid = await service.validate(bad);
  assert.equal(invalid.valid, false);
  const finding = invalid.diagnostics.find(item => item.code === "PSL_UNRESOLVED_REFERENCE")!;
  assert.equal(bad.slice(finding.from, finding.to), "UnknownType");
  assert.equal(invalid.schema, undefined, "invalid drafts cannot silently publish partial diagrams");
  assert.equal(readFileSync(file, "utf8"), source);
  assert.deepEqual(readdirSync(path.join(root, "packages/database")), ["prisma", "prisma.config.ts"]);
});

test("canonical storage hashes distinguish optional storage changes from mapped logical renames", async () => {
  const { root } = fixture();
  const original = await compileDatabaseSource(root, source);
  const renamed = await compileDatabaseSource(root, source.replace("title String", "label String"));
  const optional = await compileDatabaseSource(root, source.replace("title String", "title String?"));
  assert.equal(renamed.validation.storageHash, original.validation.storageHash);
  assert.notEqual(optional.validation.storageHash, original.validation.storageHash);
  assert.equal(renamed.validation.schema?.tables[0]?.columns[1]?.name, "label");
  assert.equal(renamed.validation.schema?.tables[0]?.columns[1]?.column, "entry_title");
});

test("formatting uses installed formatter and retains comments, mappings, parameterized types and annotations", async () => {
  const { service, file } = fixture();
  const formatted = await service.format(source);
  assert.ok(formatted.source.includes("Keep this authored comment."));
  assert.ok(formatted.source.includes("preserve the physical name"));
  assert.ok(formatted.source.includes('@map("entry_title")'));
  assert.ok(formatted.source.includes("temporal.timestamptzString(6, onCreate: now, onUpdate: now)"));
  assert.equal(formatted.sourceHash, sha256(source));
  assert.equal(readFileSync(file, "utf8"), source, "format is a draft operation");
  await assert.rejects(service.format(source + "model Broken {"), /diagnostics/);
});

test("review performs no writes and save consumes a single exact-source review", async () => {
  const { service, file } = fixture();
  const draft = source.replace("title String", "title String?");
  const review = await service.review(draft, sha256(source));
  assert.equal(review.before, source);
  assert.equal(review.after, draft);
  assert.equal(readFileSync(file, "utf8"), source);
  await assert.rejects(service.save("unknown"), /expired/);
  const saved = await service.save(review.reviewId);
  assert.equal(saved.saved, true);
  assert.equal(saved.revision, sha256(draft));
  assert.equal(readFileSync(file, "utf8"), draft);
  await assert.rejects(service.save(review.reviewId), /expired/);
  // Returning to an older source is a new reviewed save, never a database rollback.
  const restoreReview = await service.review(source, saved.revision);
  await service.save(restoreReview.reviewId);
  assert.equal(readFileSync(file, "utf8"), source);
});

test("external changes and config changes preserve external source and refuse stale review", async () => {
  const { root, service, file } = fixture();
  const draft = source.replace("title String", "title String?");
  const review = await service.review(draft, sha256(source));
  const external = source + "\n// External editor changed this file.\n";
  writeFileSync(file, external);
  await assert.rejects(service.save(review.reviewId), /changed after review/);
  assert.equal(readFileSync(file, "utf8"), external);
  await assert.rejects(service.review(draft, sha256(source)), /outside this draft/);
  const fresh = await service.review(draft, sha256(external));
  const config = path.join(root, "packages/database/prisma.config.ts");
  writeFileSync(config, readFileSync(config, "utf8") + "\n// Config changed.\n");
  await assert.rejects(service.save(fresh.reviewId), /configuration changed/);
  assert.equal(readFileSync(file, "utf8"), external);
});

test("invalid drafts and symlinked contracts cannot be saved", async () => {
  const { service, file } = fixture();
  await assert.rejects(service.review(source + "model Bad {", sha256(source)), /diagnostics/);
  assert.equal(readFileSync(file, "utf8"), source);
  const real = file + ".real";
  writeFileSync(real, source);
  rmSync(file); symlinkSync(real, file);
  await assert.rejects(service.review(source.replace("title String", "title String?"), sha256(source)), /symbolic link/);
  assert.equal(readFileSync(real, "utf8"), source);
});

test("source save success remains explicit when framework graph refresh fails", async () => {
  const { root, file } = fixture();
  const service = new DatabaseWorkbenchService(root, async () => { throw new Error("Snapshot unavailable"); });
  const draft = source.replace("title String", "title String?");
  const review = await service.review(draft, sha256(source));
  const result = await service.save(review.reviewId);
  assert.equal(result.saved, true);
  assert.equal(result.refresh, "unavailable");
  assert.match(result.message, /schema saved/);
  assert.equal(readFileSync(file, "utf8"), draft);
});

test("unsupported targets remain unknown and never inherit a configured remote DATABASE_URL", async () => {
  const { root, service } = fixture();
  writeFileSync(path.join(root, "docker-compose.yml"), `services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: private-user
      POSTGRES_PASSWORD: never-expose-this
      POSTGRES_DB: fixture
    ports: ['127.0.0.1:\${POSTGRES_HOST_PORT}:5432']
`);
  const production = await service.inspect("production", sha256(source));
  assert.equal(production.status, "unsupported");
  assert.equal(production.physical.status, "unknown");
  assert.equal(production.marker.status, "unknown");
  assert.ok(!JSON.stringify(await service.load()).includes("never-expose-this"));
  await assert.rejects(service.inspect("arbitrary-url", sha256(source)), /Choose a database target/);
  await assert.rejects(service.inspect("production", "stale"), /Saved source changed/);
});

function composeFixture(root: string): void {
  writeFileSync(path.join(root, ".env"), "POSTGRES_HOST_PORT=5432\n");
  writeFileSync(path.join(root, "docker-compose.yml"), `services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: fixture-user
      POSTGRES_PASSWORD: fixture-password-never-output
      POSTGRES_DB: fixture
    ports: ['127.0.0.1:\${POSTGRES_HOST_PORT}:5432']
`);
}

test("pending migrations, physical drift and unexplained state stay distinct using canonical historical contracts", async () => {
  const { root, file } = fixture(); composeFixture(root);
  const before = await compileDatabaseSource(root, source);
  const changed = source.replace("title String", "title String?"); writeFileSync(file, changed);
  const after = await compileDatabaseSource(root, changed);
  const from = before.validation.storageHash!, to = after.validation.storageHash!;
  const history: DatabaseHistory = { revision: "history-fixture", sourceHash: sha256(changed), heads: [to], refs: [], observedAt: new Date().toISOString(), issues: [],
    snapshots: [{ hash: from, path: "fixture-contract.json", available: true, provenance: "semantic-contract", contract: before.config.target.contractSerializer.serializeContract(before.contract!), issues: [] }],
    migrations: [{ id: "fixture-migration", name: "optional-title", space: "app", from, to, migrationHash: "fixture-edge", integrity: "verified", operations: [], source: "reviewed source", sourcePath: "fixture/migration.ts", sourceVerification: "not-executed", pendingPlaceholders: false, issues: [], createdAt: new Date().toISOString() }] };
  let markerHash: string | null = from;
  let savedMatches = false, historicalMatches = true;
  const requests: string[] = [];
  const service = new DatabaseWorkbenchService(root, undefined, (connection) => {
    assert.ok(!connection.includes("remote"));
    assert.match(new URL(connection).searchParams.get("options")!, /default_transaction_read_only=on/);
    return {
      async connect() {}, async close() {}, async readLedger() { return []; },
      async readMarker() { return markerHash ? { storageHash: markerHash, profileHash: "test", contractJson: null, canonicalVersion: null, updatedAt: new Date(), appTag: null, meta: {}, invariants: [] } : null; },
      async schemaVerify(options) {
        const hash = (options.contract as typeof after.contract)!.storage.storageHash; requests.push(hash);
        const matches = hash === to ? savedMatches : historicalMatches;
        return { ok: matches, summary: "fixture", contract: { storageHash: hash }, target: { expected: "postgres" }, schema: { issues: matches ? [] : [{ path: ["public", "entries", "entry_title"], explanation: "Fixture column difference" }] }, timings: { total: 0 } };
      },
    };
  });
  const pending = await service.inspect("local:postgres", sha256(changed), history.revision, history);
  assert.equal(pending.status, "observed");
  assert.equal(pending.physical.status, "differs");
  assert.equal(pending.historicalPhysical?.status, "matches");
  assert.equal(pending.migrationState.status, "pending");
  assert.deepEqual(requests, [to, from], "saved and known historical physical baselines both verified");
  historicalMatches = false;
  assert.equal((await service.inspect("local:postgres", sha256(changed), history.revision, history)).migrationState.status, "divergent");
  markerHash = "outside-known-history";
  const unknown = await service.inspect("local:postgres", sha256(changed), history.revision, history);
  assert.equal(unknown.migrationState.status, "unknown");
  assert.equal(unknown.historicalPhysical, undefined);
  markerHash = null; savedMatches = true;
  assert.equal((await service.inspect("local:postgres", sha256(changed), history.revision, history)).migrationState.status, "unknown");
  markerHash = to;
  assert.equal((await service.inspect("local:postgres", sha256(changed), history.revision, history)).migrationState.status, "current");
  savedMatches = false;
  assert.equal((await service.inspect("local:postgres", sha256(changed), history.revision, history)).migrationState.status, "divergent");
});

test("unreachable observations remain unknown, redact private failures and invalidate changed target identity", async () => {
  const { root } = fixture(); composeFixture(root);
  const unreachable = new DatabaseWorkbenchService(root, undefined, () => ({ async connect() { throw new Error("fixture-password-never-output postgresql://secret@host"); }, async close() {}, async readMarker() { return null; }, async readLedger() { return []; }, async schemaVerify() { throw new Error("unreachable"); } }));
  const result = await unreachable.inspect("local:postgres", sha256(source));
  assert.equal(result.status, "unreachable");
  assert.equal(result.physical.status, "unknown");
  assert.equal(result.migrationState.status, "unknown");
  assert.ok(!JSON.stringify(result).includes("fixture-password-never-output"));
  assert.ok(!JSON.stringify(result).includes("postgresql://"));
  const compiled = await compileDatabaseSource(root, source);
  const stale = new DatabaseWorkbenchService(root, undefined, () => ({
    async connect() {}, async close() {}, async readMarker() { return null; }, async readLedger() { return []; },
    async schemaVerify() {
      const compose = path.join(root, "docker-compose.yml"); writeFileSync(compose, readFileSync(compose, "utf8").replace("fixture-password-never-output", "rotated-password"));
      return { ok: true, summary: "fixture", contract: { storageHash: compiled.validation.storageHash! }, target: { expected: "postgres" }, schema: { issues: [] }, timings: { total: 0 } };
    },
  }));
  assert.equal((await stale.inspect("local:postgres", sha256(source))).status, "stale");
});

test("aborted validation publishes no result and does not write source", async () => {
  const { service, file } = fixture();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.validate(source, controller.signal), error => error instanceof Error && error.name === "AbortError");
  assert.equal(readFileSync(file, "utf8"), source);
});

test("transitive config edits invalidate public identity, canonical configuration and reviewed source", async () => {
  const { root, service } = fixture();
  const config = path.join(root, "packages/database/prisma.config.ts");
  const settings = path.join(root, "packages/database/studio-format.ts");
  writeFileSync(settings, "export const indent = 2;\n");
  writeFileSync(config, `import { definePrismaConfig } from "@prisma/cli-engine";
import { defineConfig } from "@prisma/orm-postgres/config";
import { indent } from "./studio-format.js";
export default definePrismaConfig({orm:{...defineConfig({contract:"prisma/contract.prisma",output:"src/generated",migrations:{dir:"prisma/migrations"}}),formatter:{indent}}});
`);
  const firstIdentity = databaseConfigurationRevision(root);
  // Formatter is part of the canonical config; the façade stores it through the ORM config.
  const first = await service.load();
  assert.equal((await databasePrismaConfig(root)).formatter?.indent, 2);
  const review = await service.review(source.replace("title String", "title String?"), sha256(source));
  writeFileSync(settings, "export const indent = 4;\n");
  assert.notEqual(databaseConfigurationRevision(root), firstIdentity);
  const second = await service.load();
  assert.equal((await databasePrismaConfig(root)).formatter?.indent, 4);
  assert.notEqual(second.configRevision, first.configRevision);
  await assert.rejects(service.save(review.reviewId), /configuration changed/);
});

test("emitted artifact evidence verifies real canonical hashes and distinguishes saved storage from execution changes", async () => {
  const { root, service, file } = fixture();
  assert.equal((await service.load()).emitted?.status, "missing");
  const compiled = await compileDatabaseSource(root, source);
  const { createControlClient } = await import("@prisma/orm-toolchain/cli/control-api");
  const client = createControlClient(compiled.config);
  const emitted = await client.emit({ contractConfig: { output: path.join(root, "packages/database/src/generated/contract.json"), source: { format: "psl", async load() { return ok(compiled.contract!); } } } });
  await client.close();
  assert.ok(emitted.ok);
  mkdirSync(path.join(root, "packages/database/src/generated"), { recursive: true });
  const output = path.join(root, "packages/database/src/generated/contract.json");
  writeFileSync(output, emitted.value.contractJson);
  assert.equal((await service.load()).emitted?.status, "matches");
  writeFileSync(file, source.replace("onCreate: now, onUpdate: now", "onCreate: now"));
  const behavior = (await service.load()).emitted!;
  assert.equal(behavior.status, "differs");
  assert.equal(behavior.storageMatches, true);
  assert.equal(behavior.executionMatches, false);
  writeFileSync(file, source.replace("title String", "title String?"));
  assert.equal((await service.load()).emitted?.storageMatches, false);
  assert.equal(readFileSync(output, "utf8"), emitted.value.contractJson, "read evidence never generates or rewrites artifacts");
  const malformed = JSON.parse(emitted.value.contractJson); malformed.execution.executionHash = "not-a-valid-hash";
  writeFileSync(output, JSON.stringify(malformed));
  assert.equal((await service.load()).emitted?.status, "invalid", "emitted bytes are freshly checked even when compiled source was cached");
});

test("valid native CHECK constraints remain valid with an explicit source-backed diagram capability note", async () => {
  const annotated = source.replace('  @@map("entries")', '  @@check(expression: "length(entry_title) > 0", name: "entry_title_present")\n  @@map("entries")');
  const { root } = fixture(annotated);
  const result = await compileDatabaseSource(root, annotated);
  assert.equal(result.validation.valid, true);
  assert.ok(result.validation.schema?.problems.some(item => item.includes("@@check") && item.includes("preserved in source")));
});

test("a PostgreSQL Compose override is unsupported rather than silently observing the base target", async () => {
  const { root, service } = fixture(); composeFixture(root);
  writeFileSync(path.join(root, "docker-compose.override.yml"), "services:\n  postgres:\n    ports: ['127.0.0.1:6543:5432']\n");
  const target = (await service.load()).targets.find(item => item.id === "local:postgres")!;
  assert.equal(target.available, false);
  assert.match(target.detail, /overrides postgres/);
  const observation = await service.inspect("local:postgres", sha256(source));
  assert.equal(observation.status, "unsupported");
  assert.equal(observation.physical.status, "unknown");
});

test("a root dotenv port edit changes target identity after the Prisma config has injected its old port", { skip: process.env.POSTGRES_HOST_PORT !== undefined }, async () => {
  const { root, service } = fixture(); composeFixture(root);
  const config = path.join(root, "packages/database/prisma.config.ts");
  writeFileSync(config, `import { config as loadDotEnv } from "dotenv";\nloadDotEnv({path:new URL("../../.env",import.meta.url),quiet:true});\n` + readFileSync(config, "utf8"));
  writeFileSync(path.join(root, ".env"), "POSTGRES_HOST_PORT=65431\n");
  const first = (await service.load()).targets.find(item => item.id === "local:postgres")!;
  assert.match(first.detail, /65431/);
  assert.equal(process.env.POSTGRES_HOST_PORT, "65431", "the authored config has injected its original dotenv value");
  writeFileSync(path.join(root, ".env"), "POSTGRES_HOST_PORT=65432\n");
  const second = (await service.load()).targets.find(item => item.id === "local:postgres")!;
  assert.match(second.detail, /65432/);
  assert.notEqual(second.identity, first.identity);
  assert.equal(process.env.POSTGRES_HOST_PORT, "65431", "the test does not clear or rewrite the stale injected process value");
});
