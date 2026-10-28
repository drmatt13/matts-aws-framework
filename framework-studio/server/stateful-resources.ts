import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import express from "express";
import type { StatefulInspection, StatefulInventory, StatefulKind, StatefulPlan, StatefulSelection, StatefulSource } from "../shared/stateful-resources";
import type { Mode } from "../shared/model";
import { resolveStatefulResources } from "../../cdk-app/stateful-resources";
import type { StatefulResourcesConfiguration } from "../../cdk-app/stateful-resources";
import { assertDatabaseReference } from "../../cdk-app/lib/app/database-lifecycle";
import { validateCognitoReference } from "../../cdk-app/lib/app/cognito-lifecycle";
import { inputMode } from "./deployment-input-edits";
import { deploymentInputPath, inputText } from "./deployment-inputs";
import { SourceJournal } from "./edits/journal";
import { EditError, writeSourceChange } from "./edits/io";
import { diffOf } from "./edits/plan";
import { assertWritable, hashEditableFiles, sha256 } from "./files";
import { sendJson } from "./http";
import type { DeployService } from "./deploy/service";
import { runCommand, studioEnvironment, Tools, type Runner } from "./deploy/process";
import { changeStatefulSource, readStatefulSource, STATEFUL_SOURCE_FILE } from "./stateful-source";

interface Builder { readonly current?: { readonly snapshot: { readonly revision: string } }; refresh(): Promise<{ readonly snapshot: { readonly revision: string } }> }
interface PrivatePlan { view: StatefulPlan; mode: Mode; revision: string; hashes: string; sourceHash: string; before: string; after: string; inspect?: readonly string[]; selection?: StatefulSelection }
const kindOf = (value: unknown): StatefulKind => { if (value !== "database" && value !== "cognito") throw new EditError(400, "Choose Database or Cognito lifecycle."); return value; };
const equivalent = (value: unknown): string => JSON.stringify(value, (_key, inner) => inner && typeof inner === "object" && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b))) : inner);

/** Source proposals share the normal source lock/journal. Discovery delegates to
 * the same read-only CLI inspectors used by deployment; a browser cannot supply
 * an arbitrary reference descriptor or turn reference into CloudFormation import. */
