import assert from "./support/assert";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, before, test } from "node:test";
import { createControlStack, hasMigrations, hasOperationPreview } from "@prisma/orm-framework/components/control";
import type { PrismaNextConfig } from "@prisma/orm-framework/config/config-types";
import { ok } from "@prisma/orm-framework/utils/result";
import { databaseInputsDigest, decodeDatabaseEnvelope, digest, encodeDatabaseEnvelope, guardCloudDatabasePath, readDatabaseCloudRequest, reviewCloudDatabase, type DatabaseCloudEnvelope, type DatabaseCloudIdentity, type DatabaseCloudRequest, type DatabaseCloudReview } from "../../packages/database/scripts/studio-migrations";
import { executeReviewedDatabaseTask } from "../../cdk-app/ecs_containers/tasks/db-migrate/review-task";
import { compileDatabaseSource } from "../server/database-workbench";
import { DatabaseCloudService } from "../server/database-cloud";
import { DatabaseOperationStore } from "../server/database-operations";
import type { Runner } from "../server/deploy/process";
import { DATABASE_EMPTY_SQL } from "../../packages/database/scripts/empty-database";

const repo = path.resolve(__dirname, "../..");
let createFixtureControlClient: typeof import("@prisma/orm-toolchain/cli/control-api/testing").createFixtureControlClient;
let defaultControlClientFixtures: typeof import("@prisma/orm-toolchain/cli/control-api/testing").defaultControlClientFixtures;
before(async () => { ({ createFixtureControlClient, defaultControlClientFixtures } = await import("@prisma/orm-toolchain/cli/control-api/testing")); });
const fixtures: string[] = [];
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { force: true, recursive: true }); });
const identity: DatabaseCloudIdentity = { deployment: "production", account: "123456789012", region: "us-east-1", taskDefinitionArn: "arn:aws:ecs:us-east-1:123456789012:task-definition/production-db-migrate:7" };
function fixture() {
  const root = mkdtempSync(path.join(repo, ".cache/framework-studio/cloud-db-test-")); fixtures.push(root);
  mkdirSync(path.join(root, "packages/database"), { recursive: true });
  mkdirSync(path.join(root, "cdk-app"));
  cpSync(path.join(repo, "packages/database/prisma"), path.join(root, "packages/database/prisma"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), "{}"); writeFileSync(path.join(root, "package-lock.json"), "{}"); writeFileSync(path.join(root, "packages/database/package.json"), "{}");
  writeFileSync(path.join(root, "packages/database/prisma.config.ts"), `import { definePrismaConfig } from "@prisma/cli-engine"; import { defineConfig } from "@prisma/orm-postgres/config"; export default definePrismaConfig({ orm: defineConfig({ contract: "prisma/contract.prisma", output: "src/generated", migrations: {dir: "prisma/migrations"} }) });`);
  writeFileSync(path.join(root, "cdk-app/cdk.json"), JSON.stringify({ context: { "framework:targets": { production: { mode: "prod", account: identity.account, region: identity.region, inputs: "cdk-app/.env.prod" } } } }));
  return root;
}
function request(root: string, mode: "review" | "apply" = "review"): DatabaseCloudRequest { return { version: 1, requestId: "12345678-1234-1234-1234-123456789012", mode, identity, inputsDigest: databaseInputsDigest(root) }; }
function reviewValue(root: string): DatabaseCloudReview {
  const value = { version: 1 as const, identity, inputsDigest: databaseInputsDigest(root), markerHash: "a".repeat(64), markerIdentity: digest([]), ledgerIdentity: digest([]), storageHash: "b".repeat(64), helpers: [], migrations: [] };
  return { ...value, digest: digest(value) };
}

