import assert from "node:assert/strict";
import test from "node:test";
import {
  databaseSettings,
  defineDatabase,
  defineFrameworkConfig,
  defineNetwork,
  defineResources,
  isFrameworkDatabase,
  resource,
  resolveDatabaseSettings,
  type DatabaseDeclaration,
} from "../src/config";

const application = defineNetwork({ id: "application", cidr: "10.0.0.0/16", zones: 2 });
const analytics = defineNetwork({ id: "analytics", cidr: "10.1.0.0/16", zones: 2 });
const resources = defineResources({ rds: resource.stack<{ database: { readonly node: { readonly id: string; readonly path: string }; readonly connections: object } }>() });
const declaration: DatabaseDeclaration = { id: "application", resource: resources.rds.database, vpc: application };
const defaults = { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: {} } } as const;
const config = (database = defineDatabase(declaration)) => ({
  resources, database, defaults, networks: [application, analytics],
  http: [{ "/database": { directory: "/lambda_functions/database" as const, methods: ["GET"] as const, vpc: application, subnet: "isolated" as const, database: true as const } }],
  webSocket: [], events: [], services: [],
});

test("managed database declaration owns placement and preserves established defaults", () => {
  const database = defineDatabase(declaration);
  assert.equal(isFrameworkDatabase(database), true);
  assert.equal(database.resource, resources.rds.database);
  assert.equal(database.vpc, application);
  assert.equal(database.subnet, "isolated");
  assert.equal(database.engine, "postgres");
  assert.equal(database.databaseName, "app_db");
  assert.equal(Object.isFrozen(database), true);
  assert.equal(Object.isFrozen(database.settings), true);
  assert.deepEqual(databaseSettings(database), resolveDatabaseSettings({ getContext: () => undefined, env: {} }));
  assert.doesNotThrow(() => defineFrameworkConfig(config(database)));
});

test("declared database settings use the same validation as deployment overrides", () => {
  const database = defineDatabase({ ...declaration, subnet: "private", databaseName: "another_db", settings: {
    instanceClass: "db.m7g.large", multiAz: true, readReplicaCount: 2, proxyEnabled: true,
    storageType: "gp3", allocatedStorage: 400, maxAllocatedStorage: 1000, iops: 12000, throughput: 500,
  } });
  const settings = databaseSettings(database);
  assert.equal(settings.multiAz, true);
  assert.equal(settings.readReplicaCount, 2);
  assert.equal(settings.readReplicaInstanceClass, "db.m7g.large");
  assert.equal(settings.proxyEnabled, true);
  assert.equal(settings.throughput, 500);
  assert.equal(database.subnet, "private");
  assert.equal(database.databaseName, "another_db");
  assert.throws(() => defineDatabase({ ...declaration, settings: { readReplicaCount: 1, backupRetentionDays: 0 } }), /positive settings.backupRetentionDays/);
  assert.throws(() => defineDatabase({ ...declaration, settings: { storageType: "gp2", iops: 1000 } }), /gp2/);
});

test("explicit deployment settings override declaration settings before validation", () => {
  const defaults = { instanceClass: "db.m7g.large", multiAz: true, storageType: "io2" as const, allocatedStorage: 100, maxAllocatedStorage: 1000, iops: 1000 };
  const settings = resolveDatabaseSettings({
    defaults, env: { DATABASE_INSTANCE_CLASS: "db.r7g.large", DATABASE_MULTI_AZ: "false" },
    getContext: key => key === "databaseInstanceClass" ? "db.m7g.xlarge" : undefined,
  });
  assert.equal(settings.instanceClass, "db.m7g.xlarge");
  assert.equal(settings.readReplicaInstanceClass, "db.m7g.xlarge");
  assert.equal(settings.multiAz, false);
  assert.equal(settings.storageType, "io2");
  assert.equal(settings.iops, 1000);
});

test("malformed settings and unsafe database placement fail with an authoring fix", () => {
  for (const patch of [
    { id: "Wrong ID" }, { subnet: "public" }, { engine: "mysql" }, { databaseName: "123bad" },
    { settings: { multiAz: "true" } }, { settings: { allocatedStorage: "20" } },
    { settings: { unknownOption: true } }, { settings: { constructor: 123 } }, { settings: Object.create({ multiAz: true }) }, { settings: { logExports: "postgresql" } },
    { public: true },
  ]) assert.throws(() => defineDatabase({ ...declaration, ...patch } as DatabaseDeclaration));
  assert.throws(() => defineFrameworkConfig({ ...config(), networks: [analytics] }), /not the declaration registered/);
  assert.throws(() => defineFrameworkConfig({ ...config(), http: [{ "/database": { directory: "/lambda_functions/database" as const, methods: ["GET"] as const, vpc: analytics, subnet: "isolated", database: true } }] }), /Cross-VPC database access/);
});

test("declared arrays cannot mutate after a database has been validated", () => {
  const logs = ["postgresql"];
  const database = defineDatabase({ ...declaration, settings: { logExports: logs } });
  logs.push("upgrade");
  assert.deepEqual(database.settings.logExports, ["postgresql"]);
  assert.equal(Object.isFrozen(database.settings.logExports), true);
});
