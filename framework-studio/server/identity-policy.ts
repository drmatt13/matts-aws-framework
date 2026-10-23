import { readFileSync } from "node:fs";
import express from "express";
import { identityPolicyStatements, type IdentityPolicySimulation } from "../shared/identity-policy";
import type { StudioState } from "./snapshot";
import { identityPolicyAuthorityHashes, identityPolicySource, identityPolicySources } from "./identity-policy-source";
import { EditError } from "./edits/io";
import { sendJson } from "./http";
import { runCommand, studioEnvironment, Tools, type Runner } from "./deploy/process";

export class IdentityPolicyService {
  private readonly tools: Tools;
  constructor(private readonly root: string, private readonly state: () => StudioState | undefined, private readonly run: Runner = runCommand, private readonly env = process.env) { this.tools = new Tools(root, env); }
  private current(): StudioState { const state = this.state(); if (!state) throw new EditError(503, "Configuration is still loading."); return state; }
  sources() { return { revision: this.current().snapshot.revision, sources: identityPolicySources(this.root, this.current()) }; }
  private async aws(args: string[], profile: string, region: string): Promise<any> {
    const result = await this.run(this.tools.aws([...args, "--profile", profile, "--region", region, "--output", "json", "--no-cli-pager"], studioEnvironment(this.env, { profile })), { timeoutMs: 30_000 });
    if (result.code !== 0) throw new EditError(422, `${/AccessDenied|Unauthorized/.test(result.stderr) ? "Access denied" : "AWS read unavailable"}: ${args.slice(0, 2).join(" ")}. Check the selected profile/account and iam:SimulateCustomPolicy permission. No IAM or resource change was made.`);
    try { return JSON.parse(result.stdout); } catch { throw new EditError(502, "IAM simulation returned unreadable evidence."); }
  }
  async simulate(value: unknown): Promise<IdentityPolicySimulation> {
    const input = value as { target?: unknown; revision?: unknown; profile?: unknown; account?: unknown; region?: unknown; role?: unknown; actions?: unknown; resources?: unknown };
    if (!input || typeof input.target !== "string" || typeof input.revision !== "string" || typeof input.profile !== "string" || !/^[\w+=,.@-]{1,128}$/.test(input.profile) || typeof input.account !== "string" || !/^\d{12}$/.test(input.account) || typeof input.region !== "string" || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(input.region) || !["reader", "default"].includes(String(input.role)) || !Array.isArray(input.actions) || !input.actions.length || input.actions.length > 10 || !Array.isArray(input.resources) || !input.resources.length || input.resources.length > 10) throw new EditError(400, "Select the saved pool, source revision, profile, expected account, region, role, and up to 10 explicit actions/resources.");
    try { identityPolicyStatements([{ Effect: "Deny", Action: input.actions, Resource: input.resources }]); } catch (error) { throw new EditError(422, error instanceof Error ? error.message : String(error)); }
    const state = this.current(); if (state.snapshot.revision !== input.revision) throw new EditError(409, "Source changed. Reload the policy before simulating.");
    const source = identityPolicySource(this.root, state, input.target);
    const authority = JSON.stringify(identityPolicyAuthorityHashes(this.root, source.relative));
    const caller = await this.aws(["sts", "get-caller-identity"], input.profile, input.region);
    if (caller.Account !== input.account) throw new EditError(422, "The selected profile resolves to a different account. No IAM simulation was sent.");
    const role = input.role as "reader" | "default";
    const statements = role === "reader" ? source.statements : [];
    const actions = input.actions as string[]; const resources = input.resources as string[];
    const results: IdentityPolicySimulation["results"][number][] = [];
    if (statements.length) {
      const output = await this.aws(["iam", "simulate-custom-policy", "--policy-input-list", JSON.stringify({ Version: "2012-10-17", Statement: statements }), "--action-names", ...actions, "--resource-arns", ...resources], input.profile, input.region);
      if (!Array.isArray(output.EvaluationResults)) throw new EditError(502, "IAM returned no policy evaluation results.");
      for (const result of output.EvaluationResults) {
        const evaluations = result.ResourceSpecificResults?.length ? result.ResourceSpecificResults : [{ EvalResourceName: result.EvalResourceName, EvalResourceDecision: result.EvalDecision, MissingContextValues: result.MissingContextValues }];
        for (const evaluation of evaluations) results.push({ action: result.EvalActionName, resource: evaluation.EvalResourceName ?? "unknown", decision: evaluation.EvalResourceDecision ?? result.EvalDecision ?? "unknown", missingContext: evaluation.MissingContextValues ?? result.MissingContextValues ?? [] });
      }
    } else for (const action of actions) for (const resource of resources) results.push({ action, resource, decision: "implicitDeny", missingContext: [] });
    if (this.current().snapshot.revision !== input.revision || readFileSync(source.file, "utf8") !== source.text || JSON.stringify(identityPolicyAuthorityHashes(this.root, source.relative)) !== authority) throw new EditError(409, "Source changed during simulation. Discard this evidence and simulate the current saved policy.");
    return { engine: statements.length ? "aws-iam" : "source-empty-policy", role, account: input.account, profile: input.profile, region: input.region, observedAt: new Date().toISOString(), results, limitations: [
      statements.length ? "AWS IAM simulated only the saved explicit policy document, actions and resource ARNs. No requested resource operation was performed." : "The selected role has no policy statements: this is a source-model implicit deny after STS account verification; no IAM simulator request was needed.",
      "This does not prove credential issuance, group membership, preferred-role claims, trust, provider settings or application RBAC. Missing/equal-precedence conflicting role claims can prevent credentials before IAM permission evaluation.",
      "Attached deployment policies, permission boundaries, SCPs, session policies and resource policies were not supplied. Live authorization and network access remain unverified; this is not a deployed-role or runtime test.",
    ] };
  }
}
export function identityPolicyRouter(service: IdentityPolicyService) {
  const router = express.Router();
  router.get("/sources", (_request, response) => sendJson(response, () => service.sources()));
  router.post("/simulate", (request, response) => sendJson(response, () => service.simulate(request.body)));
  return router;
}
