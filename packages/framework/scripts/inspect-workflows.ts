import {
  childrenOf,
  getLocalTargets,
  getWorkflows,
  integrationKey,
  isTargetEnabled,
  needsDevelopmentBridge,
  parseTargetReference,
  resolveLambdaTarget,
  type FrameworkConfig,
  type NormalizedWorkflow,
  type WorkflowNode,
} from "@repo/framework/config";
import framework from "../../../framework.config";

/**
 * What a workflow actually is, printed.
 *
 * Read-only and offline: it reads the declarations, not a deployment, and makes
 * no AWS call. What it answers are the three questions that are otherwise
 * answered by deploying and finding out — what the graph does, what it needs
 * bound before it can be built, and which half of it runs where during
 * development.
 *
 * `npm run workflows:inspect` prints every declared workflow;
 * `npm run workflows:inspect -- <id>` prints one.
 */

const GREY = "[90m";
const BOLD = "[1m";
const RESET = "[0m";
const colour = process.stdout.isTTY === true;

function dim(text: string): string {
  return colour ? `${GREY}${text}${RESET}` : text;
}
function bold(text: string): string {
  return colour ? `${BOLD}${text}${RESET}` : text;
}

/** One line per node, indented by its depth in the graph. */
function describeStep(
  workflow: NormalizedWorkflow,
  node: WorkflowNode,
  depth: number,
  lines: string[],
): void {
  const name = workflow.names.get(node.id) ?? node.id;
  const detail = ((): string => {
    switch (node.kind) {
      case "invocation":
        return node.completion === "callback"
          ? `${node.invokes}:${node.target} — waits for a callback (${node.timeoutSeconds}s)`
          : `${node.invokes}:${node.target}`;
      case "integration":
        return node.completion === "callback"
          ? `${integrationKey(node.reference)} ${node.operation} — waits for a callback (${node.timeoutSeconds}s)`
          : `${integrationKey(node.reference)} ${node.operation}`;
      case "map":
        return `up to ${node.maxConcurrency} at once`;
      case "parallel":
        return node.names ? node.names.join(", ") : `${node.branches.length} branches`;
      case "retry":
        return `${node.policy.retries} retries`;
      case "wait":
        return node.seconds === undefined ? "until a timestamp" : "for a duration";
      case "fail":
        return node.error;
      default:
        return "";
    }
  })();

  lines.push(
    `${"  ".repeat(depth + 1)}${name}${detail === "" ? "" : ` ${dim(detail)}`}`,
  );
  for (const child of childrenOf(node)) {
    describeStep(workflow, child, depth + 1, lines);
  }
}

function describeWorkflow(config: FrameworkConfig, workflow: NormalizedWorkflow): string {
  const lines: string[] = [];
  const locally = isTargetEnabled(config, "workflow", workflow.id, "local");
  const inCloud = isTargetEnabled(config, "workflow", workflow.id, "cloud");

  lines.push(bold(`workflow:${workflow.id}`));
  lines.push(
    `  ${dim("type")} ${workflow.type}   ${dim("deadline")} ${workflow.timeoutSeconds}s   ${dim("runs")} ${
      [locally ? "locally" : undefined, inCloud ? "in AWS" : undefined]
        .filter(Boolean)
        .join(" and ") || "nowhere (deploy: none)"
    }`,
  );

  lines.push("");
  lines.push(`  ${bold("Steps")}`);
  describeStep(workflow, workflow.root, 0, lines);

  lines.push("");
  lines.push(`  ${bold("Workloads it invokes")}`);
  if (workflow.targets.length === 0) lines.push(`    ${dim("none")}`);
  for (const reference of workflow.targets) {
    const { kind, id } = parseTargetReference(reference);
    const enabledLocally = isTargetEnabled(config, kind, id, "local");
    // The one thing a developer most often wants to know before running it.
    const placement =
      kind === "lambda"
        ? `${resolveLambdaTarget(config, id).packaging === "container" ? "container image" : "node child process"} locally`
        : kind === "task"
          ? "container locally"
          : "interpreted locally";
    lines.push(
      `    ${reference} ${dim(enabledLocally ? placement : "not enabled for local execution")}`,
    );
  }

  lines.push("");
  lines.push(`  ${bold("Resources it talks to")}`);
  if (workflow.integrations.length === 0) lines.push(`    ${dim("none")}`);
  for (const use of workflow.integrations) {
    const key = integrationKey(use.reference);
    const via = needsDevelopmentBridge(use.reference)
      ? "through its generated development bridge"
      : "directly, with your AWS credentials";
    lines.push(
      `    ${key} ${dim(`${use.operations.join(", ")}${use.awaitsCallback ? " (suspends for a callback)" : ""} — ${via}`)}`,
    );
  }

  if (workflow.integrations.length > 0) {
    lines.push("");
    lines.push(`  ${bold("Bindings it needs before this can be built")}`);
    for (const use of workflow.integrations) {
      const spec = use.reference;
      const call =
        spec.kind === "httpConnection"
          ? `bindWorkflowHttpConnection(this, <reference>, connection, { endpoint })`
          : spec.kind === "awsOperation"
            ? `bindWorkflowAwsOperation(this, <reference>, { grant, parameters })`
            : `linkResources(this, resources.<stack>) beside the ${spec.kind}, in a stack built before createFrameworkWorkflows`;
      lines.push(`    ${integrationKey(spec)} ${dim(call)}`);
    }
  }

  return lines.join("\n");
}

function main(): void {
  const requested = process.argv.slice(2).filter((argument) => !argument.startsWith("-"));
  const all = getWorkflows(framework as FrameworkConfig);
  const selected =
    requested.length === 0
      ? all
      : all.filter((workflow) => requested.includes(workflow.id));

  if (selected.length === 0) {
    const known = all.map((workflow) => workflow.id).join(", ");
    console.error(
      `No workflow matched ${requested.join(", ")}. Declared: ${known || "none"}.`,
    );
    process.exitCode = 1;
    return;
  }

  for (const [index, workflow] of selected.entries()) {
    if (index > 0) console.log("");
    console.log(describeWorkflow(framework as FrameworkConfig, workflow));
  }

  const localWorkflows = getLocalTargets(framework as FrameworkConfig, ["workflow"]);
  if (localWorkflows.length > 0) {
    console.log("");
    console.log(
      dim(
        "Local execution runs orchestration and compute on this machine; DynamoDB, SQS, SNS and EventBridge stay in AWS. Run npm run export:cdk-outputs so the runner knows which resources those are.",
      ),
    );
  }
}

main();
