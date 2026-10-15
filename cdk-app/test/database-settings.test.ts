import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { resolveDatabaseSettings } from "../database-settings";
const settings = (env: Record<string, string | undefined> = {}, context: Record<string, unknown> = {}) => resolveDatabaseSettings({ env, getContext: key => context[key] });

test("database settings preserve defaults and explicit context overrides", () => {
  const value = settings();
  assert.equal(value.instanceClass, "db.t3.micro");
  assert.equal(value.engineVersion, "16");
  assert.equal(value.multiAz, false);
  assert.equal(value.proxyEnabled, false);
  assert.equal(value.readReplicaCount, 0);
  assert.equal(value.allocatedStorage, 20);
  assert.equal(value.maxAllocatedStorage, 100);
  assert.equal(value.storageType, "gp2");
  assert.equal(settings({ DATABASE_INSTANCE_CLASS: "db.m7g.large" }, { databaseInstanceClass: "db.r7g.large" }).instanceClass, "db.r7g.large");
  assert.equal(settings({ DATABASE_MULTI_AZ: "true" }, { databaseMultiAz: false }).multiAz, false);
  assert.equal(settings({ DATABASE_INSTANCE_CLASS: "db.m7g.large" }, { databaseInstanceClass: "" }).instanceClass, "db.m7g.large");
  assert.equal(settings({ DATABASE_MAX_ALLOCATED_STORAGE_GIB: "0" }).maxAllocatedStorage, 0);
});

test("invalid input cannot silently create a different database topology", () => {
  for (const env of [
    { DATABASE_MULTI_AZ: "yes" }, { DATABASE_PROXY_ENABLED: "1" },
    { DATABASE_INSTANCE_CLASS: "t3.micro" }, { DATABASE_ENGINE_VERSION: "latest" },
    { DATABASE_READ_REPLICA_COUNT: "16" }, { DATABASE_ALLOCATED_STORAGE_GIB: "19" },
    { DATABASE_MAX_ALLOCATED_STORAGE_GIB: "21" }, { DATABASE_STORAGE_TYPE: "standard" },
    { DATABASE_PROXY_MAX_CONNECTIONS_PERCENT: "0" }, { DATABASE_LOG_RETENTION_DAYS: "31" },
    { DATABASE_CLOUDWATCH_LOGS_EXPORTS: "secret" }, { DATABASE_BACKUP_WINDOW: "25:00-25:30" },
    { DATABASE_MAINTENANCE_WINDOW: "mon:00:00-mon:00:20" },
    { DATABASE_BACKUP_WINDOW: "02:00-02:30", DATABASE_MAINTENANCE_WINDOW: "sun:02:15-sun:03:00" },
    { DATABASE_BACKUP_WINDOW: "23:45-00:15", DATABASE_MAINTENANCE_WINDOW: "sun:23:30-mon:00:30" },
    { DATABASE_READ_REPLICA_COUNT: "1", DATABASE_BACKUP_RETENTION_DAYS: "0" },
  ]) assert.throws(() => settings(env));
  assert.doesNotThrow(() => settings({ DATABASE_BACKUP_WINDOW: "23:45-00:15", DATABASE_MAINTENANCE_WINDOW: "sun:01:00-sun:01:30" }));
});

