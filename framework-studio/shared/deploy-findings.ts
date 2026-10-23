import type {
  AccountContext, AwsProblem, AwsProfileInfo, DiscoveredDeploymentView, JobView, LocalRunView, PlanSummaryView, StatusView, TargetView,
} from "./deploy";

/**
 * What Deploy & Run says about one deployment, and what it offers next.
 *
 * Pure: it reconciles three states it is handed — the repository's intent (the
 * target), what AWS holds (discovery and status) and this machine (exports,
 * containers, processes) — into findings, most important first. Nothing here
 * acts; every action is an operation the person starts, and production is only
 * ever planned for review.
 */

export type ActionId =
  | "sign-in" | "refresh" | "deploy" | "plan" | "review-plan" | "discard-plan"
  | "export" | "start" | "start-exported" | "stop" | "apply-changes" | "resume-watch"
  | "start-docker" | "delete";

export interface Action {
  readonly id: ActionId;
  readonly label: string;
  readonly plan?: string;
  readonly tone?: "primary" | "quiet" | "danger";
  /** Why it cannot be taken now. */
  readonly disabled?: string;
}

export interface Finding {
  readonly code: string;
  readonly severity: "blocking" | "attention" | "info";
  readonly scope: "identity" | "aws" | "local";
  readonly title: string;
  readonly detail?: string;
  readonly actions: readonly Action[];
}