test("correlated chunked protocol refuses incomplete, changed, unsafe and other-request output", () => {
  const root = fixture(); const envelope: DatabaseCloudEnvelope = { version: 1, requestId: request(root).requestId, status: "reviewed", review: { ...reviewValue(root), migrations: [] } };
  const encoded = encodeDatabaseEnvelope(envelope);
  assert.deepEqual(decodeDatabaseEnvelope(["private driver message ignored", ...encoded], envelope.requestId), envelope);
  assert.throws(() => decodeDatabaseEnvelope(encoded, "other-request"), /INCOMPLETE/);
  const long = encodeDatabaseEnvelope({ ...envelope, review: { ...envelope.review!, migrations: [{ spaceId: "app", dirName: "next", migrationHash: "c".repeat(64), from: "a", to: "b", source: "x".repeat(60000), sql: [] }] } });
  assert.ok(long.length > 1); assert.throws(() => decodeDatabaseEnvelope(long.slice(1), envelope.requestId), /INCOMPLETE/);
  assert.throws(() => decodeDatabaseEnvelope(encodeDatabaseEnvelope({ ...envelope, code: "postgres://private-password" }), envelope.requestId), /INVALID/);
  assert.throws(() => decodeDatabaseEnvelope(encodeDatabaseEnvelope({ ...envelope, review: { ...envelope.review!, markerHash: "changed" } }), envelope.requestId), /CHANGED/);
  assert.throws(() => readDatabaseCloudRequest(JSON.stringify({ ...request(root), identity: { ...identity, region: "us-west-2" } })), /IDENTITY_MISMATCH/);
});

test("review currency includes literal imported migration helpers and rejects computed imports", () => {
  const root = fixture(); const directory = path.join(root, "packages/database/prisma/migrations/app/helper-test"); mkdirSync(directory);
  writeFileSync(path.join(root, "packages/database/helper.ts"), "export const sql = 'SELECT 1';");
  writeFileSync(path.join(directory, "migration.ts"), "import {sql} from '../../../../helper'; export default sql;");
  const first = databaseInputsDigest(root);
  writeFileSync(path.join(root, "packages/database/helper.ts"), "export const sql = 'DROP TABLE app';");
  assert.notEqual(databaseInputsDigest(root), first);
  writeFileSync(path.join(directory, "migration.ts"), "const helper = './dynamic'; import(helper);");
  assert.throws(() => databaseInputsDigest(root), /Computed database source imports/);
  writeFileSync(path.join(directory, "migration.ts"), "export default 1;");
  writeFileSync(path.join(root, "packages/database/prisma.config.ts"), "const helper = './dynamic'; import(helper);");
  assert.throws(() => databaseInputsDigest(root), /Computed database source imports/);
});

test("review digest binds full marker and ledger identities and physical drift refuses review", async () => {
  const root = fixture();
  const source = readFileSync(path.join(root, "packages/database/prisma/contract.prisma"), "utf8"); const compiled = await compileDatabaseSource(root, source);
  assert.ok(compiled.contract);
  const snapshot = JSON.parse(readFileSync(path.join(root, "packages/database/prisma/migrations/app/20260916T1757_add_projects/migration.json"), "utf8"));
  const marker = { ...defaultControlClientFixtures().readMarker!, storageHash: snapshot.from };
  const client = createFixtureControlClient({ readMarker: marker, readAllMarkers: new Map([["app", marker]]) }); await client.connect();
  const first = await reviewCloudDatabase(root, request(root), compiled.config, compiled.contract!, client, []);
  const changedMarker = { ...marker, invariants: ["external-invariant"] };
  const changed = createFixtureControlClient({ readMarker: changedMarker, readAllMarkers: new Map([["app", changedMarker]]) }); await changed.connect();
  const second = await reviewCloudDatabase(root, request(root), compiled.config, compiled.contract!, changed, []);
  assert.notEqual(first.digest, second.digest); assert.equal(first.markerHash, second.markerHash);
  const bad = createFixtureControlClient({ readMarker: marker, schemaVerify: { ...defaultControlClientFixtures().schemaVerify, ok: false } }); await bad.connect();
  await assert.rejects(reviewCloudDatabase(root, request(root), compiled.config, compiled.contract!, bad, []), /PHYSICAL_DRIFT/);
  await Promise.all([client.close(), changed.close(), bad.close()]);
});