export class StatefulResourceService {
  private readonly plans = new Map<string, PrivatePlan>();
  readonly ownWrites = new Map<string, string>();
  private readonly tools: Tools;
  constructor(private readonly root: string, private readonly builder: Builder, private readonly deploy: Pick<DeployService, "targets">, private readonly run: Runner = runCommand, private readonly env = process.env) { this.tools = new Tools(root, env); }
  expirePlans(): void { this.plans.clear(); }
  private fingerprints(): string {
    const dependencies = ["cdk-app/cdk.json", "cdk-app/stateful-resources.ts", "cdk-app/deployment.ts", "cdk-app/deployment-inputs.ts", "cdk-app/bin/cdk-app.ts", "cdk-app/lib/app/database-lifecycle.ts", "cdk-app/lib/app/cognito-lifecycle.ts", "scripts/stateful-references.ts", "scripts/retained-resources.ts", "scripts/aws-cli.ts", "scripts/aws-profiles.ts", "framework-studio/server/stateful-source.ts", "framework-studio/server/stateful-resources.ts"];
    return equivalent({ ...hashEditableFiles(this.root), ...Object.fromEntries(dependencies.map(file => [file, existsSync(path.join(this.root, file)) ? sha256(readFileSync(path.join(this.root, file), "utf8")) : null])) });
  }
  private text(): string { return readFileSync(assertWritable(this.root, STATEFUL_SOURCE_FILE), "utf8"); }
  source(mode: Mode): StatefulSource {
    const text = this.text();
    const { value } = readStatefulSource(text);
    resolveStatefulResources(value as StatefulResourcesConfiguration, mode, false);
    for (const environment of Object.values(value)) for (const [kind, policy] of Object.entries(environment)) if (policy.reference) {
      if (kind === "database") assertDatabaseReference(policy.reference);
      else validateCognitoReference(policy.reference as Parameters<typeof validateCognitoReference>[0], policy.reference);
    }
    const legacyText = inputText(this.root, deploymentInputPath(mode)) ?? "";
    const legacy = parseEnv(legacyText).RETAIN_STATEFUL_RESOURCES;
    return { file: STATEFUL_SOURCE_FILE, hash: sha256(text + "\0" + legacyText), mode,
      resources: { database: value[mode]?.database ?? {}, cognito: value[mode]?.cognito ?? {} },
      legacy: { file: deploymentInputPath(mode), retain: legacy?.trim().toLowerCase() === "true", configured: legacy !== undefined },
      problems: legacy?.trim() && !/^(true|false)$/i.test(legacy.trim()) ? ["RETAIN_STATEFUL_RESOURCES is invalid. Fix the selected input file before relying on inherited policy."] : [],
    };
  }
  private selection(value: unknown): StatefulSelection {
    const input = value as StatefulSelection | undefined;
    if (!input || !/^[\w+=,.@-]{1,128}$/.test(input.profile) || !/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(input.deployment) || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(input.region)) throw new EditError(400, "Choose a declared destination, AWS profile and region.");
    inputMode(input.mode);
    const target = this.deploy.targets().find(target => target.name === input.deployment && target.mode === input.mode);
    if (!target || target.region && target.region !== input.region) throw new EditError(422, "Destination mode or region differs from the declared deployment target.");
    if (target.inputs && target.inputs !== deploymentInputPath(input.mode)) throw new EditError(422, "This destination uses custom inputs. Use its actual CLI inputs to inspect references; the Studio editor supports the standard environment files.");
    return input;
  }
  private args(selection: StatefulSelection): string[] { return ["--deployment", selection.deployment, "--mode", selection.mode, "--profile", selection.profile, "--region", selection.region, "--json"]; }
  private async cli<T>(args: readonly string[]): Promise<T> {
    const result = await this.run(this.tools.script("scripts/stateful-references.ts", args, studioEnvironment(this.env)), { timeoutMs: 180_000 });
    let value: any; try { value = JSON.parse(result.stdout); } catch { /* Safe message below. */ }
    if (result.code !== 0 || !value || value.error) throw new EditError(422, typeof value?.error?.message === "string" ? value.error.message : "Lifecycle inspection failed. Check the selected profile, account, region and read permissions with the lifecycle CLI. No source or AWS resources were changed.");
    return value as T;
  }
  private assertAccount(selection: StatefulSelection, account: string): void {
    const target = this.deploy.targets().find(target => target.name === selection.deployment && target.mode === selection.mode);
    if (!/^\d{12}$/.test(account) || target?.account && target.account !== account) throw new EditError(422, "Selected AWS credentials do not match the declared destination account. Choose the correct profile before reviewing lifecycle source.");
  }
  async inventory(value: unknown): Promise<StatefulInventory> { const selection = this.selection(value); const inventory = await this.cli<StatefulInventory>(["list", ...this.args(selection)]); this.assertAccount(selection, inventory.account); return inventory; }
  private capture(mode: Mode, revision: string, hash: string): { before: string; hashes: string } {
    if (this.builder.current?.snapshot.revision !== revision || this.source(mode).hash !== hash) throw new EditError(409, "Source or inputs changed. Reload lifecycle settings and review again.");
    return { before: this.text(), hashes: this.fingerprints() };
  }
  private save(mode: Mode, revision: string, hash: string, capture: { before: string; hashes: string }, after: string, effects: readonly string[], inspection?: StatefulInspection, inspect?: readonly string[], selection?: StatefulSelection): StatefulPlan {
    resolveStatefulResources(readStatefulSource(after).value as StatefulResourcesConfiguration, mode, false);
    if (this.builder.current?.snapshot.revision !== revision || this.source(mode).hash !== hash || this.fingerprints() !== capture.hashes) throw new EditError(409, "Source changed during lifecycle inspection. Nothing was written; reload and review again.");
    const view: StatefulPlan = { planId: randomUUID(), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), effects,
      changes: [{ file: STATEFUL_SOURCE_FILE, diff: diffOf(STATEFUL_SOURCE_FILE, capture.before, after) }], ...(inspection ? { inspection } : {}) };
    if (this.plans.size >= 20) this.expirePlans();
    this.plans.set(view.planId, { view, mode, revision, sourceHash: hash, ...capture, after, inspect, selection });
    return view;
  }
  retention(body: any): StatefulPlan {
    const mode = inputMode(body?.mode), kind = kindOf(body?.kind);
    if (!["retain", "remove", "inherit"].includes(body?.retention)) throw new EditError(400, "Choose retain, remove or inherit legacy policy.");
    const capture = this.capture(mode, String(body?.revision), String(body?.hash));
    const after = changeStatefulSource(capture.before, mode, kind, { retention: body.retention === "inherit" ? undefined : body.retention });
    return this.save(mode, body.revision, body.hash, capture, after, [
      `Save ${kind} retention for ${mode} in TypeScript. Deployment is separate.`,
      body.retention === "remove" ? "A later deployment can remove protection; subsequent teardown can permanently delete data or users." : body.retention === "inherit" ? "Return this resource to the existing RETAIN_STATEFUL_RESOURCES input and context fallback." : "Retain leaves resources and ongoing costs. Reference validation and reconnection are separate actions.",
    ]);
  }
  async reference(body: any): Promise<StatefulPlan> {
    const selection = this.selection(body?.selection), kind = kindOf(body?.kind);
    if (typeof body.id !== "string" || !/^[A-Za-z0-9_:-]{1,255}$/.test(body.id) || typeof body.originalDeployment !== "string" || !/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(body.originalDeployment) || body.clientId !== undefined && !/^[a-z0-9]{1,128}$/.test(body.clientId)) throw new EditError(400, "Choose an exact retained resource ID and original deployment; Cognito also requires its existing app client ID.");
    const capture = this.capture(selection.mode, String(body.revision), String(body.hash));
    const args = ["inspect", "--kind", kind, "--id", body.id, "--original-deployment", body.originalDeployment, ...(body.clientId ? ["--client-id", body.clientId] : []), ...this.args(selection)];
    const inspection = await this.cli<StatefulInspection>(args);
    if (inspection.kind !== kind || !inspection.reference) throw new EditError(502, "The lifecycle inspector did not return a matching reference. Nothing was written.");
    this.assertAccount(selection, inspection.reference.account);
    if (inspection.reference.region !== selection.region) throw new EditError(422, "Inspected resource region differs from the destination.");
    if (kind === "database") assertDatabaseReference(inspection.reference, inspection.reference);
    else validateCognitoReference(inspection.reference as Parameters<typeof validateCognitoReference>[0], inspection.reference);
    const after = changeStatefulSource(capture.before, selection.mode, kind, { reference: inspection.reference });
    return this.save(selection.mode, body.revision, body.hash, capture, after, [
      "Save an explicit externally managed reference. This does not import, restore, deploy or change the selected AWS resource.",
      "A separate reviewed deployment rebuilds supported application connections. It must revalidate live dependencies and may refuse a changed or claimed resource.",
      kind === "database" ? "No migration, seed or master-secret read runs during reconnection. Verify app_user IAM login, network connectivity and original records afterward." : "The selected original User Pool and existing app client retain their IDs. Providers, domains, groups and triggers stay externally managed. Verify sign-in and scoped Identity Pool access afterward.",
    ], inspection, args, selection);
  }
  async apply(id: string) {
    const plan = this.plans.get(id);
    if (!plan || Date.now() >= Date.parse(plan.view.expiresAt)) throw new EditError(410, "This lifecycle review expired. Inspect and review again.");
    this.capture(plan.mode, plan.revision, plan.sourceHash);
    if (this.fingerprints() !== plan.hashes) throw new EditError(409, "Source changed since lifecycle review. Nothing was written.");
    if (plan.selection) this.selection(plan.selection);
    if (plan.inspect) {
      const current = await this.cli<StatefulInspection>(plan.inspect);
      if (equivalent(current.reference) !== equivalent(plan.view.inspection?.reference)) throw new EditError(409, "The retained resource or dependencies changed since review. Inspect and review again.");
    }
    // Acquire the checkout source lock only after slow AWS reads; recheck inside it.
    const journal = new SourceJournal(this.root), file = path.join(this.root, STATEFUL_SOURCE_FILE);
    const transaction = journal.begin("Stateful resource lifecycle source", [{ file, before: plan.before, after: plan.after }]);
    let written = false;
    try {
      this.capture(plan.mode, plan.revision, plan.sourceHash);
      if (this.fingerprints() !== plan.hashes) throw new EditError(409, "Source changed during inspection. Nothing was written.");
      assertWritable(this.root, STATEFUL_SOURCE_FILE);
      writeSourceChange(this.root, file, plan.before, plan.after);
      written = true;
      this.ownWrites.set(STATEFUL_SOURCE_FILE, sha256(plan.after));
      journal.finish(transaction, "complete");
    } catch (error) {
      let restored = !written;
      if (written) try { writeSourceChange(this.root, file, plan.after, plan.before); this.ownWrites.set(STATEFUL_SOURCE_FILE, sha256(plan.before)); restored = true; } catch { /* Preserve a later editor save for source recovery. */ }
      journal.finish(transaction, restored ? "restored" : "conflicted");
      throw error;
    }
    this.expirePlans();
    const refreshed = await this.builder.refresh().catch(() => undefined);
    return { status: "applied", revision: refreshed?.snapshot.revision ?? plan.revision, message: `Saved lifecycle TypeScript.${refreshed ? "" : " Studio refresh failed; fix source diagnostics and refresh."} Review synthesis and deployment separately; no AWS resource was changed.` };
  }
}

export function statefulResourceRouter(service: StatefulResourceService, published: (revision: string) => void) {
  const router = express.Router();
  router.get("/source", (request, response) => sendJson(response, () => service.source(inputMode(request.query.mode))));
  router.post("/inventory", (request, response) => sendJson(response, () => service.inventory(request.body?.selection)));
  router.post("/retention/plan", (request, response) => sendJson(response, () => service.retention(request.body)));
  router.post("/reference/plan", (request, response) => sendJson(response, () => service.reference(request.body)));
  router.post("/apply", (request, response) => sendJson(response, async () => { const result = await service.apply(String(request.body?.planId ?? "")); published(result.revision); return result; }));
  return router;
}
