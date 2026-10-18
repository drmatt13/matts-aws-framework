import express, { type Response } from "express";
import type { OperationRequest } from "../../shared/deploy";
import { JobError } from "./jobs";
import { OperationError, validService } from "./registry";
import type { DeployService } from "./service";

/**
 * /api/deploy: Deploy & Run's HTTP surface, behind the studio's token, host and
 * origin guards like everything else under /api.
 *
 * Reads are GETs. Every change is one POST /operations naming a registered
 * operation, which answers with the job it started; its progress arrives as
 * server-sent events (deploy-job, deploy-log, deploy-stacks, deploy-event,
 * deploy-changed) and is replayable from GET /jobs/:id/log?after=<seq>.
 */

const DEPLOYMENT = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;

function send(response: Response, run: () => Promise<unknown> | unknown): void {
  Promise.resolve().then(run).then(
    (body) => response.json(body ?? null),
    (error: unknown) => {
      const status = error instanceof OperationError || error instanceof JobError ? error.status : (error as { status?: number }).status ?? 500;
      response.status(status).json({ error: error instanceof Error ? error.message : String(error) });
    },
  );
}

function deployment(value: unknown): string {
  if (typeof value !== "string" || !DEPLOYMENT.test(value)) throw new OperationError(400, "Name a deployment.");
  return value;
}

function region(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !REGION.test(value)) throw new OperationError(400, "That is not an AWS region.");
  return value;
}

export function deployRouter(service: DeployService): express.Router {
  const router = express.Router();
  const force = (value: unknown) => value === "1" || value === "true";

  router.get("/overview", (request, response) => send(response, () => service.overview(force(request.query.force))));

  router.get("/discover", (request, response) => send(response, async () =>
    service.discover(await service.requireProfile(request.query.profile), region(request.query.region), force(request.query.force))));

  router.get("/status", (request, response) => send(response, async () =>
    service.status(await service.requireProfile(request.query.profile), deployment(request.query.deployment), region(request.query.region), force(request.query.force))));

  router.get("/teardown", (request, response) => send(response, async () => {
    const mode = request.query.mode;
    if (mode !== "dev" && mode !== "prod") throw new OperationError(400, "State the deployment's mode.");
    return service.teardown(await service.requireProfile(request.query.profile), deployment(request.query.deployment), mode, region(request.query.region));
  }));

  router.get("/plans", (_request, response) => send(response, () => service.listPlans()));
  router.get("/plans/:key", (request, response) => send(response, () => {
    const plan = service.plans.read(String(request.params.key));
    if (!plan) throw new OperationError(404, "That plan no longer exists.");
    return plan;
  }));

  router.get("/drift", (request, response) => send(response, () => service.driftReport(deployment(request.query.deployment))));

  router.post("/operations", (request, response) => send(response, () => {
    const body = request.body as Partial<OperationRequest> | undefined;
    if (!body || typeof body.kind !== "string" || (body.params !== undefined && (typeof body.params !== "object" || body.params === null || Array.isArray(body.params)))) {
      throw new OperationError(400, "An operation names its kind and gives named parameters.");
    }
    return service.perform({ kind: body.kind, params: body.params ?? {} });
  }));

  router.post("/jobs/:id/cancel", (request, response) => send(response, () => service.jobs.cancel(String(request.params.id))));
  router.get("/jobs/:id/log", (request, response) => send(response, () => {
    const after = Number(request.query.after ?? 0);
    return service.jobs.log(String(request.params.id), Number.isFinite(after) && after > 0 ? Math.floor(after) : 0);
  }));

  router.get("/local/logs", (request, response) => send(response, async () => {
    const tail = Math.min(2000, Math.max(20, Number(request.query.tail ?? 300) || 300));
    return { text: await service.local.logs(validService(request.query.service), tail) };
  }));

  router.post("/preferences", (request, response) => send(response, () => service.preferences.update(request.body ?? {})));

  return router;
}
