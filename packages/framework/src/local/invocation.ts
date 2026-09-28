import path from "node:path";
import {
  getFrameworkTargets,
  getInvocationBindings,
  getLocalTargets,
  parseTargetReference,
  resolveTaskTarget,
  resolveWorkflow,
  INVOCATION_DESCRIPTOR_VERSION,
  type ContainerArchitecture,
  type FrameworkConfig,
  type FrameworkDirectory,
  type LocalServiceResource,
  type NormalizedWorkflow,
  type TargetReference,
  type TaskTarget,
} from "@repo/framework/config";
import {
  findDockerfile,
  findRepositoryRoot,
  readDockerfileStages,
  resolveFrameworkDirectory,
} from "@repo/framework/config/source";

/**
 * The local projection of the invocation inventory.
 *
 * Two things, from the same declarations the cloud lane reads: what a task run
 * needs in order to start on this machine, and which descriptors a caller is
 * given so the shared runtime helper picks the local transport.
 *
 * The descriptors written here are always `transport: "local"`. That is not a
 * fallback and not a guess — a process started by Compose is on the Compose
 * network and cannot be redirected by a CDK flag, an AWS credential appearing
 * in the environment, or exported production outputs. The AWS projection is
 * written by CDK, into processes that really do run in AWS.
 *
 * Nothing here contacts Docker, resolves a secret value, or reads an exported
 * target ARN: a local destination is derived from the declared binding, never
 * from what a deployment happened to publish.
 */

/** One enabled task, resolved against this repository. */
export interface ResolvedLocalTaskPlan {
  readonly id: string;
  readonly reference: TaskTarget;
  readonly directory: FrameworkDirectory;
  /** Posix path from the repository root. */
  readonly relativeDirectory: string;
  /** Posix path from the repository root; the build context is the root itself. */
  readonly dockerfile: string;
  readonly buildTarget?: string;
  readonly architecture: ContainerArchitecture;
  /** Fargate CPU units, applied locally as a fractional CPU limit. */
  readonly cpu: number;
  readonly memoryMiB: number;
  readonly resources: readonly LocalServiceResource[];
}

export interface LocalInvocationGraph {
  readonly repositoryRoot: string;
  readonly tasks: readonly ResolvedLocalTaskPlan[];
  readonly workflows: readonly NormalizedWorkflow[];
}

