import type { DeployOverview, DockerView, PrerequisiteView } from "./deploy";

/** One host observation, shared by every workspace. Job history is separate evidence. */
export interface DockerStatusView {
  readonly docker: DockerView;
  readonly checks: readonly PrerequisiteView[];
  readonly observedAt: string;
}

export function withDockerStatus(overview: DeployOverview, status: DockerStatusView): DeployOverview {
  return { ...overview, local: { ...overview.local, docker: status.docker },
    prerequisites: [...overview.prerequisites.filter(check => check.id !== "docker" && check.id !== "compose"), ...status.checks] };
}

/** Docker right now and the one thing to do about it. Job history never contributes. */
export interface DockerPresence {
  readonly label: string;
  readonly tone: "ok" | "warn" | "busy" | "unknown";
  readonly action: "start" | "check" | "install" | "none";
  /** Why, for states the label cannot explain. */
  readonly detail?: string;
  /** Present only when a current observation backs it. */
  readonly engine?: DockerView["engine"];
}

export function dockerPresence({ status, problem, starting }: {
  readonly status?: DockerStatusView | undefined;
  readonly problem?: { readonly status?: number; readonly message: string } | null;
  readonly starting: boolean;
}): DockerPresence {
  const engine = problem ? undefined : status?.docker.engine;
  if (engine === "running") return { label: "Docker running", tone: "ok", action: "none", engine };
  if (starting) return { label: "Starting Docker…", tone: "busy", action: "none", ...(engine ? { engine } : {}) };
  if (problem) {
    const detail = problem.message;
    // Check again cannot help either of these: the running server or this page is out of date.
    if (problem.status === 404) return { label: "Restart Studio to check Docker", tone: "unknown", action: "none", detail };
    if (problem.status === 401) return { label: "Reload Studio to check Docker", tone: "unknown", action: "none", detail };
    return { label: "Can't check Docker", tone: "unknown", action: "check", detail };
  }
  if (!engine) return { label: "Checking Docker…", tone: "unknown", action: "none" };
  if (engine === "stopped") return status?.docker.desktop
    ? { label: "Docker stopped", tone: "warn", action: "start", engine }
    : { label: "Docker stopped", tone: "warn", action: "check", detail: "Start your Docker engine, then check again.", engine };
  if (engine === "missing") return { label: "Docker not installed", tone: "warn", action: "install", engine };
  return { label: "Docker status unknown", tone: "unknown", action: "check", engine, ...(status?.docker.problem ? { detail: status.docker.problem } : {}) };
}

export function unavailableDockerStatus(message = "Docker status is unavailable. Check again."): DockerStatusView {
  return { docker: { engine: "unknown", desktop: false, problem: message }, observedAt: "",
    checks: [{ id: "docker", label: "Docker", status: "unknown", summary: message }] };
}
