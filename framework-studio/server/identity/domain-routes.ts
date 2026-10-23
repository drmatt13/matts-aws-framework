import type { Router } from "express";
import type { DomainDnsRequest, DomainPurpose } from "../../shared/domain-operations";
import type { IdentitySelection } from "../../shared/identity";
import { EditError } from "../edits/io";
import { sendJson } from "../http";
import { DomainDnsService } from "./domain-dns";
import { DomainHealthService } from "./domain-health";
import type { IdentityService } from "./service";

function selection(value: unknown): IdentitySelection {
  const item = value as Partial<IdentitySelection> | undefined;
  if (!item || typeof item.profile !== "string" || typeof item.deployment !== "string" || typeof item.region !== "string") throw new EditError(400, "Select an explicit profile, deployment and region.");
  return { profile: item.profile, deployment: item.deployment, region: item.region };
}
function purpose(value: unknown): DomainPurpose { if (value !== "frontend" && value !== "cognito") throw new EditError(400, "Choose frontend or Cognito domain intent."); return value; }
export function readDomainDnsRequest(value: unknown): DomainDnsRequest {
  const item = value as Record<string, unknown> | undefined;
  if (!item || Object.keys(item).some(key => !["selection", "purpose", "zoneId"].includes(key)) || typeof item.zoneId !== "string") throw new EditError(400, "A DNS review selects its production target, configured purpose and hosted zone; records are derived on the server.");
  return { selection: selection(item.selection), purpose: purpose(item.purpose), zoneId: item.zoneId };
}
export function registerDomainRoutes(router: Router, authority: IdentityService): void {
  const health = new DomainHealthService(authority); const dns = new DomainDnsService(authority.root, authority);
  router.get("/domain-health", (request, response) => sendJson(response, () => health.inspect(selection(request.query), purpose(request.query.purpose))));
  router.get("/domain-dns", (request, response) => sendJson(response, () => dns.discover(selection(request.query))));
  router.get("/domain-dns/history", (_request, response) => sendJson(response, () => dns.history()));
  router.post("/domain-dns/review", (request, response) => sendJson(response, () => dns.review(readDomainDnsRequest(request.body))));
  router.post("/domain-dns/apply", (request, response) => sendJson(response, () => {
    if (typeof request.body?.reviewId !== "string" || typeof request.body?.confirmation !== "string" || Object.keys(request.body).some(key => !["reviewId", "confirmation"].includes(key))) throw new EditError(400, "Apply only the reviewed DNS operation ID and its exact typed production confirmation.");
    return dns.apply(request.body.reviewId, request.body.confirmation);
  }));
  router.get("/domain-dns/receipts/:id", (request, response) => sendJson(response, () => dns.receipt(String(request.params.id))));
  router.post("/domain-dns/receipts/:id/observe", (request, response) => sendJson(response, () => dns.observe(String(request.params.id))));
}