test("runner verifies history and physical origin under transaction lock before first DDL", async () => {
  const root = fixture(); const compiled = await compileDatabaseSource(root, readFileSync(path.join(root, "packages/database/prisma/contract.prisma"), "utf8"));
  const target = compiled.config.target; assert.ok(hasMigrations(target));
  const statements: string[] = []; let drift = false, ledgerChanged = false, protocolChanged = false;
  const driver = { async query(sql: string) { statements.push(sql); return { rows: [] }; } };
  const family = { async readAllMarkers() { statements.push("read markers"); return new Map(); }, async readLedger() { statements.push("read ledger"); return ledgerChanged ? [{}] : []; }, async introspect() { statements.push("introspect"); return {}; }, verifySchema() { statements.push("verify origin"); return { ok: !drift }; } };
  const fakeConfig: PrismaNextConfig = { ...compiled.config, target: { ...target, migrations: { ...target.migrations, createRunner() { return { async execute(options) { if (!protocolChanged) await (options.driver as unknown as typeof driver).query("BEGIN"); await (options.driver as unknown as typeof driver).query("CREATE TABLE must_be_reviewed ()"); return ok({ perSpaceResults: [] }); } }; } } } as typeof target };
  const review = reviewValue(root);
  const guarded = guardCloudDatabasePath(fakeConfig, review, () => {}, compiled.contract!); assert.ok(hasMigrations(guarded.target));
  const runner = guarded.target.migrations.createRunner(family as never);
  const options = { driver, perSpaceOptions: [{ space: "app", migrationEdges: [], destinationContract: compiled.contract!, frameworkComponents: [], plan: { spaceId: "app" } }] } as unknown as Parameters<typeof runner.execute>[0];
  await runner.execute(options);
  assert.ok(statements.indexOf("select pg_advisory_xact_lock(hashtext($1))") < statements.indexOf("verify origin"));
  assert.ok(statements.indexOf("verify origin") < statements.indexOf("CREATE TABLE must_be_reviewed ()"));
  for (const condition of ["physical", "ledger", "protocol"]) {
    statements.length = 0; drift = condition === "physical"; ledgerChanged = condition === "ledger"; protocolChanged = condition === "protocol";
    await assert.rejects(runner.execute(options), /PHYSICAL_DRIFT|HISTORY_CHANGED|TRANSACTION_UNSUPPORTED/);
    assert.ok(!statements.includes("CREATE TABLE must_be_reviewed ()"));
    if (!protocolChanged) assert.equal(statements.at(-1), "ROLLBACK");
  }
  // Exercise the actual pinned runner's transaction boundary too: failed
  // origin verification must roll back before it can create control tables.
  statements.length = 0; drift = true; ledgerChanged = false;
  const native = guardCloudDatabasePath(compiled.config, review, () => {}, compiled.contract!); assert.ok(hasMigrations(native.target));
  await assert.rejects(native.target.migrations.createRunner(family as never).execute(options), /PHYSICAL_DRIFT/);
  assert.equal(statements[0], "BEGIN"); assert.equal(statements.at(-1), "ROLLBACK");
  assert.ok(statements.every(sql => !/^(CREATE|ALTER|INSERT|UPDATE|DELETE)/.test(sql)));
});

