import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resourceGraph, findCycle } from "./support/template-graph";

interface Resource { Type: string; Properties: Record<string, any>; DependsOn?: string[]; DeletionPolicy?: string; UpdateReplacePolicy?: string }
interface StackTemplate { Resources: Record<string, Resource>; Outputs: Record<string, any> }
type Assembly = Record<string, StackTemplate>;
const resourcesOf = (template: StackTemplate, type: string) => Object.entries(template.Resources).filter(([, value]) => value.Type === type);
const serialized = (value: unknown) => JSON.stringify(value);

function synth(settings: Record<string, string>): Assembly {
  const directory = mkdtempSync(path.join(os.tmpdir(), "framework-rds-test-"));
  try {
    const inputs = path.join(directory, "inputs.env");
    const output = path.join(directory, "templates.json");
    writeFileSync(inputs, "CDK_APP_NAME=example\n");
    // Start from public fixture inputs, independent of the developer's authored env.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DATABASE_") && key !== "RETAIN_STATEFUL_RESOURCES"));
    const run = spawnSync(process.execPath, ["--import", "tsx", path.join(__dirname, "fixtures/database-synth.ts"), output], {
      env: { ...env, FRAMEWORK_INPUTS_FILE: inputs, FRAMEWORK_MODE: "prod", ...settings }, encoding: "utf8", timeout: 90_000,
    });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(readFileSync(output, "utf8"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("direct, Multi-AZ, replica, Proxy and combined graphs preserve identities and scope connections", () => {
  for (const settings of [
    {}, { DATABASE_MULTI_AZ: "true" }, { DATABASE_READ_REPLICA_COUNT: "2" },
    { DATABASE_PROXY_ENABLED: "true" },
    { DATABASE_MULTI_AZ: "true", DATABASE_PROXY_ENABLED: "true", DATABASE_READ_REPLICA_COUNT: "2", DATABASE_READ_REPLICA_MULTI_AZ: "true", RETAIN_STATEFUL_RESOURCES: "true" },
  ] as Record<string, string>[]) {
    const templates = synth(settings);
    for (const [name, template] of Object.entries(templates)) assert.equal(findCycle(resourceGraph(template)), undefined, `${name} has no resource dependency cycle`);
    const database = templates["example-RdsStack"]!;
    const network = templates["example-NetworkStack"]!;
    const workloads = templates.Lambdas!;
    const proxyEnabled = settings.DATABASE_PROXY_ENABLED === "true";
    const replicaCount = Number(settings.DATABASE_READ_REPLICA_COUNT ?? 0);
    const retain = settings.RETAIN_STATEFUL_RESOURCES === "true";
    const writerId = "PostgresDatabase0A8A7373";
    const writer = database.Resources[writerId]!;
    assert.equal(writer.Type, "AWS::RDS::DBInstance");
    assert.equal(writer.Properties.MultiAZ, settings.DATABASE_MULTI_AZ === "true");
    assert.equal(writer.Properties.DBInstanceClass, "db.t3.micro");
    assert.equal(writer.Properties.StorageType, "gp2");
    assert.equal(writer.DeletionPolicy, retain ? "Retain" : "Snapshot");
    assert.ok(network.Resources.DatabaseClientsD3CE02C8, "original direct-client group identity");
    assert.ok(database.Resources.FrameworkDatabaseLoginD6767A56, "original bootstrap identity");
    assert.equal(database.Outputs.RdsDatabaseEndpoint.Export.Name, "example-RdsStack:RdsDatabaseEndpoint");
    const replicas = resourcesOf(database, "AWS::RDS::DBInstance").filter(([id]) => id !== writerId);
    assert.equal(replicas.length, replicaCount);
    for (const [index, [id, replica]] of replicas.entries()) {
      assert.ok(id.startsWith(`ReadReplica${index + 1}`));
      assert.match(serialized(replica.Properties.SourceDBInstanceIdentifier), /PostgresDatabase0A8A7373/);
      assert.equal(writer.Properties.StorageEncrypted, true);
      assert.equal(replica.Properties.StorageEncrypted, undefined, "replica encryption inherits from the writer");
      assert.equal(replica.Properties.AllocatedStorage, undefined, "initial allocation inherits the actual writer size");
      assert.equal(replica.Properties.StorageType, "gp2");
      assert.equal(replica.Properties.MultiAZ, settings.DATABASE_READ_REPLICA_MULTI_AZ === "true");
      assert.equal(replica.DeletionPolicy, retain ? "Retain" : "Delete");
    }
    const functions = resourcesOf(workloads, "AWS::Lambda::Function");
    const [applicationId, application] = functions.find(([id]) => id.startsWith("VerifySession"))!;
    const [directId, direct] = functions.find(([id]) => id.startsWith("SignOut"))!;
    assert.ok(applicationId && directId);
    const appEnv = application.Properties.Environment.Variables;
    const directEnv = direct.Properties.Environment.Variables;
    assert.match(serialized(appEnv.PRIMARY_DATABASE_URL), proxyEnabled ? /DatabaseProxy/ : /PostgresDatabase/);
    assert.match(serialized(directEnv.PRIMARY_DATABASE_URL), /PostgresDatabase/);
    assert.equal(appEnv.PRIMARY_DATABASE_AUTH, "iam");
    assert.equal(directEnv.PRIMARY_DATABASE_READ_URLS, undefined);
    assert.equal(appEnv.PRIMARY_DATABASE_POOL_OPTIONS, '{"maxConnections":10,"connectionTimeoutMs":20000,"idleTimeoutMs":30000}');
    assert.equal(application.Properties.VpcConfig.SecurityGroupIds.length, 1 + (replicaCount ? 1 : 0));
    assert.equal(direct.Properties.VpcConfig.SecurityGroupIds.length, 1);
    if (replicaCount) assert.match(serialized(appEnv.PRIMARY_DATABASE_READ_URLS), /ReadReplica1/);
    else assert.equal(appEnv.PRIMARY_DATABASE_READ_URLS, "[]");
    const policies = resourcesOf(workloads, "AWS::IAM::Policy");
    const appPolicy = policies.find(([id]) => id.startsWith("VerifySession"))![1];
    const directPolicy = policies.find(([id]) => id.startsWith("SignOut"))![1];
    assert.doesNotMatch(serialized(appPolicy), /secretsmanager:GetSecretValue/);
    assert.doesNotMatch(serialized(directPolicy), /secretsmanager:GetSecretValue/);
    assert.match(serialized(appPolicy), /rds-db:connect/);
    assert.match(serialized(appPolicy), /app_user/);
    assert.doesNotMatch(serialized(appPolicy), /dbuser:\*/);
    assert.doesNotMatch(serialized(directPolicy), /DatabaseProxy|ReadReplica/);
    if (proxyEnabled) {
      assert.doesNotMatch(serialized(appPolicy), /PostgresDatabase/);
      const proxy = resourcesOf(database, "AWS::RDS::DBProxy")[0]![1];
      assert.equal(proxy.Properties.DefaultAuthScheme, "IAM_AUTH");
      assert.equal(proxy.Properties.RequireTLS, true);
      assert.equal(proxy.Properties.Auth, undefined, "end-to-end IAM supplies no secret authentication entries");
      const target = resourcesOf(database, "AWS::RDS::DBProxyTargetGroup")[0]![1];
      assert.ok(target.DependsOn!.includes("FrameworkDatabaseLoginD6767A56"));
      assert.deepEqual(target.Properties.DBInstanceIdentifiers, [{ Ref: writerId }]);
      assert.equal(target.Properties.ConnectionPoolConfigurationInfo.MaxConnectionsPercent, 90);
      assert.equal(target.Properties.ConnectionPoolConfigurationInfo.ConnectionBorrowTimeout, 15);
      const proxyPolicy = resourcesOf(database, "AWS::IAM::Policy").find(([id]) => id.startsWith("DatabaseProxyRole"))![1];
      assert.match(serialized(proxyPolicy), /rds-db:connect/);
      assert.match(serialized(proxyPolicy), /PostgresDatabase.*DbiResourceId/);
      assert.doesNotMatch(serialized(proxyPolicy), /secretsmanager/);
      assert.ok(resourcesOf(network, "AWS::EC2::SecurityGroup").some(([id]) => id.startsWith("DatabaseProxyClients")));
    } else assert.equal(resourcesOf(database, "AWS::RDS::DBProxy").length, 0);
    const ingress = resourcesOf(database, "AWS::EC2::SecurityGroupIngress");
    if (replicaCount) {
      assert.match(serialized(appPolicy), /ReadReplica1.*DbiResourceId/);
      const readerIngress = ingress.filter(([id]) => id.startsWith("ReadReplica"));
      assert.equal(readerIngress.length, replicaCount);
      assert.ok(readerIngress.every(([, rule]) => /DatabaseReaderClients/.test(serialized(rule))));
    }
    if (proxyEnabled) {
      const proxyIngress = ingress.filter(([id]) => id.startsWith("DatabaseProxy"));
      assert.equal(proxyIngress.length, 1);
      assert.ok(proxyIngress.every(([, rule]) => /DatabaseProxyClients/.test(serialized(rule))));
      assert.ok(ingress.filter(([id]) => id.startsWith("PostgresDatabase")).every(([, rule]) => !/DatabaseProxyClients|DatabaseReaderClients/.test(serialized(rule))));
    }
    const bootstrap = resourcesOf(database, "AWS::Lambda::Function").find(([id]) => id.startsWith("FrameworkDatabaseLoginHandler"))![1];
    assert.equal(bootstrap.Properties.VpcConfig.SecurityGroupIds.length, 1);
    assert.match(serialized(bootstrap.Properties.VpcConfig), /DatabaseClientsD3CE02C8/);
  }
});


test("managed database source owns writer, replica and Proxy settings with unchanged construct scopes", () => {
  const authored = {
    subnet: "private",
    settings: {
      instanceClass: "db.m7g.large", multiAz: true,
      readReplicaCount: 1, readReplicaMultiAz: true, proxyEnabled: true,
      storageType: "gp3", allocatedStorage: 400, maxAllocatedStorage: 1000,
      iops: 12000, throughput: 500, backupRetentionDays: 14,
    },
  };
  const templates = synth({ FRAMEWORK_DATABASE_DECLARATION: JSON.stringify(authored) });
  const database = templates["example-RdsStack"]!;
  const writer = database.Resources.PostgresDatabase0A8A7373!;
  assert.equal(writer.Type, "AWS::RDS::DBInstance");
  assert.equal(writer.Properties.DBInstanceClass, "db.m7g.large");
  assert.equal(writer.Properties.MultiAZ, true);
  assert.equal(writer.Properties.StorageType, "gp3");
  assert.equal(writer.Properties.AllocatedStorage, "400");
  assert.equal(writer.Properties.Iops, 12000);
  assert.equal(writer.Properties.StorageThroughput, 500);
  assert.equal(writer.Properties.BackupRetentionPeriod, 14);
  assert.equal(writer.Properties.EnableIAMDatabaseAuthentication, true);
  assert.equal(writer.Properties.PubliclyAccessible, false);
  const subnetGroup = resourcesOf(database, "AWS::RDS::DBSubnetGroup")[0]![1];
  assert.match(serialized(subnetGroup.Properties.SubnetIds), /privateSubnet/);
  assert.doesNotMatch(serialized(subnetGroup.Properties.SubnetIds), /isolatedSubnet/);
  const replica = resourcesOf(database, "AWS::RDS::DBInstance").find(([id]) => id.startsWith("ReadReplica1"))![1];
  assert.equal(replica.Properties.DBInstanceClass, "db.m7g.large");
  assert.equal(replica.Properties.MultiAZ, true);
  assert.equal(resourcesOf(database, "AWS::RDS::DBProxy").length, 1);
  assert.ok(database.Resources.FrameworkDatabaseLoginD6767A56, "the declaration never introduces another scope around bootstrap");
  assert.equal(database.Outputs.RdsDatabaseEndpoint.Export.Name, "example-RdsStack:RdsDatabaseEndpoint");
});

test("source declarations preserve complete default and Multi-AZ/replica/Proxy synthesized templates", () => {
  const cases = [
    {
      settings: { engineVersion: "16", instanceClass: "db.t3.micro", storageType: "gp2", allocatedStorage: 20, maxAllocatedStorage: 100, backupRetentionDays: 7, multiAz: false, readReplicaCount: 0, proxyEnabled: false },
      env: {},
    },
    {
      settings: { multiAz: true, readReplicaCount: 2, readReplicaMultiAz: true, proxyEnabled: true },
      env: { DATABASE_MULTI_AZ: "true", DATABASE_READ_REPLICA_COUNT: "2", DATABASE_READ_REPLICA_MULTI_AZ: "true", DATABASE_PROXY_ENABLED: "true" },
    },
  ] as const;
  for (const item of cases) {
    const before = synth(item.env);
    const after = synth({ FRAMEWORK_DATABASE_DECLARATION: JSON.stringify({ settings: item.settings }) });
    assert.deepEqual(after, before, "source ownership must preserve every database/network/workload logical ID, property and output");
  }
});
