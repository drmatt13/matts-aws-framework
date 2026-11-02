import { Router } from "express";
import { sendJson } from "../http";
import { ConnectionInputError } from "./configuration";
import type { AwsConnectionsService } from "./service";

const id = (value: unknown) => {
  if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value)) throw new ConnectionInputError(400, "Choose a current connection review or authentication session.");
  return value;
};
/** Mounted behind Studio's loopback, token, same-origin and protocol guards. */
export function awsConnectionsRouter(service: AwsConnectionsService) {
  const router = Router();
  router.get("/", (_request, response) => sendJson(response, () => service.catalog()));
  router.post("/check", (request, response) => sendJson(response, () => service.check(request.body?.profile, request.body?.force === true)));
  router.post("/authentication", (request, response) => sendJson(response, () => service.startAuthentication(request.body)));
  router.get("/authentication/:id", (request, response) => sendJson(response, () => service.authentication.get(id(request.params.id))));
  router.post("/authentication/:id/cancel", (request, response) => sendJson(response, () => service.authentication.cancel(id(request.params.id))));
  router.post("/authentication/:id/confirm", (request, response) => sendJson(response, () => service.authentication.confirm(id(request.params.id), request.body?.accepted)));
  router.get("/authentication/:id/accounts", (request, response) => sendJson(response, () => service.authentication.accounts(id(request.params.id))));
  router.post("/authentication/:id/roles", (request, response) => sendJson(response, () => service.authentication.roles(id(request.params.id), request.body?.account)));
  router.post("/review", (request, response) => sendJson(response, () => service.review(request.body)));
  router.post("/apply", (request, response) => sendJson(response, () => service.apply(id(request.body?.reviewId))));
  router.post("/discard", (request, response) => sendJson(response, () => service.configuration.discard(id(request.body?.reviewId))));
  router.post("/logout/review", (request, response) => sendJson(response, () => service.logoutReview(request.body?.profile)));
  router.post("/logout/apply", (request, response) => sendJson(response, () => service.logoutApply(id(request.body?.reviewId))));
  return router;
}