test("task inspection uses read-only connections and never calls a writer; changed image refuses", async () => {
  const root = fixture(); const metadata = JSON.parse(readFileSync(path.join(root, "packages/database/prisma/migrations/app/20260916T1757_add_projects/migration.json"), "utf8"));
  const marker = { ...defaultControlClientFixtures().readMarker!, storageHash: metadata.from };
  const clients: ReturnType<typeof createFixtureControlClient>[] = [];
  const result = await executeReviewedDatabaseTask(root, JSON.stringify(request(root)), "postgresql://private-user:never-output@private-host/db?sslmode=verify-full", {
    async verifyIdentity() {},
    createClient(options) { assert.match(String(options.connection), /default_transaction_read_only/); const client = createFixtureControlClient({ readMarker: marker, readAllMarkers: new Map([["app", marker]]) }); clients.push(client); return client; },
    async plan(options) { assert.match(String(options.config.db?.connection), /default_transaction_read_only/); return ok({ migrations: [], from: metadata.from, to: metadata.from, summary: "fixture" } as never); },
  });
  assert.equal(result.status, "reviewed"); assert.equal(clients.length, 1);
  assert.ok(clients.every(client => client.calls.every(call => !["migrate", "dbInit", "dbUpdate", "sign"].includes(call.operation))));
  assert.ok(!JSON.stringify(result).includes("never-output"));
  const old = request(root); writeFileSync(path.join(root, "package-lock.json"), "{\"changed\":true}");
  const refused = await executeReviewedDatabaseTask(root, JSON.stringify(old), "postgresql://never-connected/db", { async verifyIdentity() {} });
  assert.deepEqual([refused.status, refused.code], ["refused", "DATABASE_TASK_SOURCE_STALE"]);
});

test("first production database gets separately reviewed initialization; populated or changed empty storage refuses", async () => {
  const root = fixture(); const compiled = await compileDatabaseSource(root, readFileSync(path.join(root, "packages/database/prisma/contract.prisma"), "utf8"));
  const operation = JSON.parse(readFileSync(path.join(root, "packages/database/prisma/migrations/app/20260916T1757_add_projects/ops.json"), "utf8"))[0];
  const family = compiled.config.family.create(createControlStack(compiled.config)); assert.ok(hasOperationPreview(family));
  const initialization = { mode: "plan" as const, plan: { operations: [{ id: operation.id, label: operation.label, operationClass: operation.operationClass }], preview: family.toOperationPreview([operation]) }, destination: { storageHash: compiled.contract!.storage.storageHash }, summary: "fixture" };
  rmSync(path.join(root, "packages/database/prisma/migrations"), { recursive: true });
  let empty = true, writerCalls = 0;
  const dependencies = {
    async verifyIdentity() {},
    async empty(_root: string, connection: string) { assert.match(connection, /default_transaction_read_only/); return empty; },
    async plan() { throw new Error("Missing migration graph must not block genuine empty initialization"); },
    createClient(options: Parameters<typeof import("@prisma/orm-toolchain/cli/control-api").createControlClient>[0]) {
      if (String(options.connection).includes("default_transaction_read_only")) {
        const reader = createFixtureControlClient({ readMarker: null, readAllMarkers: new Map(), readLedger: [] });
        return Object.assign(reader, { async dbInit() {
          const target = options.target; assert.ok(hasMigrations(target));
          const runner = target.migrations.createRunner(options.family.create(createControlStack(options)));
          await runner.execute({ driver: {} as never, perSpaceOptions: [{ space: "app", destinationContract: compiled.contract!, plan: { operations: [operation] }, migrationEdges: [] }] } as never);
          return ok(initialization);
        } });
      }
      const writer = createFixtureControlClient(); return Object.assign(writer, { async dbInit() { writerCalls++; return ok({ ...initialization, mode: "apply" as const }); } });
    },
  };
  const reviewed = await executeReviewedDatabaseTask(root, JSON.stringify(request(root)), "postgresql://private-user:never-output@private/db", dependencies);
  assert.equal(reviewed.status, "reviewed"); assert.equal(reviewed.review?.kind, "initialize"); assert.equal(writerCalls, 0);
  assert.ok(reviewed.review?.initialization?.sql.length); assert.ok(reviewed.review?.initialization?.controlSql?.some(statement => /prisma_contract/.test(statement.sql)));
  const applying = { ...request(root, "apply"), expectedDigest: reviewed.review!.digest };
  empty = false; const refused = await executeReviewedDatabaseTask(root, JSON.stringify(applying), "postgresql://private/db", dependencies);
  assert.deepEqual([refused.status, refused.code], ["refused", "DATABASE_INITIALIZATION_REQUIRES_EMPTY"]); assert.equal(writerCalls, 0);
  empty = true; const applied = await executeReviewedDatabaseTask(root, JSON.stringify(applying), "postgresql://private/db", dependencies);
  assert.equal(applied.status, "applied"); assert.equal(writerCalls, 1);

  // A late populated object must be rejected on the writer connection after
  // canonical advisory locks, even after successful earlier read-only proof.
  const target = compiled.config.target; assert.ok(hasMigrations(target));
  const statements: string[] = []; let occupied = true;
  const metadataFamily = Object.assign(family, { async readAllMarkers() { return new Map(); }, async readLedger() { return []; } });
  const fakeConfig: PrismaNextConfig = { ...compiled.config, target: { ...target, migrations: { ...target.migrations, createRunner() { return { async execute(options) { const driver = options.driver as unknown as { query(sql: string): Promise<unknown> }; await driver.query("BEGIN"); await driver.query("CREATE TABLE user_objects ()"); return ok({ perSpaceResults: [] }); } }; } } } as typeof target };
  const guarded = guardCloudDatabasePath(fakeConfig, reviewed.review!, () => {}); assert.ok(hasMigrations(guarded.target));
  const runner = guarded.target.migrations.createRunner(metadataFamily);
  const options = { driver: { async query(sql: string) { statements.push(sql); return { rows: [{ occupied }] }; } }, perSpaceOptions: [{ space: "app", plan: { spaceId: "app", operations: [operation] }, migrationEdges: [], destinationContract: compiled.contract!, frameworkComponents: [] }] } as unknown as Parameters<typeof runner.execute>[0];
  await assert.rejects(runner.execute(options), /REQUIRES_EMPTY/);
  assert.ok(statements.includes(DATABASE_EMPTY_SQL)); assert.ok(statements.includes("SELECT pg_advisory_xact_lock(4590, 1)")); assert.equal(statements.at(-1), "ROLLBACK"); assert.ok(!statements.includes("CREATE TABLE user_objects ()"));
  statements.length = 0; occupied = false; await runner.execute(options); assert.ok(statements.includes("CREATE TABLE user_objects ()"));
  const baseline = JSON.stringify(operation);
  for (const change of [() => { operation.execute[0].params = ["unreviewed"]; }, () => { operation.precheck[0].sql += " -- changed precheck"; }, () => { operation.execute.push({ sql: "INSERT INTO app VALUES ($1)", params: ["unreviewed"] }); }]) {
    for (const key of Object.keys(operation)) delete operation[key]; Object.assign(operation, JSON.parse(baseline));
    change(); statements.length = 0; await assert.rejects(runner.execute(options), /PLAN_CHANGED/); assert.deepEqual(statements, []);
  }
});

