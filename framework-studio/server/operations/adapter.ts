import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { repositoryTargets } from "@repo/framework/deploy/node";
import { disposeAwsExecutionSnapshots, readAwsFiles } from "../../../scripts/aws-connections";
import { writeDeploymentRecordAtomic } from "../../../scripts/deployment-artifact";
import type { JobLogLine, JobView, OperationIntent, OperationRequest } from "../../shared/operations";
import { OPERATIONS_VERSION } from "../../shared/operations";
import { buildOperation, exportDirectory, OperationError, type OperationContext } from "../deploy/registry";
import { PlanStore, TeardownStore } from "../deploy/plans";
import { AwsObserver } from "../deploy/observe";
import { LocalEnvironment, persistedLocalHolder } from "../deploy/local";
import { probeDocker } from "../deploy/prereqs";
import { runCommand, Tools } from "../deploy/process";
import type { JobSpec } from "../deploy/jobs";
import type { OperationRecord } from "../../shared/operations";

export const RUNNER_KINDS = new Set(["deploy-plan", "deploy-apply", "deploy-discard", "destroy", "drift", "export", "framework-check"]);
const PARAMETERS: Readonly<Record<string, readonly string[]>> = {
  "deploy-plan": ["deployment", "profile", "region", "review", "createSecrets", "autoApply"],
  "deploy-apply": ["plan", "profile", "confirm", "currentSource"], "deploy-discard": ["plan", "profile"],
  destroy: ["deployment", "mode", "profile", "region", "confirm", "review", "retainFailed"],
  drift: ["deployment", "profile", "region"], export: ["deployment", "profile", "region"], "framework-check": [],
};

/** Intent validation precedes durable storage: private/unrecognized fields never enter the journal. */
export function validateRequest(request: OperationRequest): void {
  if (!request || !RUNNER_KINDS.has(request.kind)) throw new OperationError(400, "This operation is not supported by the host runner.");
  if (!request.params || typeof request.params !== "object" || Array.isArray(request.params)) throw new OperationError(400, "Supply named operation parameters.");
  for (const [key, value] of Object.entries(request.params)) {
    if (!PARAMETERS[request.kind]!.includes(key) || !["string", "boolean", "undefined"].includes(typeof value)) throw new OperationError(400, "Unsupported operation parameter.");
    if (typeof value === "string" && (value.length > 1024 || /[\x00-\x1f]/.test(value))) throw new OperationError(400, "Invalid operation parameter.");
  }
  if (request.requestKey !== undefined && !/^[a-zA-Z0-9_-]{8,128}$/.test(request.requestKey)) throw new OperationError(400, "Supply a valid request key.");
}

function contextFor(root: string, state: string, planId?: string, note: (text: string, stream?: JobLogLine["stream"]) => void = () => {}, emit: (event: "deploy-stacks" | "deploy-event", data: unknown) => void = () => {}) {
  const env = process.env;
  const tools = new Tools(root, env);
  const plans = new PlanStore(state, root, env);
  if (planId) plans.allocate = () => planId;
  const observer = new AwsObserver(tools, runCommand, env);
  const context: OperationContext = {
    root, env, tools, plans, observer, run: runCommand, managed: {},
    teardowns: new TeardownStore(state), exportDirectory: exportDirectory(root, env),
    local: new LocalEnvironment(root, tools, runCommand, env, exportDirectory(root, env), state),
    jobs: { holder: lock => persistedLocalHolder(state, lock) },
    targets: () => repositoryTargets(root).map(entry => ({ ...entry })),
    profiles: () => observer.profiles(),
    probeDocker: () => probeDocker(tools, runCommand, env),
    startManaged: () => { throw new Error("Persistent development sessions are not runner operations."); },
    stopManaged: async () => { throw new Error("Persistent development sessions are not runner operations."); },
    setDrift: (deployment, view) => {
      const key = createHash("sha256").update(JSON.stringify([view.account, view.region, deployment])).digest("hex");
      writeDeploymentRecordAtomic(path.join(state, "operations", `drift-${key}.json`), view);
    }, changed: () => {},
    followStacks: (_id, profile, deployment, region) => {
      let observedContext: { account?: string; region?: string } = { region };
      const watch = observer.watch(profile, deployment, region, line => {
        if (line.type === "context") observedContext = line.context as { account?: string; region?: string };
        if (line.type === "stacks") {
          for (const stack of (line.stacks ?? []) as { name: string; status: string }[]) note(`CloudFormation · ${stack.name} ${stack.status}`);
          emit("deploy-stacks", { deployment, profile, ...observedContext, stacks: line.stacks });
        }
        if (line.type === "event") {
          const detail = line.event as { logicalId?: string; status?: string; reason?: string };
          if (detail) note(`CloudFormation · ${String(line.stack)} · ${detail.logicalId ?? ""} ${detail.status ?? ""}${detail.reason ? ` — ${detail.reason}` : ""}`);
          emit("deploy-event", { deployment, profile, ...observedContext, stack: line.stack, event: detail });
        }
      });
      return () => watch.stop();
    },
  };
  return { context, close: () => { observer.dispose(); disposeAwsExecutionSnapshots(); } };
}

