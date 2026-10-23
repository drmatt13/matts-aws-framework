import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { statefulTeardownConsequences } from "../../scripts/stateful-teardown";
import { readRetainedResources, recordRetainedResources, retainedResourcesFile } from "../../scripts/retained-resources";

test("deployed retained database refuses deleted network/security/secret dependencies", () => {
  const resources: Record<string, any> = {
    Database: { Type: "AWS::RDS::DBInstance", DeletionPolicy: "Retain", Properties: { DBSubnetGroupName: { Ref: "Subnets" }, VPCSecurityGroups: [{ "Fn::GetAtt": ["Group", "GroupId"] }], MasterUserPassword: { "Fn::Sub": "{{resolve:secretsmanager:${Secret}:SecretString:password}}" } } },
    Subnets: { Type: "AWS::RDS::DBSubnetGroup", Properties: { SubnetIds: [{ Ref: "Subnet" }] } },
    Subnet: { Type: "AWS::EC2::Subnet", Properties: { VpcId: { "Fn::ImportValue": "original-vpc" } } },
    Group: { Type: "AWS::EC2::SecurityGroup", Properties: { VpcId: { "Fn::ImportValue": "original-vpc" } } },
    Secret: { Type: "AWS::SecretsManager::Secret" },
  };
  const network = { Resources: { Vpc: { Type: "AWS::EC2::VPC" }, Route: { Type: "AWS::EC2::Route", Properties: { VpcId: { Ref: "Vpc" } } } }, Outputs: { Vpc: { Value: { Ref: "Vpc" }, Export: { Name: "original-vpc" } } } };
  const templates = new Map<string, any>([["Rds", { Resources: resources }], ["Network", network]]);
  const unsafe = statefulTeardownConsequences(templates);
  for (const id of ["Rds/Subnets", "Rds/Group", "Rds/Secret", "Network/Vpc", "Network/Route"]) assert.ok(unsafe.blockers.some(message => message.includes(id)), id);
  for (const template of templates.values()) for (const resource of Object.values<any>(template.Resources)) resource.DeletionPolicy = "Retain";
  assert.deepEqual(statefulTeardownConsequences(templates).blockers, []);
});
test("retained evidence rejects wrong deployment, corrupt fields and linked ancestors", () => {
  const scratch = path.resolve(__dirname, "../../.cache"); mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(path.join(scratch, "retained-ledger-guard-"));
  try {
    const file = retainedResourcesFile(directory, "734849394764", "us-east-1", "original");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, account: "734849394764", region: "us-east-1", deployment: "different", mode: "prod", observations: [] }));
    assert.throws(() => readRetainedResources(directory, "734849394764", "us-east-1"), /invalid/);
    writeFileSync(file, JSON.stringify({ version: 1, account: "734849394764", region: "us-east-1", deployment: "original", mode: "unknown", observations: [] }));
    assert.throws(() => readRetainedResources(directory, "734849394764", "us-east-1"), /invalid/);
    rmSync(file);
    rmSync(path.join(directory, ".framework"), { recursive: true });
    // A dangling junction must be detected with lstat rather than existsSync.
    symlinkSync(path.join(directory, "missing-target"), path.join(directory, ".framework"), "junction");
    assert.throws(() => retainedResourcesFile(directory, "734849394764", "us-east-1", "original"), /linked/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("retained pool refuses deleted cross-stack Lambda trigger and describes deleted clients", () => {
  const templates = new Map([
    ["Cognito", { Resources: { Pool: { Type: "AWS::Cognito::UserPool", DeletionPolicy: "Retain", Properties: { LambdaConfig: { PreSignUp: { "Fn::ImportValue": "signup-arn" } } } }, Client: { Type: "AWS::Cognito::UserPoolClient", Properties: { UserPoolId: { Ref: "Pool" } } } } }],
    ["Events", { Resources: { Signup: { Type: "AWS::Lambda::Function" } }, Outputs: { Signup: { Export: { Name: "signup-arn" }, Value: { "Fn::GetAtt": ["Signup", "Arn"] } } } }],
  ]);
  const consequences = statefulTeardownConsequences(templates);
  assert.match(consequences.blockers.join(" "), /Events\/Signup.*trigger|trigger.*Events\/Signup/);
  assert.match(consequences.warnings.join(" "), /Cognito\/Client/);
});
test("retained trigger function cannot outlive deleted IAM, permission, KMS or network dependencies", () => {
  const templates = new Map<string, any>([["Auth", { Resources: {
    Pool: { Type: "AWS::Cognito::UserPool", DeletionPolicy: "Retain", Properties: { LambdaConfig: { PreSignUp: { "Fn::GetAtt": ["Trigger", "Arn"] } } } },
    Trigger: { Type: "AWS::Lambda::Function", DeletionPolicy: "Retain", Properties: { Role: { "Fn::GetAtt": ["Role", "Arn"] }, KmsKeyArn: { Ref: "Key" }, VpcConfig: { SecurityGroupIds: [{ Ref: "Group" }] } } },
    Role: { Type: "AWS::IAM::Role" },
    Policy: { Type: "AWS::IAM::Policy", Properties: { Roles: [{ Ref: "Role" }] } },
    Permission: { Type: "AWS::Lambda::Permission", Properties: { FunctionName: { Ref: "Trigger" }, SourceArn: { "Fn::GetAtt": ["Pool", "Arn"] } } },
    Key: { Type: "AWS::KMS::Key" },
    Group: { Type: "AWS::EC2::SecurityGroup", Properties: { VpcId: { Ref: "Vpc" } } },
    Vpc: { Type: "AWS::EC2::VPC" },
  } }]]);
  const unsafe = statefulTeardownConsequences(templates);
  for (const id of ["Role", "Policy", "Permission", "Key", "Group", "Vpc"]) assert.ok(unsafe.blockers.some(message => message.includes("Auth/" + id)), id);
  for (const resource of Object.values<any>(templates.get("Auth").Resources)) resource.DeletionPolicy = "Retain";
  assert.deepEqual(statefulTeardownConsequences(templates).blockers, []);
  templates.get("Auth").Resources.Pool.Properties.LambdaConfig.PreSignUp = "arn:aws:lambda:us-east-1:111122223333:function:unresolved";
  assert.match(statefulTeardownConsequences(templates).blockers.join(" "), /external or unresolved identity/);
});
test("retained evidence survives source removal, preserves earlier attempts, and rejects path traversal", () => {
  const scratch = path.resolve(__dirname, "../../.cache"); mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(path.join(scratch, "retained-ledger-"));
  try {
    const identity = { account: "734849394764", region: "us-east-1", deployment: "original", mode: "prod" as const };
    const stackId = "arn:aws:cloudformation:us-east-1:734849394764:stack/original-RdsStack/exact-stack-id";
    const observation = { reviewDigest: "digest", createdAt: new Date().toISOString(), phase: "before-teardown" as const, resources: [{ stack: "original-RdsStack", stackId, logicalId: "Database", type: "AWS::RDS::DBInstance", policy: "Retain", physicalId: "original-db", templateDigest: "template" }], completedStackIds: [] };
    recordRetainedResources(directory, identity, observation);
    recordRetainedResources(directory, identity, { ...observation, phase: "teardown-failed", problem: "partial deletion", completedStackIds: [stackId] });
    const ledger = readRetainedResources(directory, identity.account, identity.region)[0]!;
    assert.equal(ledger.observations.length, 2);
    assert.equal(ledger.observations[0]!.resources[0]!.physicalId, "original-db");
    assert.equal(ledger.observations[1]!.phase, "teardown-failed");
    assert.throws(() => retainedResourcesFile(directory, identity.account, identity.region, "../elsewhere"), /Invalid/);
    assert.throws(() => recordRetainedResources(directory, { ...identity, mode: "dev" }, observation), /another deployment mode/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