function cloudHarness() {
  const root = fixture(); const commands: string[][] = []; let protocol = "1", account = identity.account, revision = identity.taskDefinitionArn, logGroup = "private-migration", mode: "ok" | "incomplete" | "refused" | "unchanged" | "initialize" = "ok", lastRequest: DatabaseCloudRequest;
  const launch = { region: identity.region, cluster: `arn:aws:ecs:${identity.region}:${identity.account}:cluster/production`, taskDefinitionFamily: "production-db-migrate", containerName: "Main", launchType: "FARGATE", platformVersion: "LATEST", subnets: ["subnet-private"], securityGroups: ["sg-db-task"], assignPublicIp: false };
  const run: Runner = async spec => {
    const args = [...spec.args]; commands.push(args); assert.equal(args[args.indexOf("--profile") + 1], "dev"); assert.equal(args[args.indexOf("--region") + 1], identity.region);
    let value: unknown;
    if (args[0] === "sts") value = { Account: account };
    else if (args[0] === "cloudformation" && args[1] === "describe-stacks") value = { Stacks: [{ StackStatus: "UPDATE_COMPLETE", Outputs: [{ Description: "framework:deployment:v1", OutputValue: JSON.stringify({ version: 1, ...identity, mode: "prod" }) }, { Description: "framework:task-launch:v1:db-migrate", OutputValue: JSON.stringify({ version: 1, kind: "task", transport: "aws", target: "db-migrate", launch }) }] }] };
    else if (args[1] === "list-stack-resources") value = { StackResourceSummaries: [{ ResourceType: "AWS::ECS::TaskDefinition", PhysicalResourceId: revision }] };
    else if (args[1] === "describe-task-definition") { assert.equal(args[args.indexOf("--task-definition") + 1], revision); value = { taskDefinition: { taskDefinitionArn: revision, containerDefinitions: [{ name: "Main", environment: [{ name: "DATABASE_REVIEW_PROTOCOL", value: protocol }], logConfiguration: { logDriver: "awslogs", options: { "awslogs-group": logGroup, "awslogs-stream-prefix": "task" } } }] } }; }
    else if (args[1] === "run-task") { const overrides = JSON.parse(args[args.indexOf("--overrides") + 1]!); lastRequest = JSON.parse(overrides.containerOverrides[0].environment[0].value); assert.equal(args[args.indexOf("--task-definition") + 1], revision); assert.ok(new DatabaseOperationStore(root).list().some(record => record.requestId === lastRequest.requestId)); value = { tasks: [{ taskArn: `arn:aws:ecs:${identity.region}:${identity.account}:task/production/123abc` }] }; }
    else if (args[1] === "describe-tasks") value = { tasks: [{ taskDefinitionArn: revision, lastStatus: "STOPPED", containers: [{ name: "Main", exitCode: mode === "refused" ? 1 : 0 }] }] };
    else if (args[0] === "logs") {
      const review = { ...reviewValue(root), identity: { ...identity, taskDefinitionArn: revision }, ...(mode === "initialize" ? { kind: "initialize" as const, initialization: { operations: [], operationsDigest: digest([]), statements: [], sql: [], controlSql: [{ sql: "CREATE SCHEMA prisma_contract" }] } } : {}) }; const { digest: _digest, ...body } = review; review.digest = digest(body);
      const envelope: DatabaseCloudEnvelope = { version: 1, requestId: lastRequest!.requestId, status: mode === "refused" ? "refused" : lastRequest!.mode === "review" ? "reviewed" : mode === "unchanged" ? "unchanged" : "applied", ...(lastRequest!.mode === "review" ? { review } : { applied: ["reviewed-migration"] }), ...(mode === "refused" ? { code: "DATABASE_PHYSICAL_DRIFT" } : {}) };
      value = { events: mode === "incomplete" ? [] : encodeDatabaseEnvelope(envelope).map(message => ({ message })) };
    } else throw new Error(`Unexpected fake command ${args.slice(0, 2)}`);
    return { code: 0, stdout: JSON.stringify(value), stderr: "" };
  };
  const service = new DatabaseCloudService(root, run, { ...process.env, FRAMEWORK_POLL_MS: "1", FRAMEWORK_AWS_CLI: undefined });
  return { root, service, commands, setProtocol(value: string) { protocol = value; }, setAccount(value: string) { account = value; }, setRevision(value: string) { revision = value; }, setMode(value: typeof mode) { mode = value; }, setPublicIp(value: boolean) { launch.assignPublicIp = value; }, setLogGroup(value: string) { logGroup = value; } };
}

