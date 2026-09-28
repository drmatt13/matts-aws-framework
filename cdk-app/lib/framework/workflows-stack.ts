import { deferResourceAttachment } from "./framework-resources";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import {
  compileWorkflowToAsl,
  getCloudTargets,
  nodesOf,
  type CloudMode,
  resolveWorkflow,
  type AslResolver,
  type FrameworkConfig,
  type NormalizedTarget,
} from "@repo/framework/config";
import { appEventRegistry } from "./framework-events";
import { requireIntegration } from "./framework-integrations";
import { appInvocationRegistry, registerAppWorkflow } from "./framework-tasks";
import { emitCloudOutputs } from "./framework-cloud";
import { FrameworkTargetRegistry } from "./framework-target-registry";

/**
 * Step Functions state machines, compiled from the authored graphs.
 *
 * Standard by default. Express is available but is not a free toggle: it has a
 * different set of supported integrations, and a graph that waits for a
 * container or a child workflow simply cannot run there. That is refused during
 * validation, in the framework's own words, rather than discovered from an AWS
 * error at deploy time — see `workflow-validate.ts`.
 *
 * The definition is compiled to ASL and handed over as a `DefinitionBody`, and
 * the role is derived from the IR's own references rather than inferred by CDK
 * from an opaque definition string. That inversion is deliberate: it is what
 * lets the ECS launch be revision-pinned to match the grant the task's stack
 * applied, and it means every permission this machine holds is traceable to a
 * `task(...)` in the graph.
 *
 * @see https://docs.aws.amazon.com/step-functions/latest/dg/connect-ecs.html
 * @see https://docs.aws.amazon.com/step-functions/latest/dg/connect-lambda.html
 */

export interface WorkflowsStackProps extends cdk.StackProps {
  readonly config: FrameworkConfig;
  /**
   * Which CDK graph this is. A workflow needs no resource catalog, so this is
   * the only thing that says so — and the selection below cannot be made
   * without it, because a dev deployment builds no state machines at all.
   */
  readonly mode: CloudMode;
  /** The selection the composition factory validated, when there is one. */
  readonly targets?: readonly NormalizedTarget[];
}

/**
 * The EventBridge rule the optimized ECS integration manages for job
 * monitoring. Named by AWS, in this account and region.
 */
const ECS_TASK_RULE_NAME = "StepFunctionsGetEventsForECSTaskRule";

/**
 * The rule the nested-execution integration manages. A different rule from the
 * ECS one, so a graph that waits for a child workflow needs its own statement.
 */
const EXECUTION_RULE_NAME = "StepFunctionsGetEventsForStepFunctionsExecutionRule";

/**
 * Builds workflows before the graphs that run them.
 *
 * A topological order over the `workflow:` steps each graph names. The config's
 * own order is the author's and says nothing about dependency; the registry
 * resolves a child by name, so the child must already be constructed.
 *
 * A cycle is impossible here — `assertInvocationEdges` reports one as a named
 * path long before this runs — so a target that cannot be placed is a bug
 * rather than a user error, and this says so instead of looping forever.
 */
