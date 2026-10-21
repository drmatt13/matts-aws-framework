import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { defineFrameworkConfig, defineNetwork } from "@repo/framework/config";
import { defaults } from "../../framework-config/defaults";
import { resolveDeploymentInputs } from "../deployment";
import { frameworkVpc } from "../lib/framework/framework-network";
import { finalizeFrameworkResources, initializeFrameworkResources } from "../lib/framework/framework-resources";

const account = "111122223333";
const application = defineNetwork({ id: "application", cloud: { constructId: "NetworkStack" }, cidr: "10.0.0.0/16", zones: 2, interfaceEndpoints: ["secretsmanager"] });
const analytics = defineNetwork({ id: "analytics", cidr: "10.1.0.0/16", zones: 2 });
const configuration = defineFrameworkConfig({ networks: [application, analytics], defaults, http: [], webSocket: [], events: [], services: [] });

function appFor(region: string, pin = false) {
  const app = new cdk.App({ context: { [`availability-zones:account=${account}:region=${region}`]: [`${region}a`, `${region}b`, `${region}c`] } });
  initializeFrameworkResources(app, { config: configuration, mode: "prod", deployment: "regional", ...(pin ? { env: { account, region } } : {}), readers: { env: {} } });
  return app;
}

test("one deployment region supplies every VPC's AZs and regional endpoint service names", () => {
  for (const region of ["us-east-1", "eu-west-2"]) {
    const app = appFor(region);
    const caller = new cdk.Stack(app, "Application", { env: { account, region } });
    const vpcs = [application, analytics].map((network) => ({ network, vpc: frameworkVpc(caller, network) }));
    finalizeFrameworkResources(app);
    for (const { network, vpc } of vpcs) {
      assert.deepEqual(vpc.availabilityZones, [`${region}a`, `${region}b`]);
      const stack = cdk.Stack.of(vpc);
      assert.equal(stack.region, region);
      assert.equal(stack.account, account);
      if (network === application) {
        const endpoints = Object.values(Template.fromStack(stack).findResources("AWS::EC2::VPCEndpoint"));
        assert.ok(endpoints.some((endpoint) => endpoint.Properties.ServiceName === `com.amazonaws.${region}.secretsmanager`));
        const s3 = endpoints.find((endpoint) => endpoint.Properties.VpcEndpointType === "Gateway" && JSON.stringify(endpoint.Properties.ServiceName).includes(".s3"));
        assert.deepEqual(s3?.Properties.ServiceName, { "Fn::Join": ["", ["com.amazonaws.", { Ref: "AWS::Region" }, ".s3"]] });
      }
    }
  }
});

test("sharing a VPC or creating another VPC across stack environments fails before building infrastructure", () => {
  for (const network of [application, analytics]) {
    for (const env of [{ account, region: "us-west-2" }, { account: "999988887777", region: "us-east-1" }, undefined]) {
      const app = appFor("us-east-1");
      const original = new cdk.Stack(app, "Application", { env: { account, region: "us-east-1" } });
      frameworkVpc(original, application);
      const other = new cdk.Stack(app, "Other", { env });
      assert.throws(() => frameworkVpc(other, network), /deployment "regional" uses 111122223333\/us-east-1.*shared stackEnv.*separate named deployment target/);
      assert.equal(app.node.tryFindChild("regional-AnalyticsNetworkStack"), undefined);
      assert.equal(frameworkVpc(original, application), frameworkVpc(new cdk.Stack(app, "SameRegion", { env: { account, region: "us-east-1" } }), application));
    }
  }
});

test("the application destination is enforced for the first native VPC consumer", () => {
  for (const env of [{ account, region: "eu-west-2" }, { account: "999988887777", region: "us-east-1" }]) {
    const app = appFor("us-east-1", true);
    const wrong = new cdk.Stack(app, "WrongDestination", { env });
    assert.throws(() => frameworkVpc(wrong, application), /deployment "regional" uses 111122223333\/us-east-1.*shared stackEnv/);
    assert.equal(app.node.children.filter((child) => child.node.id.endsWith("NetworkStack")).length, 0);
    const correct = new cdk.Stack(app, "Application", { env: { account, region: "us-east-1" } });
    assert.equal(cdk.Stack.of(frameworkVpc(correct, application)).region, "us-east-1");
  }
});

test("a target region pin refuses the profile's other region instead of moving the application", () => {
  const target = { name: "application-prod", mode: "prod" as const, account, region: "eu-west-2" };
  const input = (region: string) => ({ getContext: () => undefined, env: { CDK_DEFAULT_ACCOUNT: account, CDK_DEFAULT_REGION: region }, target });
  assert.deepEqual(resolveDeploymentInputs(input("eu-west-2")).stackEnv, { account, region: "eu-west-2" });
  assert.throws(() => resolveDeploymentInputs(input("us-east-1")), /application-prod is pinned to eu-west-2.*Select eu-west-2/);
});
