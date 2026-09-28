import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import {
  defineFrameworkConfig,
  defineResources,
  getFrameworkTargets,
  resource,
  type FrameworkConfig,
} from "@repo/framework/config";
import { defaults } from "../../framework-config/defaults";
import { EcsServicesStack } from "../lib/framework/ecs-services-stack";
import {
  finalizeFrameworkResources,
  initializeFrameworkResources,
} from "../lib/framework/framework-resources";

/**
 * What a declared startup secret becomes in a template.
 *
 * The load-bearing assertion is the negative one: the value is authored in
 * cdk-app/.env and copied into Secrets Manager by `npm run deploy`, so a
 * template that contained it would be a leak into every artifact a deploy
 * writes. The rest pins the mechanism that keeps it out — the template carries
 * a parameter for the ARN rather than the ARN itself, ECS resolves it at
 * container startup, and the execution role may read that one secret and
 * nothing else.
 *
 * These four assertions are deliberately unchanged in substance from when a
 * startup secret was declared inline on the workload, and again from when its
 * ARN arrived through a synced bindings document. What reaches a template did
 * not move when the delivery mechanism did, and that is the point of checking
 * it here.
 *
 * The fixture declares its own service rather than using framework-config,
 * where langgraph is deploy: "local-only" and so reaches no cloud graph.
 */

const RAW_VALUE = "sk-test-not-a-real-key-000111222";

const env = { account: "111122223333", region: "eu-west-2" };

const resources = defineResources({
  openaiApiKey: resource.secret(),
  langgraph: {
    modelProvider: resource.fromEnv().enum("bedrock", "openai").default("bedrock"),
  },
});

function config(secrets: Record<string, unknown>): FrameworkConfig {
  return defineFrameworkConfig({
    resources,
    defaults,
    http: [],
    webSocket: [],
    services: [
      {
        "/example/*": {
          directory: "/ecs_containers/services/langgraph",
          methods: "*",
          auth: true,
          port: 5000,
          deploy: "both",
          secrets,
          cloud: { constructId: "ExampleService", cpu: 256, memoryMiB: 512, desiredCount: 1 },
        },
      },
    ],
    events: [],
    tasks: [],
    workflows: [],
  } as never);
}

/**
 * @param authored what cdk-app/.env holds. A secret with a value there is one
 * this deployment has; an empty file is a deployment that does not.
 */
function synthesize(
  secrets: Record<string, unknown>,
  authored: Record<string, string>,
): Template {
  const app = new cdk.App();
  const built = config(secrets);
  const targets = getFrameworkTargets(built).filter((target) => target.kind === "service");
  // The stack resolves through the registry, the way the composed application
  // does. Turning an authored secret into a handle happens there, and what the
  // stack receives is an ARN parameter — never the value.
  initializeFrameworkResources(app, {
    config: built,
    mode: "prod",
    deployment: "matts-aws-framework",
    readers: { env: authored },
  });
  const stack = new EcsServicesStack(app, "matts-aws-framework-EcsServicesStack", {
    env,
    config: built,
    cloud: { mode: "prod" },
    targets,
  } as never);
  finalizeFrameworkResources(app);
  return Template.fromStack(stack);
}

function containerSecrets(template: Template): { Name: string; ValueFrom: unknown }[] {
  const definitions = Object.values(
    template.findResources("AWS::ECS::TaskDefinition"),
  ) as { Properties: { ContainerDefinitions: { Secrets?: { Name: string; ValueFrom: unknown }[] }[] } }[];
  assert.equal(definitions.length, 1, "the fixture builds one task definition");
  return definitions[0].Properties.ContainerDefinitions[0].Secrets ?? [];
}

test("an authored startup secret reaches the task definition as an ARN parameter", () => {
  const template = synthesize(
    { OPENAI_API_KEY: resources.openaiApiKey },
    { OPENAI_API_KEY: RAW_VALUE },
  );
  const secrets = containerSecrets(template);
  assert.equal(secrets.length, 1);
  assert.equal(secrets[0].Name, "OPENAI_API_KEY");

  // A reference, not a literal: the secret is created by `npm run deploy`, so a
  // synthesized template cannot know the six-character suffix that makes the
  // ARN complete. The parameter's pattern is what requires a complete one.
  const reference = secrets[0].ValueFrom as { Ref?: string };
  assert.ok(reference.Ref, "the ARN arrives as a Ref to a parameter");
  const parameters = template.toJSON().Parameters as Record<string, { AllowedPattern?: string }>;
  assert.match(
    parameters[reference.Ref].AllowedPattern ?? "",
    /^arn:\[\^:\]\+:secretsmanager:/,
    "the parameter accepts only a Secrets Manager ARN",
  );
});

test("the template never contains the secret value", () => {
  const template = synthesize(
    { OPENAI_API_KEY: resources.openaiApiKey },
    { OPENAI_API_KEY: RAW_VALUE },
  );
  assert.ok(
    !JSON.stringify(template.toJSON()).includes(RAW_VALUE),
    "a startup secret's value must never be synthesized",
  );
});

test("the execution role may read that secret and nothing wider", () => {
  const template = synthesize(
    { OPENAI_API_KEY: resources.openaiApiKey },
    { OPENAI_API_KEY: RAW_VALUE },
  );
  const policies = Object.values(template.findResources("AWS::IAM::Policy")) as {
    Properties: { PolicyDocument: { Statement: { Action: unknown; Resource: unknown }[] } };
  }[];
  const reads = policies
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
    .filter((statement) => JSON.stringify(statement.Action).includes("secretsmanager:GetSecretValue"));
  assert.equal(reads.length, 1, "exactly one statement reads the secret");

  // Scoped to the one parameter the task definition reads, not to a wildcard.
  const granted = JSON.stringify(reads[0].Resource);
  const expected = (containerSecrets(template)[0].ValueFrom as { Ref: string }).Ref;
  assert.ok(granted.includes(expected), `the grant names ${expected}`);
  assert.ok(!granted.includes('"*"'), "nothing is granted across every secret");
});

test("an optional startup secret this deployment does not hold is absent from the task definition", () => {
  const template = synthesize({ OPENAI_API_KEY: resources.openaiApiKey }, {});
  assert.deepEqual(containerSecrets(template), []);
  const policies = Object.values(template.findResources("AWS::IAM::Policy")) as {
    Properties: { PolicyDocument: { Statement: { Action: unknown }[] } };
  }[];
  assert.ok(
    !policies
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
      .some((statement) => JSON.stringify(statement.Action).includes("secretsmanager")),
    "nothing is granted for a secret the deployment does not have",
  );
  // And no ARN parameter is minted for it either, so `npm run deploy` is never
  // asked to supply a secret nobody declared a value for. (CDK's own
  // BootstrapVersion parameter is always present and is not ours.)
  const minted = Object.keys(template.toJSON().Parameters ?? {}).filter((name) =>
    name.startsWith("FrameworkResourceArn"),
  );
  assert.deepEqual(minted, []);
});
