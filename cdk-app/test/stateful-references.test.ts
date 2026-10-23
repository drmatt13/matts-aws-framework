import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { assertReferencedNetworkPolicy, assertStatefulOwnershipTransitions, discoverStatefulReference, inspectStatefulReference, validateAssemblyStatefulReferences, type StatefulAwsReader } from "../../scripts/stateful-references";
import { recordRetainedResources } from "../../scripts/retained-resources";
import { databaseReference } from "./support/database-reference";

const account = "111122223333";
const region = "us-east-1";
const destination = { account, region, deployment: "replacement", mode: "prod" as const };
const stackId = `arn:aws:cloudformation:${region}:${account}:stack/original-CognitoStack/exact-id`;
const tags = { "framework:owner": "matts-aws-framework", "framework:deployment": "original", "framework:mode": "prod" };
const tagArray = Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
function fixture() {
  const pool = { Id: "us-east-1_Original", Arn: `arn:aws:cognito-idp:${region}:${account}:userpool/us-east-1_Original`, UserPoolTags: { ...tags }, Domain: "original", LambdaConfig: {} };
  const client = { UserPoolId: pool.Id, ClientId: "existingclient123", AllowedOAuthFlowsUserPoolClient: true, AllowedOAuthFlows: ["code"], AllowedOAuthScopes: ["openid", "email", "profile"], ExplicitAuthFlows: ["ALLOW_USER_SRP_AUTH", "ALLOW_USER_PASSWORD_AUTH"], CallbackURLs: ["https://example.com/auth/callback"], LogoutURLs: ["https://example.com/"], SupportedIdentityProviders: ["COGNITO"] };
  const state = { stackStatus: "DELETE_COMPLETE", activeStacks: [] as any[], templates: {} as Record<string, any>, pool, client, calls: [] as string[] };
  const read: StatefulAwsReader = args => {
    const key = args.slice(0, 2).join(" "); state.calls.push(key);
    const flag = (name: string) => args[args.indexOf("--" + name) + 1];
    if (key === "sts get-caller-identity") return { Account: account };
    if (key === "cloudformation describe-stack-resources") return { StackResources: [{ PhysicalResourceId: pool.Id, StackId: stackId }] };
    if (key === "cloudformation describe-stacks") return args.includes("--stack-name") ? { Stacks: [{ StackId: stackId, StackStatus: state.stackStatus, Tags: tagArray }] } : { Stacks: state.activeStacks };
    if (key === "cloudformation get-template") return { TemplateBody: state.templates[flag("stack-name")!] };
    if (key === "cognito-idp describe-user-pool") return { UserPool: state.pool };
    if (key === "cognito-idp describe-user-pool-client") return { UserPoolClient: state.client };
    if (key === "cognito-idp describe-user-pool-domain") return { DomainDescription: { UserPoolId: pool.Id, AWSAccountId: account, Status: "ACTIVE" } };
    throw new Error("Unexpected AWS read: " + args.join(" "));
  };
  return { state, read };
}
test("Cognito inspection preserves original pool/client/domain without user or secret reads", () => {
  const { read, state } = fixture();
  const result = discoverStatefulReference("cognito", state.pool.Id, "original", { region }, destination, state.client.ClientId, read);
  assert.ok("userPoolId" in result.reference);
  assert.equal(result.reference.userPoolId, state.pool.Id);
  assert.equal(result.reference.userPoolClientId, state.client.ClientId);
  assert.equal(result.reference.userPoolDomainUrl, "https://original.auth.us-east-1.amazoncognito.com");
  assert.deepEqual(inspectStatefulReference("cognito", result.reference, { region }, destination, read).reference, result.reference);
  assert.ok(state.calls.every(key => /^(sts get-|\S+ (get-|describe-|list-))/.test(key)));
  assert.ok(!state.calls.some(key => /users|secret-value/.test(key)));
});
test("Cognito wrong ownership, missing client flow, active ownership and conflicting reference fail closed", () => {
  for (const failure of ["owner", "client", "managed", "claimed"] as const) {
    const { read, state } = fixture();
    if (failure === "owner") state.pool.UserPoolTags["framework:deployment"] = "unrelated";
    if (failure === "client") state.client.AllowedOAuthFlows = [];
    if (failure === "managed") state.stackStatus = "UPDATE_COMPLETE";
    if (failure === "claimed") {
      state.activeStacks = [{ StackId: "claimed", StackStatus: "UPDATE_COMPLETE", Tags: tagArray.map(tag => tag.Key === "framework:deployment" ? { ...tag, Value: "other" } : tag) }];
      state.templates.claimed = { Metadata: { "framework:stateful-reference": { kind: "cognito", reference: { userPoolId: state.pool.Id } } } };
    }
    assert.throws(() => discoverStatefulReference("cognito", state.pool.Id, "original", { region }, destination, state.client.ClientId, read), /ownership|authorization-code|managed|referenced/);
  }
});
test("saved reference metadata checks exact callback/logout/provider prerequisites and identity stability", () => {
  const { read, state } = fixture();
  const inspection = discoverStatefulReference("cognito", state.pool.Id, "original", { region }, destination, state.client.ClientId, read);
  const metadata = { kind: "cognito", reference: inspection.reference, callbackUrls: state.client.CallbackURLs, logoutUrls: state.client.LogoutURLs, providers: ["COGNITO"] };
  const stack = { template: { Metadata: { "framework:stateful-reference": metadata } } };
  validateAssemblyStatefulReferences([stack], { region }, destination, read);
  metadata.callbackUrls = ["https://changed.example/auth/callback"];
  assert.throws(() => validateAssemblyStatefulReferences([stack], { region }, destination, read), /intended callbackUrls/);
  assert.throws(() => inspectStatefulReference("cognito", { ...inspection.reference, userPoolDomainUrl: "https://wrong.example.com" }, { region }, destination, read), /changed since inspection/);
});
test("generated Cognito redirect prerequisites resolve only from a stable owned deployed website export", () => {
  const { read, state } = fixture();
  const inspection = discoverStatefulReference("cognito", state.pool.Id, "original", { region }, destination, state.client.ClientId, read);
  const exportStackId = `arn:aws:cloudformation:${region}:${account}:stack/replacement-Website/exact-website-id`;
  let exportAvailable = true;
  let exportOwner = "replacement";
  const exportedRead: StatefulAwsReader = args => {
    if (args[0] === "cloudformation" && args[1] === "list-exports") return { Exports: exportAvailable ? [{ Name: "website-host", Value: "example.com", ExportingStackId: exportStackId }] : [] };
    if (args[0] === "cloudformation" && args[1] === "describe-stacks" && args.includes(exportStackId)) return { Stacks: [{ StackId: exportStackId, StackStatus: "UPDATE_COMPLETE", Tags: tagArray.map(tag => tag.Key === "framework:deployment" ? { ...tag, Value: exportOwner } : tag) }] };
    return read(args, { region });
  };
  const domain = { "Fn::ImportValue": "website-host" };
  const stack = { template: { Metadata: { "framework:stateful-reference": { kind: "cognito", reference: inspection.reference, callbackUrls: [{ "Fn::Join": ["", ["https://", domain, "/auth/callback"]] }], logoutUrls: [{ "Fn::Join": ["", ["https://", domain, "/"]] }], providers: ["COGNITO"] } } } };
  assert.doesNotThrow(() => validateAssemblyStatefulReferences([stack], { region }, destination, exportedRead));
  exportAvailable = false;
  assert.throws(() => validateAssemblyStatefulReferences([stack], { region }, destination, exportedRead), /supporting website stack first/);
  exportAvailable = true; exportOwner = "other";
  assert.throws(() => validateAssemblyStatefulReferences([stack], { region }, destination, exportedRead), /stable owned stack/);
});
test("managed/reference transitions refuse identity loss before cloud writes", () => {
  const managed = { Resources: { Pool: { Type: "AWS::Cognito::UserPool" } } };
  const reference = { Metadata: { "framework:stateful-reference": { kind: "cognito", reference: { userPoolId: "original" } } } };
  assert.throws(() => assertStatefulOwnershipTransitions(managed, reference), /remove its current managed resource/);
  assert.throws(() => assertStatefulOwnershipTransitions(reference, managed), /new empty resource/);
  assert.throws(() => assertStatefulOwnershipTransitions(reference, { Metadata: { "framework:stateful-reference": { kind: "cognito", reference: { userPoolId: "different" } } } }), /physical identity/);
  assert.doesNotThrow(() => assertStatefulOwnershipTransitions(managed, managed));
});
test("reference deployment refuses missing declared default routes and endpoint associations", () => {
  const ref = databaseReference;
  const policy = { natGateway: false, egressOnlyInternetGateway: true, gatewayEndpoints: { s3: true, dynamodb: true }, interfaceEndpoints: [] };
  const tables = (["public", "private", "isolated"] as const).flatMap(tier => ref.network[`${tier}SubnetRouteTableIds`].map(RouteTableId => ({ RouteTableId, Routes: tier === "public" ? [{ State: "active", DestinationCidrBlock: "0.0.0.0/0", GatewayId: "igw-123" }, { State: "active", DestinationIpv6CidrBlock: "::/0", GatewayId: "igw-123" }] : tier === "private" ? [{ State: "active", DestinationIpv6CidrBlock: "::/0", EgressOnlyInternetGatewayId: "eigw-123" }] : [] })));
  const allTables = tables.map(table => table.RouteTableId);
  const endpoints = ["s3", "dynamodb"].map(service => ({ VpcEndpointType: "Gateway", ServiceName: `com.amazonaws.us-east-1.${service}`, State: "available", RouteTableIds: [...allTables] }));
  const read: StatefulAwsReader = args => args[1] === "describe-route-tables" ? { RouteTables: tables } : { VpcEndpoints: endpoints };
  assert.doesNotThrow(() => assertReferencedNetworkPolicy(ref, policy, { region }, read));
  const saved = tables[2]!.Routes;
  tables[2]!.Routes = [];
  assert.throws(() => assertReferencedNetworkPolicy(ref, policy, { region }, read), /IPv6 egress/);
  tables[2]!.Routes = saved;
  endpoints[0]!.RouteTableIds.pop();
  assert.throws(() => assertReferencedNetworkPolicy(ref, policy, { region }, read), /s3 gateway endpoint/);
});
test("RDS live inspection resolves original network, encrypted instance and linked retained secret", () => {
  const scratch = path.resolve(__dirname, "../../.cache"); mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(path.join(scratch, "stateful-reference-"));
  const ref = databaseReference;
  let broken = "";
  const calls: string[] = [];
  const read: StatefulAwsReader = args => {
    const key = args.slice(0, 2).join(" "); calls.push(key);
    if (key === "sts get-caller-identity") return { Account: account };
    if (key === "rds describe-db-instances") return { DBInstances: [{ DBInstanceIdentifier: ref.instanceIdentifier, DBInstanceArn: `arn:aws:rds:${region}:${account}:db:${ref.instanceIdentifier}`, DBInstanceStatus: "available", Engine: ref.engine, EngineVersion: ref.engineVersion, IAMDatabaseAuthenticationEnabled: true, StorageEncrypted: true, PubliclyAccessible: false, PendingModifiedValues: {}, DBSubnetGroup: { SubnetGroupStatus: "Complete", VpcId: ref.network.vpcId, Subnets: ref.network.isolatedSubnetIds.map(SubnetIdentifier => ({ SubnetIdentifier, SubnetStatus: "Active" })) }, VpcSecurityGroups: ref.securityGroupIds.map(VpcSecurityGroupId => ({ VpcSecurityGroupId, Status: "active" })), KmsKeyId: ref.kmsKeyArn, DbiResourceId: ref.instanceResourceId, Endpoint: { Address: ref.endpoint, Port: ref.port }, DBName: ref.databaseName }] };
    if (key === "rds list-tags-for-resource") return { TagList: tagArray };
    if (key === "cloudformation describe-stack-resources") return { StackResources: [{ PhysicalResourceId: ref.instanceIdentifier, StackId: ref.sourceStackId }] };
    if (key === "cloudformation describe-stacks") return args.includes("--stack-name") ? { Stacks: [{ StackId: ref.sourceStackId, StackStatus: "DELETE_COMPLETE", Tags: tagArray }] } : { Stacks: [] };
    if (key === "ec2 describe-vpcs") return { Vpcs: [{ State: "available", OwnerId: account, CidrBlock: ref.network.vpcCidrBlock }] };
    if (key === "ec2 describe-vpc-attribute") return { EnableDnsSupport: { Value: broken !== "dns" }, EnableDnsHostnames: { Value: broken !== "dns" } };
    if (key === "ec2 describe-subnets") return { Subnets: ["public", "private", "isolated"].flatMap(tier => (ref.network as any)[tier + "SubnetIds"].map((SubnetId: string, index: number) => ({ SubnetId, State: "available", OwnerId: account, AvailabilityZone: ref.network.availabilityZones[index], Ipv6CidrBlockAssociationSet: [{ Ipv6CidrBlockState: { State: "associated" } }], Tags: [{ Key: "aws-cdk:subnet-type", Value: tier[0]!.toUpperCase() + tier.slice(1) }] }))) };
    if (key === "ec2 describe-route-tables") return { RouteTables: ["public", "private", "isolated"].flatMap(tier => (ref.network as any)[tier + "SubnetRouteTableIds"].map((RouteTableId: string, index: number) => ({ RouteTableId, Associations: [{ SubnetId: (ref.network as any)[tier + "SubnetIds"][index] }], Routes: [{ State: broken === "routes" ? "blackhole" : "active" }] }))) };
    if (key === "ec2 describe-vpc-endpoints") return { VpcEndpoints: [] };
    if (key === "ec2 describe-security-groups") return { SecurityGroups: ref.securityGroupIds.map(GroupId => ({ GroupId, VpcId: ref.network.vpcId, OwnerId: account })) };
    if (key === "kms describe-key") return { KeyMetadata: { Enabled: true, KeyState: broken === "kms" ? "PendingDeletion" : "Enabled", AWSAccountId: account, Arn: ref.kmsKeyArn } };
    if (key === "secretsmanager describe-secret") return { ARN: ref.masterSecretArn, Tags: tagArray, ...(broken === "secret" ? { DeletedDate: new Date().toISOString() } : {}) };
    throw new Error("Unexpected AWS read " + args.join(" "));
  };
  try {
    recordRetainedResources(directory, { account, region, deployment: "original", mode: "prod" }, { reviewDigest: "digest", createdAt: new Date().toISOString(), phase: "teardown-completed", completedStackIds: [ref.sourceStackId], resources: [{ stack: "original-RdsStack", stackId: ref.sourceStackId, logicalId: "Database", type: "AWS::RDS::DBInstance", policy: "Retain", physicalId: ref.instanceIdentifier, templateDigest: "template", dependencyPhysicalIds: [ref.masterSecretArn] }, { stack: "original-RdsStack", stackId: ref.sourceStackId, logicalId: "Secret", type: "AWS::SecretsManager::Secret", policy: "Retain", physicalId: ref.masterSecretArn, templateDigest: "template" }] });
    assert.deepEqual(discoverStatefulReference("database", ref.instanceIdentifier, "original", { region }, destination, undefined, read, directory).reference, ref);
    for (broken of ["dns", "routes", "kms", "secret"]) assert.throws(() => discoverStatefulReference("database", ref.instanceIdentifier, "original", { region }, destination, undefined, read, directory), /DNS|route table|encryption key|master secret/);
    assert.ok(!calls.some(key => /get-secret-value|execute|modify|create|delete/.test(key)));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
