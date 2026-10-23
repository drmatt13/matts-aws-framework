import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { defineFrameworkConfig, defineNetwork } from "@repo/framework/config";
import { defaults } from "../../framework-config/defaults";
import { SynchronousLambdaFunctionsStack } from "../lib/framework/synchronous-lambda-functions-stack";
import { finalizeFrameworkResources, initializeFrameworkResources } from "../lib/framework/framework-resources";

const env = { account: "111122223333", region: "eu-west-2" };
const network = defineNetwork({ id: "application", cloud: { constructId: "NetworkStack" }, cidr: "10.0.0.0/16", zones: 2 });
const outsideVpc = { Ipv6AllowedForDualStack: false, SecurityGroupIds: [], SubnetIds: [] };
const implementations = {
  node: { directory: "/test/fixtures/workload-handler", runtime: "nodejs24", packaging: "zip", handler: "lambdaHandler" },
  python: { directory: "/lambda_functions/http_functions/python-example", runtime: "python3.13", packaging: "zip", handler: "lambda_function.lambda_handler" },
  container: { directory: "/lambda_functions/http_functions/python-example", packaging: "container" },
} as const;

function synth(implementation: keyof typeof implementations = "node", subnet: "private" | "none" = "none") {
  const config = defineFrameworkConfig({
    defaults, networks: [network], http: [{ "/placement": {
      ...implementations[implementation], methods: ["GET"], deploy: "both",
      ...(subnet === "none" ? { subnet } : { subnet, vpc: network }),
      cloud: { constructId: "StableHandler" },
    } }], events: [], webSocket: [], services: [], tasks: [], workflows: [], tools: [], agents: [],
  });
  const app = new cdk.App({ context: { "aws:cdk:bundling-stacks": [] } });
  initializeFrameworkResources(app, { config, mode: "prod", deployment: "placement", env, readers: { env: {} } });
  const stack = new SynchronousLambdaFunctionsStack(app, "Lambdas", { env, config, cloud: { mode: "prod" } });
  finalizeFrameworkResources(app);
  return { app, template: Template.fromStack(stack) };
}

test("moving the same IPv6 VPC Lambda to subnet:none explicitly clears all VPC settings without changing its identity", () => {
  const before = synth("node", "private").template;
  const { app, template: after } = synth();
  const [[id, fn]] = Object.entries(before.findResources("AWS::Lambda::Function"));
  assert.equal(fn.Properties.VpcConfig.Ipv6AllowedForDualStack, true);
  assert.ok(fn.Properties.VpcConfig.SubnetIds.length > 0);
  assert.ok(fn.Properties.VpcConfig.SecurityGroupIds.length > 0);
  assert.deepEqual(Object.keys(after.findResources("AWS::Lambda::Function")), [id]);
  assert.deepEqual(after.findResources("AWS::Lambda::Function")[id].Properties.VpcConfig, outsideVpc);
  assert.deepEqual(Object.keys(after.toJSON().Resources).sort(), Object.keys(before.toJSON().Resources).sort(), "existing function, role and log identities remain stable");
  assert.equal(app.node.tryFindChild("placement-NetworkStack"), undefined, "detached placement creates no network");
  assert.ok(!JSON.stringify(after.findResources("AWS::IAM::Role")).includes("AWSLambdaVPCAccessExecutionRole"), "detached function receives no ENI permissions");
});

for (const implementation of ["node", "python", "container"] as const) {
  test(`a fresh non-VPC ${implementation} Lambda explicitly disables IPv6 without allocating VPC resources`, () => {
    const { app, template } = synth(implementation);
    const functions = Object.values(template.findResources("AWS::Lambda::Function"));
    assert.equal(functions.length, 1);
    assert.deepEqual(functions[0].Properties.VpcConfig, outsideVpc);
    assert.equal(app.node.tryFindChild("placement-NetworkStack"), undefined);
    assert.ok(!JSON.stringify(template.findResources("AWS::IAM::Role")).includes("AWSLambdaVPCAccessExecutionRole"));
  });
}