test("production preflight pins stack-owned revision and refuses old protocol/account without launch", async () => {
  const harness = cloudHarness();
  const destination = await harness.service.prepare("production", "dev"); assert.equal(destination.identity.taskDefinitionArn, identity.taskDefinitionArn); assert.match(destination.effects.join(" "), /billed Fargate/);
  assert.ok(!harness.commands.some(args => args[1] === "run-task"));
  await assert.rejects(harness.service.review("production", "dev", "Inspect production", "unknown"), /expired or changed/);
  harness.setProtocol("0"); await assert.rejects(harness.service.prepare("production", "dev"), /predates/);
  harness.setAccount("999999999999"); await assert.rejects(harness.service.prepare("production", "dev"), /profile account differs/);
  assert.ok(!harness.commands.some(args => args[1] === "run-task"));
});

test("production review/application are explicit separate tasks; stale revisions and uncertain outcomes never auto-retry", async () => {
  const harness = cloudHarness(); let destination = await harness.service.prepare("production", "dev");
  await assert.rejects(harness.service.review("production", "dev", "yes", destination.id), /Type Inspect/);
  const approval = await harness.service.review("production", "dev", "Inspect production", destination.id);
  assert.equal(harness.commands.filter(args => args[1] === "run-task").length, 1);
  assert.equal(new DatabaseOperationStore(harness.root).list()[0]?.status, "reviewed");
  await assert.rejects(harness.service.apply(approval.id, "yes"), /Type Apply/);
  harness.setRevision(identity.taskDefinitionArn.replace(":7", ":8"));
  await assert.rejects(harness.service.apply(approval.id, "Apply production"), /changed after review/);
  assert.equal(harness.commands.filter(args => args[1] === "run-task").length, 1);
  harness.setRevision(identity.taskDefinitionArn); harness.setMode("incomplete");
  await assert.rejects(harness.service.apply(approval.id, "Apply production"), /could not be confirmed/);
  const operation = new DatabaseOperationStore(harness.root).list()[0]!; assert.equal(operation.status, "unconfirmed"); assert.ok(operation.taskArn); assert.ok(operation.requestId);
  assert.equal(harness.commands.filter(args => args[1] === "run-task").length, 2);
  await assert.rejects(harness.service.apply(approval.id, "Apply production"), /expired/);
  assert.equal(harness.commands.filter(args => args[1] === "run-task").length, 2);
});

