import assert from "./support/assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { parseDeclaredSchema, readDeclaredSchema, readLocalDatabases, withLocalDatabases } from "../server/database";
import { SnapshotBuilder } from "../server/snapshot";
import { watchRepository } from "../server/watch";
import { buildScene } from "../src/scene/build";
import { layoutBoard } from "../src/layout";
import { schemaLayout, TABLE_WIDTH } from "../src/schema-layout";
import type { Snapshot } from "../shared/model";

const root = path.resolve(__dirname, "..", "..");
let builder: SnapshotBuilder;
let snapshot: Snapshot;
before(async () => { builder = new SnapshotBuilder(root); snapshot = (await builder.refresh()).snapshot; });
after(() => builder.dispose());

test("the real declared schema exposes mapped columns, keys, indexes and the owning FK", () => {
  const schema = snapshot.schema;
  assert.deepEqual(schema.problems, []);
  assert.deepEqual(schema.tables.map((table) => table.table), ["users", "projects"]);
  const project = schema.tables.find((table) => table.model === "Project")!;
  assert.equal(project.columns.find((column) => column.name === "ownerId")?.column, "owner_id");
  assert.ok(!project.columns.some((column) => column.name === "owner"), "relation fields are not storage columns");
  assert.ok(project.indexes.some((index) => index.name === "projects_owner_id_idx"));
  const relation = schema.relations[0]!;
  assert.equal(relation.from, project.id);
  assert.equal(relation.to, "schema:public.User");
  assert.equal(relation.cardinality, "N:1");
  assert.equal(relation.onDelete, "Cascade");
  const text = readFileSync(path.join(root, schema.file), "utf8");
  assert.match(text.slice(relation.source.start, relation.source.end), /owner\s+User\s+@relation/);
  assert.equal(text.slice(0, relation.source.start).split("\n").length, relation.source.line);
});

test("Prisma syntax handles comments, multiline composite keys, namespaces, enums and self references", () => {
  const schema = parseDeclaredSchema(`// use prisma-8
// model Fake { id String }
enum Status {
  OPEN
  CLOSED
}
namespace sales {
  model Tenant {
    first Uuid
    second Uuid
    @@id([first, second])
  }
  model Entry {
    id Uuid @id
    first Uuid?
    second Uuid?
    owner Tenant? @relation(
      fields: [first, second],
      references: [first, second],
      onDelete: SetNull
    )
    parentId Uuid?
    parent Entry? @relation(fields: [parentId], references: [id])
    status Status @default(OPEN)
    label String @default("model NotATable { and // comment }")
    @@index([first, second], unique: true)
    @@map("entries")
  }
}`);
  assert.deepEqual(schema.problems, []);
  assert.equal(schema.tables.length, 2);
  assert.deepEqual(schema.enums[0]?.values, ["OPEN", "CLOSED"]);
  const relation = schema.relations.find((relation) => relation.name === "owner")!;
  assert.equal(relation.to, "schema:sales.Tenant");
  assert.equal(relation.cardinality, "1:1");
  assert.equal(relation.nullable, true);
  assert.deepEqual(relation.fields, ["first", "second"]);
  assert.equal(relation.onDelete, "SetNull");
  assert.equal(schema.relations.find((relation) => relation.name === "parent")?.from, "schema:sales.Entry");
  const layout = schemaLayout(schema);
  assert.equal(layout.edges.length, 2);
  for (const table of layout.tables) {
    assert.ok(table.x + TABLE_WIDTH <= layout.width);
    assert.ok(table.y + table.height <= layout.height);
  }
});

test("malformed PSL reports diagnostics instead of displaying an incomplete schema", () => {
  const schema = parseDeclaredSchema('model Broken {\n id Uuid @id\n owner User @relation(fields: [\n');
  assert.ok(schema.problems.length > 0);
  assert.deepEqual(schema.tables, []);
  assert.deepEqual(schema.relations, []);
});

test("partial uniqueness does not imply one-to-one, and unresolved FKs produce notes", () => {
  const schema = parseDeclaredSchema(`model Owner {
  id Uuid @id
}
model Item {
  id Uuid @id
  ownerId Uuid
  owner Owner @relation(fields: [ownerId], references: [id])
  broken Owner @relation(fields: [missing], references: [id])
  external other:public.Shared @relation(fields: [ownerId], references: [id])
  @@index([ownerId], unique: true, where: "id IS NOT NULL")
}`);
  assert.equal(schema.relations.length, 1);
  assert.equal(schema.relations[0]?.cardinality, "N:1");
  assert.equal(schema.tables.find((table) => table.model === "Item")?.columns.find((column) => column.name === "ownerId")?.unique, false);
  assert.ok(schema.problems.some((problem) => problem.includes("unresolved")));
  assert.ok(schema.problems.some((problem) => problem.includes("outside")));
});

