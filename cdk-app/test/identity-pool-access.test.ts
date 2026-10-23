import assert from "node:assert/strict";
import { test } from "node:test";
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { UserPool } from "aws-cdk-lib/aws-cognito";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { identityPoolAccess } from "../lib/app/identity-pool-access";
import { identityPolicyStatements } from "../lib/app/identity-policy";

function synth(readBucketArn?: string, readPrefix?: string) {
  const app = new App(); const env = { account: "111122223333", region: "us-east-1" };
  const auth = new Stack(app, "Authentication", { env }); const userPool = new UserPool(auth, "Pool"); const userPoolClient = userPool.addClient("Client");
  const access = new Stack(app, "IdentityAccess", { env });
  identityPoolAccess(access, { userPool, userPoolClient, groupName: "campaign-reader", ...(readBucketArn ? { readBucketArn } : {}), ...(readPrefix ? { readPrefix } : {}) });
  return Template.fromStack(access);
}
test("identity-pool source has authenticated-only pool-scoped trust, ambiguous claims denied and no default AWS grants", () => {
  const template = synth();
  template.hasResourceProperties("AWS::Cognito::IdentityPool", { AllowUnauthenticatedIdentities: false, AllowClassicFlow: false, CognitoIdentityProviders: [Match.objectLike({ ServerSideTokenCheck: true })] });
  template.hasResourceProperties("AWS::IAM::Role", { AssumeRolePolicyDocument: { Statement: [Match.objectLike({ Action: "sts:AssumeRoleWithWebIdentity", Principal: { Federated: "cognito-identity.amazonaws.com" }, Condition: { StringEquals: { "cognito-identity.amazonaws.com:aud": Match.anyValue() }, "ForAnyValue:StringLike": { "cognito-identity.amazonaws.com:amr": "authenticated" } } })], Version: "2012-10-17" } });
  template.hasResourceProperties("AWS::Cognito::IdentityPoolRoleAttachment", { RoleMappings: { userPool: Match.objectLike({ Type: "Token", AmbiguousRoleResolution: "Deny" }) } });
  template.hasResourceProperties("AWS::Cognito::UserPoolGroup", { GroupName: "campaign-reader", Precedence: 10, RoleArn: Match.anyValue() });
  template.resourceCountIs("AWS::IAM::Policy", 0);
  template.resourceCountIs("AWS::IAM::Role", 2);
});
test("explicit read target grants only object reads in the selected bucket and prefix", () => {
  const template = synth("arn:aws:s3:::campaign-private", "tenants/example/");
  template.hasResourceProperties("AWS::IAM::Policy", { PolicyDocument: { Statement: [{ Action: "s3:GetObject", Effect: "Allow", Resource: "arn:aws:s3:::campaign-private/tenants/example/*" }], Version: "2012-10-17" } });
  const text = JSON.stringify(template.toJSON());
  const document = template.toJSON();
  const roleResources = template.findResources("AWS::IAM::Role");
  const defaultRole = Object.keys(roleResources).find(id => id.startsWith("AuthenticatedRole"))!;
  const readerRole = Object.keys(roleResources).find(id => id.startsWith("ReaderRole"))!;
  const policy = Object.values(template.findResources("AWS::IAM::Policy"))[0] as { Properties: { Roles: unknown } };
  assert.deepEqual(policy.Properties.Roles, [{ Ref: readerRole }], "Only the reader-group role receives S3 grants; missing-group default remains permissionless.");
  assert.notEqual(defaultRole, readerRole);
  assert.ok(document.Resources[defaultRole]);
  assert.doesNotMatch(text, /s3:PutObject|s3:DeleteObject|s3:ListBucket|AdministratorAccess|Action":"\*"/);
});
test("wildcard buckets and wildcard/object-path prefixes are refused before synthesis", () => {
  assert.throws(() => synth("arn:aws:s3:::*"), /explicit S3 bucket ARN/);
  assert.throws(() => synth("arn:aws:s3:::campaign-private", "tenant/*"), /cannot contain wildcards/);
  assert.throws(() => synth("arn:aws:s3:::campaign-private/object"), /explicit S3 bucket ARN/);
});
test("a newly created native bucket ARN stays a CloudFormation reference with a scoped read grant", () => {
  const stack = new Stack(new App(), "FreshNativeResources", { env: { account: "111122223333", region: "us-east-1" } });
  const userPool = new UserPool(stack, "Pool");
  const bucket = new Bucket(stack, "Objects");
  identityPoolAccess(stack, { userPool, userPoolClient: userPool.addClient("Client"), groupName: "reader", readBucketArn: bucket.bucketArn, readPrefix: "tenant/" });
  const template = Template.fromStack(stack);
  const bucketId = Object.keys(template.findResources("AWS::S3::Bucket"))[0]!;
  template.hasResourceProperties("AWS::IAM::Policy", {
    PolicyDocument: { Version: "2012-10-17", Statement: [{ Action: "s3:GetObject", Effect: "Allow", Resource: { "Fn::Join": ["", [{ "Fn::GetAtt": [bucketId, "Arn"] }, "/tenant/*"]] } }] },
  });
  assert.doesNotMatch(JSON.stringify(template.findResources("AWS::IAM::Policy")), /s3:PutObject|s3:DeleteObject|s3:ListBucket/);
  assert.throws(() => identityPoolAccess(new Stack(new App(), "WildcardToken"), { userPool, userPoolClient: userPool.addClient("AnotherClient"), groupName: "reader", readBucketArn: `${bucket.bucketArn}/*` }), /without wildcards/);
});
test("custom policies bind exact ReaderRole Allow/Deny and opted-in guests remain permissionless", () => {
  const app = new App(); const env = { account: "111122223333", region: "us-east-1" };
  const auth = new Stack(app, "CustomAuth", { env }); const userPool = new UserPool(auth, "Pool"); const userPoolClient = userPool.addClient("Client");
  const stack = new Stack(app, "CustomPolicy", { env });
  const statements = identityPolicyStatements([
    { Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject"], Resource: ["arn:aws:s3:::campaign-private/tenant/*"] },
    { Effect: "Deny", Action: ["s3:PutObject"], Resource: ["arn:aws:s3:::campaign-private/tenant/protected/*"] },
  ]);
  identityPoolAccess(stack, { userPool, userPoolClient, groupName: "custom-reader", readerPolicyStatements: statements, allowUnauthenticated: true });
  const template = Template.fromStack(stack); const roles = template.findResources("AWS::IAM::Role");
  template.resourceCountIs("AWS::IAM::Role", 3);
  template.hasResourceProperties("AWS::Cognito::IdentityPool", { AllowUnauthenticatedIdentities: true, AllowClassicFlow: false });
  const reader = Object.keys(roles).find(id => id.startsWith("ReaderRole"))!;
  const policies = Object.values(template.findResources("AWS::IAM::Policy")) as any[];
  assert.equal(policies.length, 1); assert.deepEqual(policies[0].Properties.Roles, [{ Ref: reader }]);
  assert.deepEqual(policies[0].Properties.PolicyDocument.Statement, [{ Action: ["s3:GetObject", "s3:PutObject"], Effect: "Allow", Resource: "arn:aws:s3:::campaign-private/tenant/*" }, { Action: "s3:PutObject", Effect: "Deny", Resource: "arn:aws:s3:::campaign-private/tenant/protected/*" }]);
  const guest = Object.entries<any>(roles).find(([id]) => id.startsWith("UnauthenticatedRole"))![1];
  assert.equal(guest.Properties.AssumeRolePolicyDocument.Statement[0].Condition["ForAnyValue:StringLike"]["cognito-identity.amazonaws.com:amr"], "unauthenticated");
  assert.ok(guest.Properties.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals["cognito-identity.amazonaws.com:aud"]);
  assert.ok(!guest.Properties.Policies && !guest.Properties.ManagedPolicyArns);
});