test("confirmed no-change task is unchanged and refused review is failed with database unchanged", async () => {
  const harness = cloudHarness(); const destination = await harness.service.prepare("production", "dev"); const approval = await harness.service.review("production", "dev", "Inspect production", destination.id);
  harness.setMode("unchanged"); const result = await harness.service.apply(approval.id, "Apply production"); assert.deepEqual([result.status, result.database], ["unchanged", "unchanged"]);
  harness.setMode("refused"); const second = await harness.service.prepare("production", "dev"); await assert.rejects(harness.service.review("production", "dev", "Inspect production", second.id), /PHYSICAL_DRIFT/);
  assert.equal(new DatabaseOperationStore(harness.root).list()[0]?.result?.database, "unchanged");
});

test("first production initialization requires its distinct target phrase and records initialization", async () => {
  const harness = cloudHarness(); harness.setMode("initialize");
  const destination = await harness.service.prepare("production", "dev"); const approval = await harness.service.review("production", "dev", "Inspect production", destination.id);
  assert.equal(approval.confirmation, "Initialize production");
  await assert.rejects(harness.service.apply(approval.id, "Apply production"), /Type Initialize production/);
  assert.equal(harness.commands.filter(args => args[1] === "run-task").length, 1);
  const result = await harness.service.apply(approval.id, "Initialize production"); assert.equal(result.database, "applied");
  assert.equal(new DatabaseOperationStore(harness.root).list()[0]?.kind, "initialize");
});

test("preparation displays actual public-IP placement and network/log changes invalidate preparation and application", async () => {
  const harness = cloudHarness(); harness.setPublicIp(true);
  const first = await harness.service.prepare("production", "dev");
  assert.equal(first.launch.assignPublicIp, true); assert.deepEqual(first.launch.subnets, ["subnet-private"]); assert.deepEqual(first.launch.securityGroups, ["sg-db-task"]);
  assert.match(first.effects.join(" "), /declared VPC networking/); assert.match(first.effects.join(" "), /database remains private/);
  harness.setPublicIp(false);
  await assert.rejects(harness.service.review("production", "dev", "Inspect production", first.id), /launch\/network\/log descriptor/);
  assert.equal(harness.commands.filter(args => args[1] === "run-task").length, 0);
  const second = await harness.service.prepare("production", "dev"); const approval = await harness.service.review("production", "dev", "Inspect production", second.id);
  harness.setLogGroup("different-logs");
  await assert.rejects(harness.service.apply(approval.id, "Apply production"), /launch\/network\/log descriptor changed/);
  assert.equal(harness.commands.filter(args => args[1] === "run-task").length, 1);
});
