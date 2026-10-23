import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { discoverStatefulReference, inspectStatefulReference, type StatefulAwsReader } from "../../scripts/stateful-references";
import { recordRetainedResources } from "../../scripts/retained-resources";
import { databaseReference as reference } from "./support/database-reference";

const destination = { account: reference.account, region: reference.region, deployment: "replacement", mode: "prod" as const };
const aws = { region: reference.region };
const tags = [
  { Key: "framework:owner", Value: "matts-aws-framework" },
  { Key: "framework:deployment", Value: reference.sourceDeployment },
  { Key: "framework:mode", Value: "prod" },
];

/** Independent fixture uses RDS-managed master-secret metadata rather than the
 * implementation author's CDK-secret ledger path, exercising both mechanisms. */
function fixture() {
  const state = {
    account: reference.account, sourceStatus: "DELETE_COMPLETE", sourceResources: [{ PhysicalResourceId: reference.instanceIdentifier, StackId: reference.sourceStackId }], activeStacks: [] as any[], templates: {} as Record<string, any>,
    db: { DBInstanceIdentifier: reference.instanceIdentifier, DBInstanceArn: `arn:aws:rds:${reference.region}:${reference.account}:db:${reference.instanceIdentifier}`, DBInstanceStatus: "available", Engine: "postgres", EngineVersion: reference.engineVersion, DbiResourceId: reference.instanceResourceId, Endpoint: { Address: reference.endpoint, Port: reference.port }, DBName: reference.databaseName, IAMDatabaseAuthenticationEnabled: true, PubliclyAccessible: false, StorageEncrypted: true, PendingModifiedValues: {}, KmsKeyId: reference.kmsKeyArn, MasterUserSecret: { SecretArn: reference.masterSecretArn }, DBSubnetGroup: { SubnetGroupStatus: "Complete", VpcId: reference.network.vpcId, Subnets: reference.network.isolatedSubnetIds.map(SubnetIdentifier => ({ SubnetIdentifier, SubnetStatus: "Active" })) }, VpcSecurityGroups: reference.securityGroupIds.map(VpcSecurityGroupId => ({ VpcSecurityGroupId, Status: "active" })) },
    subnets: (["public", "private", "isolated"] as const).flatMap(tier => reference.network[`${tier}SubnetIds`].map((SubnetId, index) => ({ SubnetId, VpcId: reference.network.vpcId, State: "available", OwnerId: reference.account, AvailabilityZone: reference.network.availabilityZones[index], Ipv6CidrBlockAssociationSet: [{ Ipv6CidrBlockState: { State: "associated" } }], Tags: [{ Key: "aws-cdk:subnet-type", Value: tier[0]!.toUpperCase() + tier.slice(1) }] }))),
    groups: reference.securityGroupIds.map(GroupId => ({ GroupId, VpcId: reference.network.vpcId, OwnerId: reference.account })),
  };
  const calls: string[] = [];
  const read: StatefulAwsReader = args => {
    const key = args.slice(0, 2).join(" "); calls.push(key);
    if (key === "sts get-caller-identity") return { Account: state.account };
    if (key === "rds describe-db-instances") return { DBInstances: [state.db] };
    if (key === "rds list-tags-for-resource") return { TagList: tags };
    if (key === "cloudformation describe-stack-resources") return { StackResources: state.sourceResources };
    if (key === "cloudformation describe-stacks") return { Stacks: args.includes("--stack-name") ? [{ StackId: reference.sourceStackId, StackStatus: state.sourceStatus, Tags: tags }] : state.activeStacks };
    if (key === "cloudformation get-template") return { TemplateBody: state.templates[args[args.indexOf("--stack-name") + 1]!] };
    if (key === "ec2 describe-vpcs") return { Vpcs: [{ VpcId: reference.network.vpcId, State: "available", OwnerId: reference.account, CidrBlock: reference.network.vpcCidrBlock }] };
    if (key === "ec2 describe-vpc-attribute") return { EnableDnsSupport: { Value: true }, EnableDnsHostnames: { Value: true } };
    if (key === "ec2 describe-subnets") return { Subnets: state.subnets };
    if (key === "ec2 describe-route-tables") return { RouteTables: (["public", "private", "isolated"] as const).flatMap(tier => reference.network[`${tier}SubnetRouteTableIds`].map((RouteTableId, index) => ({ RouteTableId, Associations: [{ SubnetId: reference.network[`${tier}SubnetIds`][index] }], Routes: [{ State: "active", GatewayId: "local" }] }))) };
    if (key === "ec2 describe-security-groups") return { SecurityGroups: state.groups };
    if (key === "ec2 describe-vpc-endpoints") return { VpcEndpoints: [] };
    if (key === "kms describe-key") return { KeyMetadata: { Enabled: true, KeyState: "Enabled", AWSAccountId: reference.account, Arn: reference.kmsKeyArn } };
    if (key === "secretsmanager describe-secret") return { ARN: reference.masterSecretArn, Tags: tags };
    throw new Error(`Unexpected read ${args.join(" ")}`);
  };
  return { state, read, calls };
}