test("every infrastructure option supports deliberate overrides", () => {
  assert.deepEqual(settings({
    DATABASE_INSTANCE_CLASS: "db.m7g.large", DATABASE_ENGINE_VERSION: "16.4",
    DATABASE_ALLOW_MAJOR_VERSION_UPGRADE: "true", DATABASE_MULTI_AZ: "true",
    DATABASE_STORAGE_TYPE: "gp3", DATABASE_ALLOCATED_STORAGE_GIB: "400",
    DATABASE_MAX_ALLOCATED_STORAGE_GIB: "1000", DATABASE_STORAGE_IOPS: "32000",
    DATABASE_STORAGE_THROUGHPUT_MIBPS: "1000", DATABASE_BACKUP_RETENTION_DAYS: "14",
    DATABASE_BACKUP_WINDOW: "02:00-02:30", DATABASE_MAINTENANCE_WINDOW: "sun:03:00-sun:03:30",
    DATABASE_AUTO_MINOR_VERSION_UPGRADE: "false", DATABASE_APPLY_IMMEDIATELY: "false",
    DATABASE_READ_REPLICA_COUNT: "2", DATABASE_READ_REPLICA_INSTANCE_CLASS: "db.r7g.large",
    DATABASE_READ_REPLICA_MULTI_AZ: "true", DATABASE_PROXY_ENABLED: "true",
    DATABASE_PROXY_MAX_CONNECTIONS_PERCENT: "75", DATABASE_PROXY_BORROW_TIMEOUT_SECONDS: "30",
    DATABASE_PROXY_IDLE_CLIENT_TIMEOUT_SECONDS: "600", DATABASE_CLOUDWATCH_LOGS_EXPORTS: "postgresql,upgrade",
    DATABASE_LOG_RETENTION_DAYS: "90",
  }), {
    instanceClass: "db.m7g.large", engineVersion: "16.4", allowMajorVersionUpgrade: true, multiAz: true,
    storageType: "gp3", allocatedStorage: 400, maxAllocatedStorage: 1000, iops: 32000, throughput: 1000,
    backupRetentionDays: 14, backupWindow: "02:00-02:30", maintenanceWindow: "sun:03:00-sun:03:30",
    autoMinorVersionUpgrade: false, applyImmediately: false, readReplicaCount: 2,
    readReplicaInstanceClass: "db.r7g.large", readReplicaMultiAz: true, proxyEnabled: true,
    proxyMaxConnectionsPercent: 75, proxyBorrowTimeoutSeconds: 30, proxyIdleClientTimeoutSeconds: 600,
    logExports: ["postgresql", "upgrade"], logRetentionDays: 90,
  });
});

test("storage validation follows PostgreSQL gp3 and io2 requirements", () => {
  assert.throws(() => settings({ DATABASE_STORAGE_IOPS: "3000" }), /gp2/);
  assert.throws(() => settings({ DATABASE_STORAGE_TYPE: "gp3", DATABASE_STORAGE_IOPS: "12000" }), /400 GiB/);
  const gp3 = { DATABASE_STORAGE_TYPE: "gp3", DATABASE_ALLOCATED_STORAGE_GIB: "400", DATABASE_MAX_ALLOCATED_STORAGE_GIB: "1000" };
  assert.doesNotThrow(() => settings({ ...gp3, DATABASE_STORAGE_IOPS: "12000", DATABASE_STORAGE_THROUGHPUT_MIBPS: "500" }));
  assert.throws(() => settings({ ...gp3, DATABASE_STORAGE_IOPS: "12000", DATABASE_STORAGE_THROUGHPUT_MIBPS: "4000" }), /0.25/);
  const io2 = { DATABASE_STORAGE_TYPE: "io2", DATABASE_ALLOCATED_STORAGE_GIB: "100", DATABASE_MAX_ALLOCATED_STORAGE_GIB: "1000" };
  assert.throws(() => settings(io2), /requires DATABASE_STORAGE_IOPS/);
  assert.doesNotThrow(() => settings({ ...io2, DATABASE_STORAGE_IOPS: "1000" }));
  assert.throws(() => settings({ ...io2, DATABASE_STORAGE_IOPS: "100001" }), /ratio/);
});

test("both authored templates document all resolver settings with production defaults", () => {
  const prod = readFileSync(path.join(__dirname, "../.env.prod.example"), "utf8");
  const dev = readFileSync(path.join(__dirname, "../.env.dev.example"), "utf8");
  const source = readFileSync(path.join(__dirname, "../database-settings.ts"), "utf8");
  const names = new Set(source.match(/DATABASE_[A-Z_]+/g));
  for (const name of names) {
    assert.match(prod, new RegExp(`^#? ?${name}=`, "m"), name);
    assert.match(dev, new RegExp(`^# ${name}=`, "m"), name);
  }
  const env = Object.fromEntries(prod.split(/\r?\n/).filter(line => /^DATABASE_/.test(line)).map(line => line.split("=")));
  assert.deepEqual(settings(env), settings());
});