function publicBinding(root: string, state: string, request: OperationRequest): string {
  let evidence: unknown = null;
  if (request.kind === "deploy-apply" || request.kind === "deploy-discard") {
    const directory = new PlanStore(state).path(String(request.params.plan));
    const file = path.join(directory, existsSync(path.join(directory, "plan.json")) ? "plan.json" : "preparing.json");
    evidence = readFileSync(file, "utf8");
  } else if (request.kind === "destroy") evidence = readFileSync(new TeardownStore(state).path(String(request.params.review)), "utf8");
  else if (request.kind !== "framework-check") evidence = repositoryTargets(root).find(target => target.name === request.params.deployment) ?? null;
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

export async function prepareIntent(root: string, state: string, request: OperationRequest): Promise<OperationIntent> {
  validateRequest(request);
  const runtime = contextFor(root, state);
  try {
    const spec = await buildOperation(runtime.context, request);
    return {
      version: OPERATIONS_VERSION, workspace: realpathSync(root), request,
      // Conservative checkout tooling exclusion also protects the CLI and export paths.
      locks: [...new Set(["workspace-tooling", ...spec.locks])].sort(),
      ...(request.kind === "deploy-apply" ? { consumptionKey: `apply:${String(request.params.plan)}` } : {}),
      ...(request.kind === "destroy" ? { consumptionKey: `destroy:${String(request.params.review)}` } : {}),
      binding: publicBinding(root, state, request),
      view: { kind: spec.kind, title: spec.title, params: spec.params, planId: spec.planId, deployment: spec.deployment,
        steps: spec.steps.map(step => ({ label: step.label, status: "pending" })), origin: request.kind === "framework-check" ? "/" : "/deploy" },
    };
  } finally { runtime.close(); }
}

/** Reconstruct trusted code in the worker, and repeat the domain's preconditions there. */
export async function executionSpec(root: string, state: string, intent: OperationIntent, note: (text: string, stream?: JobLogLine["stream"]) => void, emit?: (event: "deploy-stacks" | "deploy-event", data: unknown) => void): Promise<{ spec: JobSpec; close(): void }> {
  validateRequest(intent.request);
  if (intent.version !== OPERATIONS_VERSION || intent.workspace !== realpathSync(root) || intent.binding !== publicBinding(root, state, intent.request)) throw new Error("The accepted review or target changed. Review again; this operation will not execute.");
  const runtime = contextFor(root, state, intent.view.planId, note, emit);
  try {
    const spec = await buildOperation(runtime.context, intent.request);
    if (spec.deployment !== intent.view.deployment || spec.planId !== intent.view.planId) throw new Error("The accepted destination changed.");
    return { spec, close: runtime.close };
  } catch (error) { runtime.close(); throw error; }
}

/** Private values are used only in worker memory to sanitize before any durable log write. */
export function privateValues(root: string, state: string, intent: OperationIntent): string[] {
  const files = new Set([path.join(root, "cdk-app/.env.dev"), path.join(root, "cdk-app/.env.prod"), path.join(root, ".env")]);
  if (process.env.FRAMEWORK_INPUTS_FILE) files.add(path.resolve(process.env.FRAMEWORK_INPUTS_FILE));
  if (intent.view.planId) {
    const file = path.join(new PlanStore(state).path(intent.view.planId), "plan.json");
    if (existsSync(file)) {
      const plan = JSON.parse(readFileSync(file, "utf8"));
      if (typeof plan.target?.inputsFile === "string") files.add(plan.target.inputsFile);
    }
  }
  if (intent.request.kind === "deploy-plan") {
    const target = repositoryTargets(root).find(target => target.name === intent.view.deployment);
    if (target?.inputs) files.add(path.resolve(root, target.inputs));
  }
  const values = Object.entries(process.env).filter(([key]) => /SECRET|TOKEN|PASSWORD|ACCESS_KEY|CREDENTIAL/i.test(key)).map(([, value]) => value ?? "");
  for (const file of files) if (existsSync(file)) values.push(...Object.values(parseEnv(readFileSync(file, "utf8"))).filter((value): value is string => value !== undefined));
  for (const file of Object.values(readAwsFiles(process.env)).filter((value): value is { text: string; path: string; exists: boolean } => typeof value === "object" && value !== null && "text" in value)) {
    for (const line of file.text.split(/\r?\n/)) if (/^\s*(aws_access_key_id|aws_secret_access_key|aws_session_token)\s*=/i.test(line)) values.push(line.slice(line.indexOf("=") + 1).trim());
  }
  return values.filter(Boolean);
}

export function domainOutcome(state: string, intent: OperationIntent, execution?: { readonly autoApplyStep?: NonNullable<JobView["steps"]>[number]["status"] }): Pick<JobView, "outcome" | "recovery"> {
  if (intent.request.kind === "deploy-plan" && intent.request.params.autoApply === true && execution?.autoApplyStep === "skipped") {
    // Only this worker's observed skip proves no apply command ran. Mutable plan status
    // and missing result files cannot establish that after execution has been lost.
    return { outcome: "unverified", recovery: "Planning finished without applying. Inspect the saved review and its prerequisites before a separately authorized apply." };
  }
  if (intent.request.kind === "deploy-apply" || intent.request.params.autoApply === true) {
    const result = intent.view.planId ? new PlanStore(state).read(intent.view.planId)?.result : undefined;
    if (result?.status === "succeeded" && result.verification.verified) return { outcome: "confirmed" };
    return { outcome: result ? "unverified" : "uncertain", recovery: "Inspect the saved review and AWS stack status. Never rerun this apply; export failures can be addressed separately." };
  }
  if (intent.request.kind === "destroy") return { outcome: "unverified", recovery: "Inspect the teardown receipt and AWS to verify the final resource state." };
  if (intent.request.kind === "deploy-discard") return { outcome: "unverified", recovery: "The discard command completed. Refresh AWS observations to confirm remaining change sets and resources." };
  return { outcome: "confirmed" };
}

/** Observation of a durable CLI result never converts lost execution into a rerunnable attempt. */
export function reconcileOutcome(record: OperationRecord, state: string): Partial<JobView> | undefined {
  if (record.view.execution !== "lost" || record.view.outcome !== "uncertain" || !record.intent.view.planId) return;
  if (record.intent.request.kind !== "deploy-apply") return;
  try {
    if (record.intent.binding !== publicBinding(record.intent.workspace, state, record.intent.request)) return;
    const directory = new PlanStore(state).path(record.intent.view.planId);
    const plan = JSON.parse(readFileSync(path.join(directory, "plan.json"), "utf8"));
    const rawResult = JSON.parse(readFileSync(path.join(directory, "result.json"), "utf8"));
    if (!plan.planId || rawResult.planId !== plan.planId) return;
    const result = new PlanStore(state).read(record.intent.view.planId)?.result;
    if (result?.status === "succeeded" && result.verification.verified) return {
      outcome: "confirmed", summary: "The worker was lost, but the CLI recorded verified infrastructure completion.",
      recovery: "The apply remains consumed and its resource claims stay held. Inspect the saved result, AWS, and local process/export cleanup before explicit recovery.",
    };
  } catch { /* Unreadable evidence preserves uncertainty and resource claims. */ }
}
