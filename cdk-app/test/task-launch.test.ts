import { applicationVpc as fixtureVpc } from "../../framework-config/networks/application";
import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import {
  defineFrameworkConfig,
  runTask,
  runsTask,
  workflow,
} from "@repo/framework/config";
import { defaults } from "../../framework-config/defaults";
import { EcsTasksStack } from "../lib/framework/ecs-tasks-stack";
import { finalizeFrameworkResources, initializeFrameworkResources } from "../lib/framework/framework-resources";
import { OrchestrationStack } from "../lib/framework/orchestration-stack";
import { SynchronousLambdaFunctionsStack } from "../lib/framework/synchronous-lambda-functions-stack";

/**
 * A task definition is immutable: any change to it — a rebuilt image included —
 * registers a new revision under a new ARN. A caller in another stack holding
 * that ARN holds it through a CloudFormation export, and an export cannot change
 * while another stack imports it, so the task's next change fails to deploy:
 * "Cannot update export ... as it is in use". Callers name the family instead,
 * which never changes.
 */

const env = { account: "111122223333", region: "eu-west-2" };
const TASK = "process-message";

interface Template {
  readonly Resources: Record<string, { readonly Type: string; readonly Properties?: Record<string, unknown> }>;
  readonly Outputs?: Record<string, { readonly Value?: unknown; readonly Export?: { readonly Name?: unknown } }>;
}

function synthesize() {
  const config = defineFrameworkConfig({ networks: [fixtureVpc],
    defaults,
    webSocket: [],
    events: [],
    services: [],
    http: [{
      "/run": {
        directory: "/test/fixtures/workload-handler",
        methods: ["POST"],
        deploy: "both",
        cloud: { bindings: [runsTask(TASK)] },
      },
    }],
    tasks: [{ [TASK]: { directory: "/test/fixtures/task-worker", deploy: "both", tags: { area: "billing" }, cloud: { vpc: fixtureVpc, subnet: "public" } } }],
    workflows: [{ "runs-the-task": workflow(() => runTask(TASK), { deploy: "both", timeoutSeconds: 900 }) }],
  });
  const app = new cdk.App({ context: { "@aws-cdk/aws-lambda:useCdkManagedLogGroup": true } });
  initializeFrameworkResources(app, { config, mode: "prod", deployment: "task-launch-test", readers: { env: {} } });
  // The task's stack first: its callers resolve its handle from it.
  new EcsTasksStack(app, "Tasks", { env, config, cloud: { mode: "prod" } });
  new SynchronousLambdaFunctionsStack(app, "Lambdas", { env, config, cloud: { mode: "prod" } });
  const identity = new cdk.Stack(app, "Identity", { env });
  const userPool = new cognito.UserPool(identity, "Pool");
  new OrchestrationStack(app, "Workflows", {
    env,
    config,
    mode: "prod",
    cognito: { userPool, userPoolClient: userPool.addClient("Client") },
  });
  finalizeFrameworkResources(app);
  const assembly = app.synth();
  return Object.fromEntries(assembly.stacks.map((stack) => [stack.stackName, stack.template as Template]));
}

test("no stack exports a task definition revision, so a changed task deploys under its callers", () => {
  const templates = synthesize();
  for (const [stack, template] of Object.entries(templates)) {
    for (const [id, output] of Object.entries(template.Outputs ?? {})) {
      if (!output.Export) continue;
      const reference = (output.Value as { Ref?: string } | undefined)?.Ref;
      assert.notEqual(
        reference !== undefined && template.Resources[reference]?.Type,
        "AWS::ECS::TaskDefinition",
        `${stack} exports ${reference}'s revision ARN as ${id}; the task's next revision could not deploy.`,
      );
    }
  }

  const definition = Object.values(templates.Tasks!.Resources).find(resource => resource.Type === "AWS::ECS::TaskDefinition")!;
  assert.ok((definition.Properties?.Tags as { Key: string; Value: string }[]).some(tag => tag.Key === "area" && tag.Value === "billing"));

  // Both callers may run every revision of the family, and only that family.
  const [family] = Object.values(templates.Tasks!.Resources)
    .filter((resource) => resource.Type === "AWS::ECS::TaskDefinition")
    .map((resource) => resource.Properties?.Family);
  assert.equal(typeof family, "string", "the family is a literal, known at synthesis");
  for (const caller of ["Lambdas", "Workflows"]) {
    const statements = Object.values(templates[caller]!.Resources)
      .filter((resource) => resource.Type === "AWS::IAM::Policy")
      .flatMap((resource) => (resource.Properties!.PolicyDocument as { Statement: { Action: unknown; Resource: unknown }[] }).Statement)
      .filter((statement) => [statement.Action].flat().includes("ecs:RunTask"));
    assert.equal(statements.length, 1, `${caller} holds one RunTask grant`);
    assert.match(JSON.stringify(statements[0]!.Resource), new RegExp(`:task-definition/${family}:\\*"`), `${caller} may run any revision of ${family}`);
    const tagging = Object.values(templates[caller]!.Resources)
      .filter(resource => resource.Type === "AWS::IAM::Policy")
      .flatMap(resource => (resource.Properties!.PolicyDocument as { Statement: { Action: unknown; Resource: unknown; Condition?: unknown }[] }).Statement)
      .filter(statement => [statement.Action].flat().includes("ecs:TagResource"));
    assert.equal(tagging.length, 1, `${caller} can propagate task tags during creation`);
    assert.deepEqual(tagging[0]!.Condition, { StringEquals: { "ecs:CreateAction": "RunTask" } });
    assert.match(JSON.stringify(tagging[0]!.Resource), /:task\//, "tagging is scoped to tasks in the declared cluster");
    assert.notEqual(tagging[0]!.Resource, "*");
  }
});