export interface FindingsInput {
  readonly name: string;
  /** The repository's target of this name; absent for a deployment only discovered. */
  readonly target?: Omit<TargetView, "status" | "detail">;
  /** How discovery matched the target against the account. */
  readonly match?: TargetView;
  readonly deployment?: DiscoveredDeploymentView;
  readonly detail?: StatusView["detail"];
  readonly context?: AccountContext;
  /** The profile chosen, named in a sign-in prompt before any account is known. */
  readonly profile?: string;
  readonly problem?: AwsProblem;
  readonly profileKind?: AwsProfileInfo["kind"];
  readonly local: LocalRunView;
  readonly plans: readonly PlanSummaryView[];
  readonly jobs: readonly JobView[];
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const short = (name: string, deployment: string) => (name.startsWith(`${deployment}-`) ? name.slice(deployment.length + 1) : name);

export function deploymentFindings(input: FindingsInput): Finding[] {
  const findings: Finding[] = [];
  const { name, target, deployment, detail, context } = input;
  const mode = target?.mode ?? deployment?.mode ?? "dev";
  const running = input.jobs.find((job) => job.status === "running" && job.deployment === name);
  const busy = running ? `${running.title} is running.` : undefined;
  const cloud = (action: Action): Action => (busy ? { ...action, disabled: busy } : action);

  if (input.problem) {
    const signedOut = input.problem.kind === "expired" || input.problem.kind === "no-credentials";
    const canSignIn = signedOut && (input.profileKind === "sso" || input.profileKind === "login");
    findings.push({
      code: signedOut ? "SIGNED_OUT" : "AWS_UNREADABLE", severity: "blocking", scope: "aws",
      title: signedOut ? `Sign in to ${input.profile ?? context?.profile ?? "this profile"}` : "AWS could not be read",
      detail: canSignIn || !signedOut ? input.problem.message : `${input.problem.message} Refresh this profile's credentials, then refresh.`,
      actions: [canSignIn ? { id: "sign-in", label: "Sign in", tone: "primary" } : { id: "refresh", label: "Try again" }],
    });
    return findings;
  }

  if (running) {
    findings.push({ code: "OPERATION_RUNNING", severity: "attention", scope: "aws", title: running.title, detail: "Its progress is in Activity. Other changes to this deployment wait until it ends.", actions: [] });
  }

  if (target?.account && context && target.account !== context.account) {
    findings.push({
      code: "ACCOUNT_CONFLICT", severity: "blocking", scope: "identity",
      title: `${name} lives in another account`,
      detail: `${name} is pinned to account ${target.account}; the profile ${context.profile} reaches ${context.account}. Choose a profile for ${target.account}.`,
      actions: [],
    });
    return findings;
  }

  if (!target) {
    findings.push({
      code: "NOT_DECLARED", severity: "info", scope: "identity",
      title: "Discovered in this account, not declared here",
      detail: `Source and deployment controls are unavailable because this repository does not declare ${name}. Identity-based deletion remains available through a separate review.`,
      actions: deployment ? [cloud({ id: "delete", label: "Delete…", tone: "danger" })] : [],
    });
  }

  const state = deployment?.state;
  if (state?.kind === "conflict" || input.match?.status === "conflict") {
    findings.push({
      code: "CONFLICT", severity: "blocking", scope: "identity",
      title: "Stacks of this name are not this deployment's",
      detail: state?.kind === "conflict" ? state.message : input.match?.detail,
      actions: [],
    });
    return findings;
  }
  if (input.match?.status === "elsewhere") {
    // What this region holds says nothing about the account or region the target is pinned to.
    findings.push({ code: "ELSEWHERE", severity: "info", scope: "aws", title: "Pinned to another account or region", detail: input.match.detail, actions: [] });
    return findings;
  }

  const deployLabel = (_exists: boolean) => "Compare AWS templates";
  const deployAction = (exists: boolean): Action => cloud(mode === "dev" ? { id: "deploy", label: deployLabel(exists), tone: "primary" } : { id: "plan", label: deployLabel(exists), tone: "primary" });

  // Reviewed plans come first: one was made to be applied (unless it is being applied now).
  const ours = input.plans.filter((entry) => entry.deployment === name && entry.mode === mode && entry.account === context?.account && entry.region === context?.region && (!entry.profile || entry.profile === input.profile));
  for (const plan of ours.filter((entry) => !entry.applied && entry.key !== running?.planId)) {
    if (plan.status === "unfinished") {
      findings.push({
        code: "PLAN_UNFINISHED", severity: "attention", scope: "aws", title: "A plan stopped part-way",
        detail: "It had prepared change sets (and may have created empty stacks to hold them) before it stopped. Discard it to remove them.",
        actions: [cloud({ id: "discard-plan", label: "Discard", plan: plan.key, tone: "primary" })],
      });
    } else if (plan.expired) {
      findings.push({ code: "PLAN_EXPIRED", severity: "info", scope: "aws", title: "An expired plan", detail: "Discarding it removes any change sets it prepared.", actions: [cloud({ id: "discard-plan", label: "Discard", plan: plan.key, tone: "quiet" })] });
    } else if (plan.status !== "no-changes" || plan.retainedStacks) {
      findings.push({
        code: "PLAN_WAITING", severity: "attention", scope: "aws",
        title: plan.retainedStacks ? `${plan.retainedStacks} deployed stack${plan.retainedStacks === 1 ? " is" : "s are"} kept outside current source` : plan.status === "blocked" ? "Deployment analysis is incomplete" : plan.status === "needs-secrets" ? "A plan needs new secrets created" : "A reviewed plan is waiting",
        detail: plan.status === "needs-secrets" ? "A change set can only reference a secret that exists." : `Made ${new Date(plan.createdAt).toLocaleString()}.`,
        actions: [cloud({ id: "review-plan", label: "Review plan", plan: plan.key, tone: "primary" }), cloud({ id: "discard-plan", label: "Discard", plan: plan.key, tone: "quiet" })],
      });
    }
  }

  // The newest plan was applied in part: what it deferred can be planned now.
  const latest = [...ours].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (latest?.applied && latest.applied !== "succeeded" && latest.applied !== "partial") findings.push({
    code: "OPERATION_UNVERIFIED", severity: "blocking", scope: "aws", title: latest.applied === "export-failed" ? "Infrastructure verified; local settings export failed" : "The last deployment needs recovery", detail: "Outcome: " + latest.applied + ". Review the recorded result before planning further changes. CloudFormation completion does not establish application health.", actions: [cloud({ id: "review-plan", label: "Review deployment result", plan: latest.key, tone: "primary" }), ...(latest.applied === "export-failed" ? [cloud({ id: "export", label: "Retry settings export" })] : [])],
  });
  if (latest?.applied === "partial" && latest.deferred?.length && target) {
    findings.push({
      code: "PLAN_PARTIAL", severity: "attention", scope: "aws",
      title: `${plural(latest.deferred.length, "stack")} still to plan`,
      detail: `${latest.deferred.map((stack) => short(stack, name)).join(", ")}: each imports what the last apply created, so CloudFormation can plan it now.`,
      actions: [cloud({ id: "plan", label: "Plan the remaining stacks", tone: "primary" })],
    });
  }

  const exists = Boolean(deployment && state && state.kind !== "absent");
  if (!exists) {
    if (target) {
      findings.push({
        code: "TARGET_ABSENT", severity: "info", scope: "aws",
        title: "Not deployed here",
        detail: context ? `Nothing of ${name} exists in ${context.account} · ${context.region}.` : undefined,
        actions: [deployAction(false)],
      });
    }
  } else if (state?.kind === "in-progress" && state.stacks.filter((entry) => entry.health !== "complete").every((entry) => entry.health === "review")) {
    const waiting = state.stacks.filter((entry) => entry.health === "review");
    findings.push({ code: "AWAITING_REVIEW", severity: "info", scope: "aws", title: `${plural(waiting.length, "stack")} await a plan's review`, detail: `${waiting.map((entry) => short(entry.name, name)).join(", ")}: created to hold change sets. They hold no resources until the plan is applied; discarding the plan removes them.`, actions: [] });
  } else if (state?.kind === "in-progress") {
    const active = state.stacks.filter((entry) => entry.health === "in-progress");
    findings.push({ code: "IN_PROGRESS", severity: "attention", scope: "aws", title: `CloudFormation is working on ${plural(active.length || state.stacks.length, "stack")}`, detail: active.map((entry) => `${short(entry.name, name)} ${entry.status}`).join(", "), actions: [] });
  } else if (state?.kind === "failed") {
    const failed = state.stacks.filter((entry) => entry.health !== "complete");
    const list = failed.map((entry) => `${short(entry.name, name)} (${entry.status})`).join(", ");
    findings.push(state.deployable && target
      ? { code: "FAILED", severity: "attention", scope: "aws", title: `${plural(failed.length, "stack")} failed`, detail: `${list}. Deploying again recovers them: CloudFormation recreates a failed first create and resumes a paused update.`, actions: [deployAction(true)] }
      : { code: "FAILED_STUCK", severity: "blocking", scope: "aws", title: `${plural(failed.length, "stack")} cannot be updated`, detail: `${list}. Continue the rollback in the CloudFormation console, or delete the deployment.`, actions: [cloud({ id: "delete", label: "Delete…", tone: "danger" })] });
  } else if (state?.kind === "rolled-back") {
    findings.push({ code: "ROLLED_BACK", severity: "attention", scope: "aws", title: "The last update was rolled back", detail: "AWS holds the version before it. Fix what failed (see Events), then deploy again.", actions: target ? [deployAction(true)] : [] });
  } else if (state?.kind === "ready") {
    findings.push({ code: "DEPLOYED", severity: "info", scope: "aws", title: latest?.applied && latest.applied !== "succeeded" && latest.applied !== "partial" && latest.applied !== "export-failed" ? "CloudFormation stacks complete; release needs verification" : `Deployed · ${plural(deployment!.stacks.length, "stack")}`, actions: target ? [{ ...deployAction(true), tone: "quiet" }] : [] });
  }
  if (deployment?.contracts.includes(1)) {
    findings.push({ code: "CONTRACT_V1", severity: "info", scope: "identity", title: "Identity recorded the older way", detail: "Contract 1: the next deployment adds stack tags and template metadata, changing no resource.", actions: [] });
  }
  const foreign = detail?.changeSets.filter((set) => !set.ours) ?? [];
  if (foreign.length) {
    findings.push({ code: "FOREIGN_CHANGE_SETS", severity: "attention", scope: "aws", title: `${plural(foreign.length, "change set")} made outside the framework`, detail: foreign.map((set) => `${short(set.stack, name)}: ${set.name} (${set.status})`).join(", "), actions: [] });
  }

  if (mode === "dev" && target) findings.push(...localFindings(input, exists, state?.kind === "ready" || state?.kind === "rolled-back", busy));
  return findings;
}

/** Operations that change this machine: while one runs, the others wait. */
const LOCAL_KINDS = new Set(["local-start", "local-stop", "local-restart", "local-attach-watch", "export", "deps-install", "docker-start"]);

function localFindings(input: FindingsInput, exists: boolean, usable: boolean, busy: string | undefined): Finding[] {
  const running = input.jobs.find((job) => job.status === "running" && LOCAL_KINDS.has(job.kind));
  const findings = machineFindings(input, exists, usable, busy);
  if (!running) return findings;
  const reason = `${running.title} is running.`;
  return findings.map((finding) => ({ ...finding, actions: finding.actions.map((action) => (action.disabled ? action : { ...action, disabled: reason })) }));
}

function machineFindings(input: FindingsInput, exists: boolean, usable: boolean, busy: string | undefined): Finding[] {
  const { name, local, detail } = input;
  const findings: Finding[] = [];
  const exported = local.exported.deployment;
  const runningHere = local.startedBy !== "none";
  const runningServices = local.services.filter((service) => service.state === "running" && !service.oneShot);
  const stopAction: Action = { id: "stop", label: "Stop development", tone: "quiet" };

  if (!exists) {
    if (exported === name) {
      findings.push({
        code: "EXPORT_ORPHAN", severity: "attention", scope: "local",
        title: `This machine's settings point at ${name}, which is not deployed here`,
        detail: "Local services would call AWS resources that no longer exist. Deploy it again, or stop development.",
        actions: [busy ? { id: "deploy", label: "Compare AWS templates", tone: "primary", disabled: busy } : { id: "deploy", label: "Compare AWS templates", tone: "primary" }, ...(runningHere ? [stopAction] : [])],
      });
    }
    return findings;
  }
  if (!usable) return findings;
  if (detail?.local && !detail.local.compatible) {
    findings.push({ code: "LOCAL_INCOMPATIBLE", severity: "blocking", scope: "local", title: "Local development cannot run against this deployment", detail: detail.local.problem, actions: [] });
    return findings;
  }
  const dockerDown = local.docker.engine !== "running";
  const dockerAction: Action[] = local.docker.desktop && dockerDown ? [{ id: "start-docker", label: "Start Docker Desktop", tone: "primary" }] : [];

  if (exported !== name) {
    if (runningHere && exported) {
      findings.push({
        code: "LOCAL_ELSEWHERE", severity: "info", scope: "local",
        title: `Local development runs against ${exported}`,
        detail: `Stop it to run against ${name}.`,
        actions: [stopAction],
      });
      return findings;
    }
    findings.push({
      code: "EXPORT_OTHER", severity: "attention", scope: "local",
      title: exported ? `This machine's settings point at ${exported}` : "This machine has no settings for local development",
      detail: `Export ${name}'s outputs to run locally against it.`,
      actions: dockerDown
        ? [...dockerAction, { id: "export", label: "Export settings", tone: "quiet" }]
        : [{ id: "start-exported", label: "Export and start development", tone: "primary" }, { id: "export", label: "Export only", tone: "quiet" }],
    });
    return findings;
  }
  if (detail?.local && !detail.local.exported.fresh) {
    findings.push({ code: "EXPORT_STALE", severity: "attention", scope: "local", title: "This machine's settings are older than the deployment", detail: "Export again so local services use the current outputs.", actions: [{ id: "export", label: "Refresh settings", tone: "primary" }] });
  }
  if (!runningHere) {
    if (dockerDown) {
      findings.push({
        code: "DOCKER_DOWN", severity: "attention", scope: "local",
        title: local.docker.engine === "missing" ? "Docker is not installed" : "Docker is not running",
        detail: local.docker.engine === "missing" ? "Install Docker Desktop to run locally." : "Local development runs in Docker.",
        actions: dockerAction,
      });
    }
    findings.push({ code: "READY_TO_START", severity: "info", scope: "local", title: "Ready to run locally", actions: [dockerDown ? { id: "start", label: "Start development", tone: "primary", disabled: "Docker is not running." } : { id: "start", label: "Start development", tone: "primary" }] });
    return findings;
  }
  if (local.restartNeeded.length) {
    findings.push({ code: "RESTART_NEEDED", severity: "attention", scope: "local", title: `${plural(local.restartNeeded.length, "service")} run with the previous settings`, detail: local.restartNeeded.join(", "), actions: [{ id: "apply-changes", label: "Apply changes", tone: "primary" }] });
  }
  if (!local.watch.running || !local.client.running) {
    const missing = [!local.watch.running ? "source changes are not synced into the containers" : undefined, !local.client.running ? "the web client is not running" : undefined].filter(Boolean).join(", and ");
    findings.push({
      code: "WATCH_DETACHED", severity: "attention", scope: "local",
      title: local.startedBy === "outside" ? "Started outside Studio" : "Development is partly running",
      detail: `${missing.charAt(0).toUpperCase()}${missing.slice(1)}.${[local.watch.summary && `The watch stopped: ${local.watch.summary}`, local.client.summary && `The web client stopped: ${local.client.summary}`].filter(Boolean).map((line) => ` ${line}`).join("")}`,
      actions: [{ id: "resume-watch", label: "Resume watching", tone: "primary" }],
    });
  }
  const unhealthy = local.services.filter((service) => service.health === "unhealthy" || (service.oneShot && service.exitCode !== undefined && service.exitCode !== 0));
  if (unhealthy.length) {
    findings.push({ code: "SERVICE_FAILING", severity: "attention", scope: "local", title: `${plural(unhealthy.length, "service")} failing`, detail: unhealthy.map((service) => `${service.name} (${service.health ?? `exited ${service.exitCode}`})`).join(", "), actions: [] });
  }
  findings.push({ code: "LOCAL_RUNNING", severity: "info", scope: "local", title: `Running · ${plural(runningServices.length, "service")}`, actions: [stopAction] });
  return findings;
}

const ORDER: Record<Finding["severity"], number> = { blocking: 0, attention: 1, info: 2 };

/** The one action to put forward: the first available action of the most pressing finding. */
export function nextAction(findings: readonly Finding[]): Action | undefined {
  if (findings.some((finding) => finding.code === "OPERATION_RUNNING")) return undefined;
  const ranked = [...findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  for (const finding of ranked) {
    const action = finding.actions.find((candidate) => !candidate.disabled && candidate.tone !== "quiet" && candidate.tone !== "danger");
    if (action) return action;
  }
  return undefined;
}