function orderByDependency(
  targets: readonly NormalizedTarget[],
  config: FrameworkConfig,
): readonly NormalizedTarget[] {
  const byId = new Map(targets.map((target) => [target.id, target]));
  const ordered: NormalizedTarget[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();

  const visit = (target: NormalizedTarget): void => {
    if (placed.has(target.id)) return;
    if (visiting.has(target.id)) {
      throw new Error(
        `workflows["${target.id}"] takes part in a cycle of nested workflows, which should have been refused during config validation.`,
      );
    }
    visiting.add(target.id);

    for (const reference of resolveWorkflow(config, target.id).targets) {
      if (!reference.startsWith("workflow:")) continue;
      const child = byId.get(reference.slice("workflow:".length));
      // A child outside this selection is built elsewhere, or not at all; the
      // registry lookup is what reports that, with a better message than this.
      if (child !== undefined) visit(child);
    }

    visiting.delete(target.id);
    placed.add(target.id);
    ordered.push(target);
  };

  for (const target of targets) visit(target);
  return ordered;
}

export class WorkflowsStack extends cdk.Stack {
  public readonly targets = new FrameworkTargetRegistry();

  constructor(scope: Construct, id: string, props: WorkflowsStackProps) {
    super(scope, id, props);

    const workflows =
      props.targets ?? getCloudTargets(props.config, ["workflow"], props.mode);
    if (workflows.length === 0) return;

    // Built in dependency order: a graph that runs a child workflow resolves it
    // through the app-scoped registry, so the child's state machine has to exist
    // first. Config order is the author's, not the graph's. The ordering is
    // well-defined because `assertInvocationEdges` has already refused a cycle.
    for (const target of orderByDependency(workflows, props.config)) {
      this.addWorkflow(target, props.config);
    }
  }

  private addWorkflow(target: NormalizedTarget, config: FrameworkConfig): void {
    const workflow = resolveWorkflow(config, target.id);

    const events = appEventRegistry(this);
    const invocations = appInvocationRegistry(this);

    // A role of its own, so every statement below is one this graph asked for.
    const role = new iam.Role(this, `${target.cloud.constructId}Role`, {
      assumedBy: new iam.ServicePrincipal("states.amazonaws.com"),
      description: `Derived from the states of workflows["${target.id}"].`,
    });

    // Which tasks this graph waits on a *callback* from. Their containers call
    // SendTaskSuccess themselves, so the task's own role needs the callback
    // actions — a permission the execution role's grants say nothing about.
    const callbackTasks = new Set(
      nodesOf(workflow.root)
        .filter(
          (node) =>
            node.kind === "invocation" &&
            node.invokes === "task" &&
            node.completion === "callback",
        )
        .map((node) => (node as { target: string }).target),
    );

    let awaitsContainer = false;
    let awaitsExecution = false;
    const resolver: AslResolver = {
      lambdaArn: (id) => {
        const fn = events.requireLambda(`lambda:${id}`);
        // The exact function, not a wildcard: the graph names it, so the grant
        // can too.
        role.addToPrincipalPolicy(
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["lambda:InvokeFunction"],
            resources: [fn.functionArn],
          }),
        );
        return fn.functionArn;
      },
      workflowArn: (id) => {
        const handle = invocations.requireWorkflow(`workflow:${id}`);
        handle.grantStart(role);
        awaitsExecution = true;
        return handle.stateMachine.stateMachineArn;
      },
      // Resolved from the app-scoped binding registry rather than from a
      // resource catalog: a workflow's integrations come from its own graph,
      // and the construct they name is bound beside the resource in
      // application CDK. The grant is applied here, from the operations this
      // graph actually performs, so a workflow that only reads a table holds
      // only read permission.
      integrationTarget: (spec) => {
        const binding = requireIntegration(this, spec);
        const use = workflow.integrations.find(
          (candidate) =>
            candidate.reference.kind === spec.kind &&
            candidate.reference.id === spec.id,
        );
        binding.grant(role, use?.operations ?? []);
        return binding.resolution;
      },
      taskLaunch: (id) => {
        const handle = invocations.requireTask(`task:${id}`);
        // The same RunTask and both-role PassRole grants a direct caller gets,
        // from the same implementation - there is no second, wider version for
        // the state machine.
        handle.grantRun(role);
        awaitsContainer = true;
        if (callbackTasks.has(id)) {
          // `Resource: "*"` because the Step Functions callback actions do not
          // support resource-level scoping: a task token is not an ARN. Only
          // the containers this graph actually waits on get it.
          handle.taskDefinition.taskRole.addToPrincipalPolicy(
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "states:SendTaskSuccess",
                "states:SendTaskFailure",
                "states:SendTaskHeartbeat",
              ],
              resources: ["*"],
            }),
          );
        }
        return {
          cluster: handle.launch.cluster,
          taskDefinitionArn: handle.launch.taskDefinitionArn,
          containerName: handle.launch.containerName,
          platformVersion: handle.launch.platformVersion,
          subnets: handle.launch.subnets,
          securityGroups: handle.launch.securityGroups,
          assignPublicIp: handle.launch.assignPublicIp,
        };
      },
    };

    let definition: string | undefined;
    deferResourceAttachment(this, () => {
    definition = JSON.stringify(compileWorkflowToAsl(workflow, resolver));

    if (awaitsContainer) {
      // The `.sync` integration polls tasks whose ids only exist at runtime, so
      // AWS's own published policy for it uses `Resource: "*"` for these two.
      // That documented baseline is used as-is rather than guessed at, and it
      // is emphatically not a blanket ECS wildcard.
      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["ecs:DescribeTasks", "ecs:StopTask"],
          resources: ["*"],
        }),
      );
      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["events:PutRule", "events:PutTargets", "events:DescribeRule"],
          resources: [
            cdk.Arn.format(
              { service: "events", resource: "rule", resourceName: ECS_TASK_RULE_NAME },
              this,
            ),
          ],
        }),
      );
    }

    if (awaitsExecution) {
      // Waiting for a child execution needs more than permission to start it,
      // and the two halves take *different* ARN types: the state machine to
      // start, the executions of it to watch. Combining them produces valid
      // JSON and a policy that does not work, so they stay apart.
      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["states:DescribeExecution", "states:StopExecution"],
          resources: [
            cdk.Arn.format(
              {
                service: "states",
                resource: "execution",
                resourceName: "*",
                arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
              },
              this,
            ),
          ],
        }),
      );
      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["events:PutRule", "events:PutTargets", "events:DescribeRule"],
          resources: [
            cdk.Arn.format(
              { service: "events", resource: "rule", resourceName: EXECUTION_RULE_NAME },
              this,
            ),
          ],
        }),
      );
    }

    });

    const logGroup = new logs.LogGroup(this, `${target.cloud.constructId}Logs`, {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const stateMachine = new sfn.StateMachine(this, target.cloud.constructId, {
      stateMachineType:
        workflow.type === "express"
          ? sfn.StateMachineType.EXPRESS
          : sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromString(cdk.Lazy.string({ produce: () => {
        if (!definition) throw new Error("Finalize framework resources before synthesizing workflows.");
        return definition;
      } })),
      role,
      // No `timeout` prop: CDK applies it only to a chain-built definition, so
      // with a string body it is silently ignored. The deadline every execution
      // needs is `TimeoutSeconds` in the compiled definition, which is also the
      // one place it should be.
      logs: { destination: logGroup, level: sfn.LogLevel.ERROR },
    });

    const handle = {
      stateMachine,
      grantStart: (grantee: iam.IGrantable): void => {
        grantee.grantPrincipal.addToPrincipalPolicy(
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["states:StartExecution"],
            resources: [stateMachine.stateMachineArn],
          }),
        );
      },
    };
    this.targets.workflow(target.id, handle);
    registerAppWorkflow(this, target.id, handle);

    emitCloudOutputs(this, target, { arn: stateMachine.stateMachineArn });
  }
}
