import express from "express";
import type { IdentitySelection } from "../../shared/identity";
import { inputMode } from "../deployment-input-edits";
import { sendJson } from "../http";
import type { IdentityService } from "./service";
import { cognitoOperationsRouter, type CognitoOperations } from "./operations";
import { registerDomainRoutes } from "./domain-routes";

export function identityRouter(service: IdentityService, operations?: CognitoOperations) {
  const router = express.Router();
  if (operations) router.use("/operations", cognitoOperationsRouter(operations));
  registerDomainRoutes(router, service);
  const selection = (query: Record<string, unknown>): IdentitySelection => ({ profile: String(query.profile ?? ""), deployment: String(query.deployment ?? ""), region: String(query.region ?? "") });
  router.get("/source", (request, response) => sendJson(response, () => service.source(inputMode(request.query.mode))));
  router.get("/cognito", (request, response) => sendJson(response, () => service.cognito(selection(request.query), typeof request.query.nextToken === "string" ? request.query.nextToken : undefined, typeof request.query.search === "string" ? request.query.search : undefined)));
  router.get("/pools", (request, response) => sendJson(response, () => service.identityPools(selection(request.query))));
  router.get("/domains", (request, response) => sendJson(response, () => service.domains(selection(request.query))));
  return router;
}