test("independent RDS inspection refuses wrong account, SQL/IAM incompatibility and detached network identities", () => {
  const scratch = path.resolve(__dirname, "../../.cache"); mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(path.join(scratch, "db-review-"));
  try {
    const healthy = fixture();
    assert.deepEqual(discoverStatefulReference("database", reference.instanceIdentifier, reference.sourceDeployment, aws, destination, undefined, healthy.read, directory).reference, reference);
    const failures: Array<(state: ReturnType<typeof fixture>["state"]) => void> = [
      state => { state.account = "999988887777"; },
      state => { state.sourceStatus = "UPDATE_COMPLETE"; },
      state => { state.db.IAMDatabaseAuthenticationEnabled = false; },
      state => { state.db.PubliclyAccessible = true; },
      state => { state.db.StorageEncrypted = false; },
      state => { state.db.Engine = "aurora-postgresql"; },
      state => { state.subnets[0]!.Ipv6CidrBlockAssociationSet = []; },
      state => { state.subnets.push({ ...state.subnets[0]! }); },
      state => { state.groups[0]!.VpcId = "vpc-fffffffffffffffff"; },
      state => { state.groups[0]!.OwnerId = "999988887777"; },
      state => {
        state.activeStacks = [{ StackId: "other-reference", StackStatus: "UPDATE_COMPLETE", Tags: tags.map(tag => tag.Key === "framework:deployment" ? { ...tag, Value: "other" } : tag) }];
        state.templates["other-reference"] = { Metadata: { "framework:stateful-reference": { kind: "database", reference } } };
      },
    ];
    for (const corrupt of failures) {
      const f = fixture(); corrupt(f.state);
      assert.throws(() => discoverStatefulReference("database", reference.instanceIdentifier, reference.sourceDeployment, aws, destination, undefined, f.read, directory));
      assert.ok(f.calls.every(call => /^(sts get-|\S+ (get-|describe-|list-))/.test(call)), "inspection performs only reads");
    }
    const changed = fixture(); changed.state.db.DbiResourceId = "db-REPLACED1234";
    assert.throws(() => inspectStatefulReference("database", reference, aws, destination, changed.read, directory), /changed since inspection/);
    assert.throws(() => discoverStatefulReference("database", reference.instanceIdentifier, reference.sourceDeployment, aws, { ...destination, mode: "dev" }, undefined, healthy.read, directory), /prod mode/);
  } finally { assert.ok(directory.startsWith(scratch + path.sep)); rmSync(directory, { recursive: true }); }
});

test("independent interrupted-teardown evidence cannot replace exact release proof", () => {
  const scratch = path.resolve(__dirname, "../../.cache"); mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(path.join(scratch, "db-interrupted-"));
  try {
    recordRetainedResources(directory, { account: reference.account, region: reference.region, deployment: reference.sourceDeployment, mode: "prod" }, {
      reviewDigest: "independent-review", createdAt: new Date().toISOString(), phase: "teardown-failed", completedStackIds: [],
      resources: [{ stack: "original-RdsStack", stackId: reference.sourceStackId, logicalId: "Database", type: "AWS::RDS::DBInstance", policy: "Retain", physicalId: reference.instanceIdentifier, templateDigest: "reviewed-template" }],
    });
    const f = fixture(); f.state.sourceResources = []; f.state.sourceStatus = "DELETE_FAILED";
    assert.throws(() => discoverStatefulReference("database", reference.instanceIdentifier, reference.sourceDeployment, aws, destination, undefined, f.read, directory), /delet|release|managed|complete/i);
  } finally { assert.ok(directory.startsWith(scratch + path.sep)); rmSync(directory, { recursive: true }); }
});
