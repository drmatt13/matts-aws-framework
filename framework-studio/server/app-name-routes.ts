import express from "express";
import type { AppNameService } from "./app-name";
import { sendJson } from "./http";

/** Names the app, or keeps a stage's deployed name, in cdk-app/cdk.json. Source edits with their own review; no AWS operation. */
export function appNameRouter(service: AppNameService, changed: () => void): express.Router {
  const router = express.Router();
  router.get("/", (_request, response) => sendJson(response, () => service.load()));
  router.post("/review", (request, response) => sendJson(response, () => service.review({ name: request.body?.name, hash: request.body?.hash, profiles: request.body?.profiles })));
  router.post("/deploy-as/review", (request, response) => sendJson(response, () => service.reviewDeployAs({ stage: request.body?.stage, deployAs: request.body?.deployAs, hash: request.body?.hash })));
  router.post("/apply", (request, response) => sendJson(response, () => { const result = service.apply(String(request.body?.id ?? "")); changed(); return result; }));
  return router;
}
