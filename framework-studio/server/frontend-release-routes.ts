import express from "express";
import type { FrontendReleaseService } from "./frontend-release";
import type { DeploymentIdentityService } from "./deployment-identities";
import { sendJson } from "./http";
import { OperationError } from "./deploy/registry";

function destination(value: unknown): { deployment: string; profile: string; region: string } {
  const item = value as Record<string, unknown> | undefined;
  if (!item || typeof item.deployment !== "string" || typeof item.profile !== "string" || typeof item.region !== "string") throw new OperationError(400, "Select a deployment, profile and region.");
  return { deployment: item.deployment, profile: item.profile, region: item.region };
}
export function frontendReleaseRouter(service: FrontendReleaseService, identities: DeploymentIdentityService, changed: () => void): express.Router {
  const router = express.Router();
  router.get("/settings", (_request, response) => sendJson(response, () => service.settings()));
  router.get("/history", (_request, response) => sendJson(response, () => service.history()));
  router.post("/settings/review", (request, response) => sendJson(response, () => service.settingsReview(request.body?.settings, String(request.body?.hash ?? ""))));
  router.post("/settings/apply", (request, response) => sendJson(response, () => { const result = service.settingsApply(String(request.body?.id ?? "")); changed(); return result; }));
  router.post("/environment", (request, response) => sendJson(response, () => service.generateEnvironment(destination(request.body))));
  router.post("/build", (request, response) => sendJson(response, () => service.build(destination(request.body))));
  router.get("/results/:id", (request, response) => sendJson(response, () => service.result(String(request.params.id))));
  router.post("/publish", (request, response) => sendJson(response, () => service.publish(String(request.body?.id ?? ""), String(request.body?.approval ?? ""))));
  router.get("/identities", (_request, response) => sendJson(response, () => identities.load()));
  router.post("/identities/review", (request, response) => sendJson(response, () => identities.review(request.body?.identity, String(request.body?.hash ?? ""))));
  router.post("/identities/apply", (request, response) => sendJson(response, () => { const result = identities.apply(String(request.body?.id ?? "")); changed(); return result; }));
  return router;
}
