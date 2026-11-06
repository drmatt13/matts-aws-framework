import type { JobView, LocalRunView, OperationRequest } from "../../../shared/deploy";
import { NOW, dockerStatus, overview } from "./scenarios";
import { inspectionStatus } from "./stack-inspection";
import type { Route } from "@playwright/test";

export const LOCAL_ACCOUNT = "123456789012";
export const LOCAL_REGION = "us-east-1";
interface FixtureStudio {
  reply(method: string, pathname: string, handler: (route: Route, url: URL) => Promise<void>): void;
  emit(type: string, data: unknown): Promise<void>;
}

/** Only fixture values: this module never starts processes, Docker, or AWS work. */
export function localRuntimeView(state: "stopped" | "starting" | "ready" | "blocked" = "stopped"): LocalRunView {
  const active = state !== "stopped";
  const base = overview().local;
  return {
    ...base,
    exported: { deployment: "browser-dev", account: LOCAL_ACCOUNT, region: LOCAL_REGION, client: true },
    services: active ? [{ name: "local-api", container: "browser-fixture-local-api", state: "running", health: state === "ready" ? "healthy" : state === "blocked" ? "unhealthy" : "starting", oneShot: false, ports: "127.0.0.1:3000->3000/tcp" }] : [],
    watch: { running: active }, client: { running: active }, startedBy: active ? "studio" : "none",
    ...(active ? { profile: "browser", appUrl: "http://127.0.0.1:5173", binding: { deployment: "browser-dev", profile: "browser", account: LOCAL_ACCOUNT, region: LOCAL_REGION, startedAt: NOW } } : {}),
    readiness: { state, observedAt: NOW, message: state === "ready" ? "Services are running and the web client is reachable."
      : state === "blocked" ? "Needs attention: prisma-verify. Database verification never applies changes; review initialization or migrations in Database."
      : state === "starting" ? "Waiting for local services, source watch and web client." : "Local services are stopped." },
  };
}

export function installLocalRuntime(studio: FixtureStudio) {
  let view = localRuntimeView();
  let operationFailure: string | undefined;
  const jobs: JobView[] = [], submitted: OperationRequest[] = [];
  studio.reply("GET", "/api/deploy/local", route => route.fulfill({ json: view }));
  studio.reply("GET", "/api/deploy/overview", route => route.fulfill({ json: { ...overview(), local: view, jobs } }));
  studio.reply("GET", "/api/deploy/status", (route, url) => {
    const status = inspectionStatus(url);
    return route.fulfill({ json: { ok: true, value: { ...status, detail: status.detail ? { ...status.detail,
      local: { compatible: true, exported: { deployment: "browser-dev", manifest: "fixture-manifest", client: true, fresh: true } } } : undefined } } });
  });
  studio.reply("GET", "/api/machine/docker", route => route.fulfill({ json: dockerStatus(view.docker) }));
  studio.reply("GET", "/api/operations", route => route.fulfill({ json: { jobs } }));
  studio.reply("POST", "/api/deploy/operations", async route => {
    const request = route.request().postDataJSON() as OperationRequest;
    submitted.push(request);
    if (operationFailure) { await route.fulfill({ status: 409, json: { error: operationFailure } }); return; }
    const job: JobView = { id: `fixture-local-runtime-${submitted.length}`, kind: request.kind, params: request.params,
      deployment: "browser-dev", title: request.kind === "local-stop" ? "Stop development" : "Start development against browser-dev",
      status: "running", startedAt: NOW, lastSeq: 0,
      steps: [{ label: request.kind === "local-stop" ? "Stop containers" : "Generate source projections, verify database and start containers", status: "running" }] };
    jobs.unshift(job);
    studio.reply("GET", `/api/operations/${job.id}/log`, log => log.fulfill({ json: { job: jobs.find(entry => entry.id === job.id), lines: [] } }));
    await route.fulfill({ json: job });
  });
  return {
    submitted, jobs,
    set(next: LocalRunView) { view = next; },
    reject(message?: string) { operationFailure = message; },
    async publish(next: LocalRunView) { view = next; await studio.emit("deploy-changed", { profile: "browser", deployment: "browser-dev" }); },
    async finish(next: LocalRunView, status: "succeeded" | "failed" = "succeeded") {
      view = next;
      const old = jobs[0];
      if (!old) throw new Error("No fixture runtime operation is running.");
      const job: JobView = { ...old, status, endedAt: NOW, summary: next.readiness?.message,
        steps: old.steps?.map(step => ({ ...step, status: status === "succeeded" ? "done" : "failed" })) };
      jobs[0] = job;
      await studio.emit("operation-job", job);
      await studio.emit("deploy-job", job);
      await studio.emit("deploy-changed", { profile: "browser", deployment: "browser-dev" });
    },
  };
}
