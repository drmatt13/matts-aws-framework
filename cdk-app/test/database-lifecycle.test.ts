import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertDatabaseReference } from "../lib/app/database-lifecycle";
import { databaseReference as reference } from "./support/database-reference";

function synth(settings: Record<string, string> = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "framework-retained-rds-"));
  try {
    const inputs = path.join(directory, "inputs.env");
    const output = path.join(directory, "templates.json");
    writeFileSync(inputs, "CDK_APP_NAME=example\n");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DATABASE_") && !key.startsWith("FRAMEWORK_DATABASE_") && key !== "RETAIN_STATEFUL_RESOURCES"));
    const result = spawnSync(process.execPath, ["--import", "tsx", path.join(__dirname, "fixtures/database-synth.ts"), output], {
      env: { ...env, FRAMEWORK_MODE: "prod", FRAMEWORK_INPUTS_FILE: inputs, ...settings }, encoding: "utf8", timeout: 90_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(readFileSync(output, "utf8")) as Record<string, { Resources: Record<string, { Type: string; Properties: any; DeletionPolicy?: string; UpdateReplacePolicy?: string }>; Outputs: any }>;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("retained reference rejects ambiguous identity, wrong destination and incomplete dependencies", () => {
  assert.doesNotThrow(() => assertDatabaseReference(reference, { account: reference.account, region: reference.region, mode: "prod" }));
  for (const patch of [
    { strategy: "import" }, { account: "222233334444" }, { region: "us-west-2" },
    { sourceStackId: "original-RdsStack" }, { instanceResourceId: "original-postgres" }, { engine: "aurora-postgresql" },
    { endpoint: "user:password@host" }, { endpoint: "original.abcdefghijkl.us-west-2.rds.amazonaws.com" },
    { iamAuthentication: false }, { iamLogin: "postgres" }, { storageEncrypted: false }, { securityGroupIds: [] },
    { masterSecretArn: "password" }, { kmsKeyArn: "alias/aws/rds" },
    { password: "credentials-must-never-enter-source" },
    { network: { ...reference.network, isolatedSubnetIds: [] } },
    { network: { ...reference.network, privateSubnetIds: reference.network.publicSubnetIds } },
  ]) assert.throws(() => assertDatabaseReference({ ...reference, ...patch }, { account: reference.account, region: reference.region }));
  assert.throws(() => assertDatabaseReference(reference, { account: reference.account, region: reference.region, mode: "dev" }), /Compose/);
});

test("database retention preserves its complete network and database dependencies with existing logical identities", () => {
  const templates = synth({ RETAIN_STATEFUL_RESOURCES: "true" });
  const database = templates["example-RdsStack"]!;
  assert.equal(database.Resources.PostgresDatabase0A8A7373!.Type, "AWS::RDS::DBInstance");
  for (const resource of Object.values(templates["example-NetworkStack"]!.Resources)) {
    assert.equal(resource.DeletionPolicy, "Retain", resource.Type);
    assert.equal(resource.UpdateReplacePolicy, "Retain", resource.Type);
  }
  const dependencyTypes = ["AWS::EC2::SecurityGroup", "AWS::RDS::DBSubnetGroup", "AWS::SecretsManager::Secret", "AWS::SecretsManager::SecretTargetAttachment"];
  for (const type of dependencyTypes) {
    const resources = Object.values(database.Resources).filter(resource => resource.Type === type);
    assert.ok(resources.length, type);
    for (const resource of resources) assert.equal(resource.DeletionPolicy, "Retain", type);
  }
  assert.equal(database.Outputs.RdsDatabaseEndpoint.Export.Name, "example-RdsStack:RdsDatabaseEndpoint");
});

test("reference reuses original VPC and physical database while generating narrow IAM and only new application support", () => {
  const templates = synth({ FRAMEWORK_DATABASE_REFERENCE: JSON.stringify(reference) });
  const resources = Object.values(templates).flatMap(template => Object.values(template.Resources));
  for (const type of ["AWS::RDS::DBInstance", "AWS::RDS::DBCluster", "AWS::EC2::VPC", "AWS::EC2::Subnet", "AWS::SecretsManager::Secret", "Custom::DatabaseLogin"]) assert.equal(resources.filter(resource => resource.Type === type).length, 0, type);
  const lambdas = resources.filter(resource => resource.Type === "AWS::Lambda::Function");
  assert.equal(lambdas.length, 2);
  for (const lambda of lambdas) {
    assert.equal(lambda.Properties.Environment.Variables.PRIMARY_DATABASE_AUTH, "iam");
    assert.equal(lambda.Properties.Environment.Variables.PRIMARY_DATABASE_URL, `postgresql://app_user@${reference.endpoint}:5432/app_db`);
    assert.deepEqual(lambda.Properties.VpcConfig.SubnetIds, reference.network.privateSubnetIds);
  }
  const policies = JSON.stringify(resources.filter(resource => resource.Type === "AWS::IAM::Policy"));
  assert.match(policies, new RegExp(`dbuser:${reference.instanceResourceId}/app_user`));
  assert.doesNotMatch(policies, /secretsmanager:GetSecretValue|dbuser:\*/);
  const ingress = resources.filter(resource => resource.Type === "AWS::EC2::SecurityGroupIngress");
  assert.ok(ingress.some(resource => resource.Properties.GroupId === reference.securityGroupIds[0] && resource.Properties.FromPort === 5432));
  assert.equal(templates["example-RdsStack"]!.Outputs.RdsDatabaseEndpoint.Export.Name, "example-RdsStack:RdsDatabaseEndpoint");
});

test("an unused retained database and VPC reference still synthesize deployable nonempty stacks", () => {
  const templates = synth({ FRAMEWORK_DATABASE_REFERENCE: JSON.stringify(reference), FRAMEWORK_DATABASE_NO_CONSUMERS: "true" });
  for (const name of ["example-RdsStack", "example-NetworkStack"]) {
    const resources = Object.values(templates[name]!.Resources);
    assert.ok(resources.length > 0, `${name} cannot be an output-only CloudFormation template`);
    assert.ok(resources.some(resource => resource.Type === "AWS::SSM::Parameter"), "non-secret reference identity marker keeps the stack deployable");
    assert.ok(resources.every(resource => !["AWS::RDS::DBInstance", "AWS::EC2::VPC", "AWS::EC2::Subnet", "Custom::DatabaseLogin"].includes(resource.Type)));
  }
});