export interface LocalInvocationPlanOptions {
  readonly repositoryRoot?: string;
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

function planTask(
  config: FrameworkConfig,
  id: string,
  repositoryRoot: string,
): ResolvedLocalTaskPlan {
  const target = resolveTaskTarget(config, id);
  const absoluteDirectory = resolveFrameworkDirectory(
    target.directory,
    `task:${id}`,
    { repositoryRoot },
  );
  const dockerfile = findDockerfile(absoluteDirectory);
  if (!dockerfile) {
    throw new Error(
      `task:${id} is enabled locally, but ${absoluteDirectory} has no Dockerfile.`,
    );
  }
  if (target.cloud.buildTarget) {
    const stages = readDockerfileStages(dockerfile);
    if (!stages.includes(target.cloud.buildTarget)) {
      throw new Error(
        `task:${id} builds stage "${target.cloud.buildTarget}", which ${dockerfile} does not define. ` +
          (stages.length > 0
            ? `It defines ${stages.join(", ")}.`
            : "It defines no named stages."),
      );
    }
  }

  return {
    id,
    reference: target.reference,
    directory: target.directory,
    relativeDirectory: toPosix(path.relative(repositoryRoot, absoluteDirectory)),
    dockerfile: toPosix(path.relative(repositoryRoot, dockerfile)),
    ...(target.cloud.buildTarget === undefined
      ? {}
      : { buildTarget: target.cloud.buildTarget }),
    architecture: target.cloud.architecture,
    cpu: target.cloud.cpu,
    memoryMiB: target.cloud.memoryMiB,
    resources: target.local.resources,
  };
}

export function planLocalInvocation(
  config: FrameworkConfig,
  options: LocalInvocationPlanOptions = {},
): LocalInvocationGraph {
  const repositoryRoot = options.repositoryRoot ?? findRepositoryRoot(process.cwd());
  const tasks = getLocalTargets(config, ["task"])
    .map((target) => target.id)
    .sort()
    .map((id) => planTask(config, id, repositoryRoot));
  const workflows = getLocalTargets(config, ["workflow"])
    .map((target) => target.id)
    .sort()
    .map((id) => resolveWorkflow(config, id));
  return { repositoryRoot, tasks, workflows };
}

export function findLocalTaskPlan(
  graph: LocalInvocationGraph,
  id: string,
): ResolvedLocalTaskPlan | undefined {
  return graph.tasks.find((task) => task.id === id);
}

/**
 * The local descriptors one caller receives.
 *
 * Derived from that caller's own declared bindings, so a caller with no binding
 * receives an empty map — and, inside the scoped local execution context, a
 * lookup that finds nothing fails exactly as it would in AWS. Merging every
 * target's descriptors into one environment is the mistake this exists to
 * prevent.
 *
 * Each document also names the caller it was issued to. That is not a new
 * grant: the runner still checks the declared edge from the config, and a
 * descriptor a target never received cannot be read in the first place. It is
 * what makes `runTask(id, input)` behave the same way here as in AWS.
 */
export function localInvocationDescriptors(
  config: FrameworkConfig,
  caller: TargetReference,
  runnerUrl: string,
): Readonly<Record<string, string>> {
  const target = getFrameworkTargets(config).find(
    (candidate) => candidate.reference === caller,
  );
  if (!target) return {};

  const endpoint = runnerUrl.replace(/\/+$/, "");
  const descriptors: Record<string, string> = {};
  for (const binding of getInvocationBindings(target.cloud.bindings)) {
    const kind = binding.capability === "runsTask" ? "task" : "workflow";
    const id = binding.capability === "runsTask" ? binding.task : binding.workflow;
    descriptors[binding.environment] = JSON.stringify({
      version: INVOCATION_DESCRIPTOR_VERSION,
      kind,
      transport: "local",
      target: id,
      runnerUrl: endpoint,
      // Written down because this projection is already per-caller: the
      // document belongs to `caller` and to nobody else, so the runtime can
      // tell the runner who is calling without the handler repeating its own
      // id at every call site. AWS needs no equivalent - there the caller's
      // own role is the check.
      caller,
    });
  }
  return descriptors;
}

/**
 * Whether `caller` really declared an edge to `target`.
 *
 * The local half of the cloud grant, checked from the same declarations. The
 * private runner calls this before accepting a submission, so an HTTP request's
 * payload cannot choose or override a binding — a caller may launch only what
 * its own config entry says it may.
 */
export function assertLocalInvocationEdge(
  config: FrameworkConfig,
  caller: string | undefined,
  target: TargetReference,
): void {
  const { kind, id } = parseTargetReference(target);
  if (kind !== "task" && kind !== "workflow") {
    throw new Error(`"${target}" is not a task or workflow target.`);
  }
  if (!caller) {
    throw new Error(
      `A submission for "${target}" named no caller. The runner checks the declared binding, so the calling target has to identify itself.`,
    );
  }
  const source = getFrameworkTargets(config).find(
    (candidate) => candidate.reference === caller,
  );
  if (!source) {
    throw new Error(`Caller "${caller}" is not declared in framework.config.ts.`);
  }
  const declared = getInvocationBindings(source.cloud.bindings).some((binding) =>
    kind === "task"
      ? binding.capability === "runsTask" && binding.task === id
      : binding.capability === "startsWorkflow" && binding.workflow === id,
  );
  if (!declared) {
    throw new Error(
      `Caller "${caller}" does not declare ${kind === "task" ? `runsTask("${id}")` : `startsWorkflow("${id}")`}. Add the binding to its cloud.bindings; the runner grants nothing a config entry did not.`,
    );
  }
}

/**
 * The descriptors a workflow's own steps need.
 *
 * A workflow has no bindings of its own — it derives its edges from the graph —
 * so the interpreter resolves each step target directly rather than through a
 * descriptor. This exists for the isolated child process a Lambda step runs in:
 * that handler may itself declare a `runsTask` binding, and it gets its own
 * descriptors and nobody else's.
 */
export function stepInvocationEnvironment(
  config: FrameworkConfig,
  step: TargetReference,
  runnerUrl: string,
): Readonly<Record<string, string>> {
  return localInvocationDescriptors(config, step, runnerUrl);
}
