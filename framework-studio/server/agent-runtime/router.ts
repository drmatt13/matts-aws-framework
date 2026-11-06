import express from "express";
import type { AgentTaskClient } from "./client";
import { sendJson } from "../http";

/** Mounted behind Studio's Host, Origin, token and protocol guards. */
export function agentTaskRouter(client: AgentTaskClient) {
  const router = express.Router();
  router.get("/", (_request, response) => sendJson(response, () => client.list()));
  router.post("/", (request, response) => sendJson(response, () => client.submit(request.body)));
  router.get("/runtime-upgrade", (_request, response) => sendJson(response, () => client.runtimeUpgrade()));
  router.post("/runtime-upgrade", (request, response) => sendJson(response, () => client.restartHost(String(request.body?.requestId ?? ""), request.body?.replaceFailedRequestId === undefined ? undefined : String(request.body.replaceFailedRequestId))));
  router.get("/recovery", (_request, response) => sendJson(response, () => client.recovery()));
  router.post("/recovery/:id", (request, response) => sendJson(response, () => client.recover(String(request.params.id), request.body)));
  router.get("/:id", (request, response) => sendJson(response, () => client.get(String(request.params.id))));
  router.get("/:id/events", (request, response) => sendJson(response, () => client.events(String(request.params.id), Number(request.query.after ?? 0))));
  router.get("/:id/proposal", (request, response) => sendJson(response, () => client.proposal(String(request.params.id))));
  router.post("/:id/activate", (request, response) => sendJson(response, () => client.activate(String(request.params.id), String(request.body?.digest ?? ""))));
  for (const action of ["cancel", "resume", "reject", "approve", "refresh", "cleanup"] as const) router.post(`/:id/${action}`, (request, response) => sendJson(response, () => client.action(String(request.params.id), action, request.body)));
  router.post("/:id/permissions/:requestId", (request, response) => sendJson(response, () => client.permission(String(request.params.id), String(request.params.requestId), request.body)));
  return router;
}
