import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { DescribeSecretCommand, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { defineFrameworkConfig, defineResources, resource, resourceAttributeKey, type CloudMode, type FrameworkConfig, type ResourceDeclarationGroup, type ResourceReference } from "@repo/framework/config";
import { defaults } from "../../framework-config/defaults";
import { planDeploymentSecrets, type SecretRequirement } from "../../scripts/deployment-secrets";
import { finalizeFrameworkResources, initializeFrameworkResources, resolveDeploymentSecret, SECRET_PARAMETER_METADATA } from "../lib/framework/framework-resources";

const env = { account: "111122223333", region: "eu-west-2" };
const originalPath = ["providers", "apiKey"] as const;
const variable = "API_KEY";
const value = "not-a-real-secret-fixture";
const arn = `arn:aws:secretsmanager:${env.region}:${env.account}:secret:fixture-AbCdEf`;

function synthesize(catalog: ResourceDeclarationGroup, reference: ResourceReference<"secret"> & { readonly arn: ResourceReference<"string"> }, mode: CloudMode) {
  const app = new cdk.App();
  const config: FrameworkConfig = defineFrameworkConfig({ resources: catalog, defaults,
    http: [{ "/worker": { directory: "/lambda_functions/http_functions/worker", methods: ["POST"], auth: false, environment: { API_KEY_ARN: reference.arn } } }],
    webSocket: [], services: [], tasks: [], events: [], workflows: [],
  } as never);
  initializeFrameworkResources(app, { config, mode, deployment: "fixture", readers: { env: { [variable]: value } } });
  const stack = new cdk.Stack(app, "FixtureConsumer", { env });
  const handle = resolveDeploymentSecret(stack, reference, true)!;
  new cdk.CfnResource(stack, "Consumer", { type: "Custom::FixtureConsumer", properties: { SecretArn: handle.secretArn } });
  // Distinct projections/callers of the same binding must reuse one parameter.
  resolveDeploymentSecret(stack, { ...reference, path: reference.bindingPath ? ["temporaryAlias"] : reference.path }, true);
  finalizeFrameworkResources(app);
  const parameters = stack.node.findAll().filter((node): node is cdk.CfnParameter => node instanceof cdk.CfnParameter);
  assert.equal(parameters.length, 1);
  const metadata = parameters[0]!.node.metadata.find(record => record.type === SECRET_PARAMETER_METADATA)!.data;
  const requirement = { ...metadata, stack: stack.stackName } as SecretRequirement;
  return { template: Template.fromStack(stack).toJSON(), parameter: parameters[0]!.node.id, requirement };
}

test("catalog renames preserve managed secret parameters, ARN outputs, ownership metadata and bindings in both modes", async () => {
  const before = defineResources({ providers: { apiKey: resource.secret(variable, { tags: { area: "examples" } }) } });
  const renamed = defineResources({ renamedKey: resource.secret(variable, { bindingPath: originalPath, tags: { area: "examples" } }) });
  const renamedAgain = defineResources({ otherGroup: { finalKey: resource.secret(variable, { bindingPath: renamed.renamedKey.bindingPath, tags: { area: "examples" } }) } });
  const dormant = defineResources({ publicInput: resource.value("public-fixture", { bindingPath: renamed.renamedKey.bindingPath }) });
  const restored = defineResources({ restoredKey: resource.secret(variable, { bindingPath: dormant.publicInput.bindingPath, tags: { area: "examples" } }) });
  for (const mode of ["dev", "prod"] as const) {
    const baseline = synthesize(before, before.providers.apiKey, mode);
    const expected = `FrameworkResourceArn${createHash("sha256").update(JSON.stringify(originalPath)).digest("hex").slice(0, 20)}`;
    assert.equal(baseline.parameter, expected, "pin the exact existing construction algorithm");
    for (const [catalog, reference] of [[renamed, renamed.renamedKey], [renamedAgain, renamedAgain.otherGroup.finalKey], [restored, restored.restoredKey]] as const) {
      const after = synthesize(catalog, reference, mode);
      assert.equal(after.parameter, baseline.parameter);
      assert.deepEqual(after.template, baseline.template);
      assert.deepEqual(after.requirement, baseline.requirement);
      assert.deepEqual(after.requirement.path, originalPath);
      assert.equal(after.requirement.variable, variable);
      assert.equal(after.requirement.name, "fixture/secret/API_KEY");
      assert.equal(resourceAttributeKey(reference.arn), resourceAttributeKey(before.providers.apiKey.arn));
      const requests: unknown[] = [];
      const plan = await planDeploymentSecrets([after.requirement], { [variable]: value }, env, { send: async (command: unknown) => {
        requests.push(command);
        if (command instanceof DescribeSecretCommand) return { ARN: arn, Tags: [
          { Key: "framework:deployment", Value: "fixture" }, { Key: "framework:resource", Value: originalPath.join(".") },
          { Key: "framework:environment", Value: variable }, { Key: "area", Value: "examples" },
        ] };
        if (command instanceof GetSecretValueCommand) return { SecretString: value, VersionId: "fixture-version" };
        throw new Error("The read-only plan must not mutate a secret");
      } } as never);
      assert.deepEqual(plan.entries, [{ name: "fixture/secret/API_KEY", variable, action: "unchanged" }]);
      assert.equal(requests.length, 2);
    }
  }
});