test("local database projection never exposes Compose credentials and reports YAML errors safely", () => {
  const fixture = mkdtempSync(path.join(root, ".cache/framework-studio/database-"));
  try {
    writeFileSync(path.join(fixture, "docker-compose.yml"), `services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: never-show-this-value
    volumes: [postgres_data:/var/lib/postgresql/data]
`);
    const projection = readLocalDatabases(fixture);
    assert.equal(projection.services[0]?.image, "postgres:16");
    assert.deepEqual(projection.services[0]?.volumes, ["postgres_data"]);
    assert.ok(!JSON.stringify(projection).includes("never-show-this-value"));
    writeFileSync(path.join(fixture, "docker-compose.yml"), 'services: [invalid\n POSTGRES_PASSWORD: never-show-this-value');
    const failed = readLocalDatabases(fixture);
    assert.equal(failed.services.length, 0);
    assert.ok(failed.problems.length);
    assert.ok(!JSON.stringify(failed).includes("never-show-this-value"));
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("local execution connects to PostgreSQL; production retains its RDS binding", () => {
  const dev = snapshot.models.dev;
  const prod = snapshot.models.prod;
  assert.equal(dev.localServices?.[0]?.enabled, true);
  assert.equal(prod.localServices?.[0]?.enabled, false);
  const compose = readFileSync(path.join(root, "docker-compose.yml"), "utf8");
  const source = dev.localServices![0]!.source;
  assert.equal(compose.slice(source.start, source.end), "postgres");
  assert.ok(source.start > compose.indexOf("services:\n"), "source opens the service, not an earlier dependency anchor");
  assert.ok(dev.edges.some((edge) => edge.from === "lambda:graphql-api" && edge.to === "local:postgres"));
  assert.ok(!dev.edges.some((edge) => edge.relation === "database" && edge.from === "lambda:graphql-api" && edge.to === "resource:rds.database"));
  assert.ok(prod.edges.some((edge) => edge.from === "lambda:graphql-api" && edge.to === "resource:rds.database"));
  assert.ok(!prod.edges.some((edge) => edge.to === "local:postgres"));
  for (const model of [dev, prod]) {
    assert.ok(layoutBoard(model).nodes.some((node) => node.id === "local:postgres"));
    const scene = buildScene(model);
    assert.equal(scene.nodes.find((node) => node.id === "local:postgres")?.presence, model.mode === "dev" ? "built" : "other");
    assert.equal(scene.islands.some((island) => island.id === "island:local"), false, "the local database has no island of its own");
  }
  assert.deepEqual(withLocalDatabases(dev, dev.localServices!).edges, dev.edges, "stale model reprojection keeps stable edge ids");
});

test("a workload executing both locally and in development AWS retains both database connections", () => {
  const prod = snapshot.models.prod;
  const model = { ...prod, mode: "dev" as const, targets: prod.targets.map((target) => target.ref === "lambda:graphql-api" ? { ...target, lanes: { ...target.lanes, local: true, dev: true } } : target) };
  const projected = withLocalDatabases(model, snapshot.models.dev.localServices!);
  const destinations = projected.edges.filter((edge) => edge.from === "lambda:graphql-api" && edge.relation === "database").map((edge) => edge.to);
  assert.deepEqual(destinations.sort(), ["local:postgres", "resource:rds.database"]);
});

test("schema reading follows contract edits without generation, and the watcher sees atomic replacements", async () => {
  const fixture = mkdtempSync(path.join(root, ".cache/framework-studio/database-"));
  const directory = path.join(fixture, "packages/database/prisma");
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "contract.prisma");
  writeFileSync(file, 'model One {\n id Uuid @id\n}\n');
  const before = readDeclaredSchema(fixture);
  let stop = () => {};
  try {
    const changed = new Promise<readonly string[]>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Contract watcher did not refresh")), 10000);
      stop = watchRepository(fixture, (files) => { clearTimeout(timeout); resolve(files); }, 10);
    });
    // Let the native watcher attach to the newly created fixture directory.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const { renameSync } = await import("node:fs");
    writeFileSync(path.join(directory, "replacement.tmp"), 'model Two {\n id Uuid @id\n}\n');
    renameSync(path.join(directory, "replacement.tmp"), file);
    assert.ok((await changed).includes("packages/database/prisma/contract.prisma"));
    const after = readDeclaredSchema(fixture);
    assert.notEqual(before.hash, after.hash);
    assert.equal(after.tables[0]?.model, "Two");
  } finally { stop(); rmSync(fixture, { recursive: true, force: true }); }
});
