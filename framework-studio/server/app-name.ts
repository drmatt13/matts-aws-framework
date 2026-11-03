import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  APP_CONTEXT_KEY,
  APP_ID_CONTEXT_KEY,
  appIdProblem,
  appNameProblem,
  deploymentNameProblem,
  newAppId,
  projectTargets,
  TARGETS_CONTEXT_KEY,
} from "@repo/framework/deploy";
import { appNamePreview, type AppNameReview, type AppNameRow, type AppNameView, type AppStageView } from "../shared/app-name";
import { writeSourceChange } from "./edits/io";
import { sha256 } from "./files";
import { OperationError } from "./deploy/registry";

const CDK_FILE = "cdk-app/cdk.json";
type Context = Record<string, unknown>;

function readProject(root: string): { text: string | null; json?: { context?: Context } & Record<string, unknown> } {
  const file = path.join(root, CDK_FILE);
  if (!existsSync(file)) return { text: null };
  const text = readFileSync(file, "utf8");
  try { return { text, json: JSON.parse(text) }; } catch { return { text }; }
}

function stagesOf(context: Context): AppStageView[] {
  const declared = context[TARGETS_CONTEXT_KEY];
  const entries = declared && typeof declared === "object" && !Array.isArray(declared) ? Object.entries(declared as Record<string, unknown>) : [];
  const stages = entries.map(([stage, raw]): AppStageView => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const mode = entry.mode === "prod" || entry.mode === "dev" ? entry.mode : stage === "prod" ? "prod" : "dev";
    return {
      stage, mode, ...(typeof entry.deployAs === "string" ? { deployAs: entry.deployAs } : {}),
      ...(typeof entry.account === "string" ? { account: entry.account } : {}), ...(typeof entry.region === "string" ? { region: entry.region } : {}),
    };
  });
  return stages.some((stage) => stage.stage === "dev") ? stages : [{ stage: "dev", mode: "dev", implicit: true }, ...stages];
}

/** The app's name and id for the snapshot. Never throws: an unreadable or unnamed project is a state to show. */
export function applicationSummary(root: string): { name?: string; appId?: string; problem?: string; legacy?: boolean; needsId?: boolean } {
  const { text, json } = readProject(root);
  if (text === null) return { problem: `${CDK_FILE} is missing.` };
  if (!json) return { problem: `${CDK_FILE} is not valid JSON.` };
  const value = json.context?.[APP_CONTEXT_KEY];
  const id = json.context?.[APP_ID_CONTEXT_KEY];
  const missing = (candidate: unknown) => candidate === undefined || candidate === null || candidate === "";
  const nameProblem = appNameProblem(value);
  const idProblem = appIdProblem(id);
  return {
    ...(nameProblem ? {} : { name: value as string }),
    ...(idProblem ? {} : { appId: id as string }),
    ...(nameProblem ?? idProblem ? { problem: (nameProblem ?? idProblem)! } : {}),
    ...(missing(value) ? { legacy: true } : {}),
    ...(missing(id) ? { needsId: true } : {}),
  };
}

/** A read-only look at the deployments one AWS profile can see in a region: Deploy's own discovery. */
export type DeploymentDiscovery = (profile: string, region: string | undefined) => Promise<
  | {
      readonly ok: true;
      readonly value: {
        readonly context: { readonly account: string };
        readonly deployments: readonly { readonly name: string; readonly appId?: string; readonly stage?: string }[];
      };
    }
  | { readonly ok: false; readonly problem: { readonly message: string } }
>;
type Check = Pick<AppNameRow, "check" | "deployed" | "reason">;

const excerpt = (value: Context) =>
  JSON.stringify({
    [APP_CONTEXT_KEY]: value[APP_CONTEXT_KEY],
    ...(value[APP_ID_CONTEXT_KEY] === undefined ? {} : { [APP_ID_CONTEXT_KEY]: value[APP_ID_CONTEXT_KEY] }),
    [TARGETS_CONTEXT_KEY]: value[TARGETS_CONTEXT_KEY] ?? {},
  }, null, 2);

/**
 * Names the app: `framework:app` in cdk-app/cdk.json, from which every stage's
 * deployment is named `<app>-<stage>`, beside `framework:appId`, which never
 * changes. A rename never moves a live production: the review looks in AWS,
 * read-only, for each stage of this app, and a production stage deployed under
 * any name keeps it (`deployAs`). When AWS cannot be checked nothing is kept on
 * assumption: deploying checks again, and refuses a second production of a
 * stage. Nothing here reads or writes an inputs file.
 */
export class AppNameService {
  /** Files this service wrote, by the hash of what it wrote, so the watcher does not report them as outside changes. */
  readonly ownWrites = new Map<string, string>();
  private pending?: { review: AppNameReview; before: string; after: string };
  constructor(private readonly root: string, private readonly discover?: DeploymentDiscovery) {}

  /** Whether this app's stage is deployed in AWS, by the profile its mode uses, and as which name. */
  private async check(stage: AppStageView, appId: string | undefined, current: string | undefined, profile: string | undefined): Promise<Check> {
    const mode = stage.mode === "prod" ? "Production" : "Development";
    if (!this.discover) return { check: "unknown", reason: "Studio could not reach AWS." };
    if (!profile) return { check: "unknown", reason: `No ${mode} AWS profile is selected.` };
    try {
      const observation = await this.discover(profile, stage.region);
      if (!observation.ok) return { check: "unknown", reason: observation.problem.message };
      if (stage.account && observation.value.context.account !== stage.account) {
        return { check: "unknown", reason: `The ${mode} profile ${profile} is for account ${observation.value.context.account}, not ${stage.account}.` };
      }
      const found = observation.value.deployments;
      // By what the stacks say they are first; by the current name for stacks deployed before they said.
      const deployed = (appId ? found.find((entry) => entry.appId === appId && entry.stage === stage.stage) : undefined)
        ?? (current ? found.find((entry) => entry.name === current) : undefined);
      return deployed ? { check: "deployed", deployed: deployed.name } : { check: "absent" };
    } catch (error) {
      return { check: "unknown", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  load(): AppNameView {
    const { text, json } = readProject(this.root);
    if (text === null || !json) throw new OperationError(422, `${CDK_FILE} is ${text === null ? "missing" : "not valid JSON"}. Fix it in your editor, then reload.`);
    return { ...applicationSummary(this.root), stages: stagesOf(json.context ?? {}), hash: sha256(text) };
  }

  /** Refuses a stale review, an invalid name (other than none yet) and an invalid id (other than none yet). */
  private current(hash: unknown): AppNameView {
    const view = this.load();
    if (hash !== view.hash) throw new OperationError(409, `${CDK_FILE} changed. Review again.`);
    const invalidName = !view.name && !view.legacy;
    const invalidId = !view.appId && !view.needsId;
    if (invalidName || invalidId) throw new OperationError(422, `${view.problem} Fix it in ${CDK_FILE}, then try again here.`);
    return view;
  }

  /** Writes the reviewed context, keeping every other key where it was, and remembers it for apply. */
  private stage(
    view: AppNameView,
    input: { readonly name: string; readonly appId: string; readonly targets: Record<string, unknown>; readonly rows: readonly AppNameRow[]; readonly warnings: readonly string[] },
  ): AppNameReview {
    const { text: before, json } = readProject(this.root);
    const context = json!.context ?? {};
    // framework:app replaces itself, or arrives just before the targets; framework:appId follows it.
    const nextContext: Context = {};
    const place = (key: string, value: unknown) => {
      if (key === APP_CONTEXT_KEY || (key === TARGETS_CONTEXT_KEY && !Object.hasOwn(context, APP_CONTEXT_KEY))) {
        nextContext[APP_CONTEXT_KEY] = input.name;
        if (!Object.hasOwn(context, APP_ID_CONTEXT_KEY)) nextContext[APP_ID_CONTEXT_KEY] = input.appId;
      }
      if (key === APP_CONTEXT_KEY) return;
      nextContext[key] = key === APP_ID_CONTEXT_KEY ? input.appId : key === TARGETS_CONTEXT_KEY ? input.targets : value;
    };
    if (!Object.hasOwn(context, APP_CONTEXT_KEY) && !Object.hasOwn(context, TARGETS_CONTEXT_KEY)) place(APP_CONTEXT_KEY, input.name);
    for (const [key, value] of Object.entries(context)) place(key, value);
    if (!Object.hasOwn(nextContext, TARGETS_CONTEXT_KEY) && Object.keys(input.targets).length) nextContext[TARGETS_CONTEXT_KEY] = input.targets;

    let resolved: ReturnType<typeof projectTargets>;
    try { resolved = projectTargets({ app: input.name, appId: input.appId, targets: nextContext[TARGETS_CONTEXT_KEY] }); }
    catch (error) { throw new OperationError(422, error instanceof Error ? error.message : String(error)); }
    for (const row of input.rows) {
      if (resolved.find((target) => target.stage === row.stage)?.name !== row.after) throw new OperationError(422, `The ${row.stage} stage would not deploy as the reviewed ${row.after}. Nothing was changed.`);
    }
    const after = JSON.stringify({ ...json, context: nextContext }, null, 2) + "\n";
    const warnings = [...input.warnings];
    if (JSON.stringify(json, null, 2) + "\n" !== before) warnings.push(`${CDK_FILE} is saved as two-space JSON, so its formatting changes too.`);
    warnings.push(`Applying edits ${CDK_FILE} only; nothing is deployed.`);
    const review: AppNameReview = {
      id: randomUUID(), ...(view.name ? { from: view.name } : {}), name: input.name, rows: input.rows, warnings,
      change: { file: CDK_FILE, before: excerpt(context), after: excerpt(nextContext) },
    };
    this.pending = { review, before: before!, after };
    return review;
  }

  private declaredTargets(): Record<string, Record<string, unknown>> {
    const declared = readProject(this.root).json?.context?.[TARGETS_CONTEXT_KEY];
    return declared && typeof declared === "object" && !Array.isArray(declared) ? { ...(declared as Record<string, Record<string, unknown>>) } : {};
  }

  async review(input: { readonly name?: unknown; readonly hash?: unknown; readonly profiles?: unknown }): Promise<AppNameReview> {
    const view = this.current(input.hash);
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const profiles = (input.profiles ?? {}) as { dev?: unknown; prod?: unknown };
    const profileFor = (mode: "dev" | "prod") => (typeof profiles[mode] === "string" && profiles[mode] ? profiles[mode] as string : undefined);
    const draft = appNamePreview(view, name);
    if (draft.unchanged && !view.needsId) throw new OperationError(422, `The app is already called ${name}.`);
    if (draft.problems.length) throw new OperationError(422, draft.problems[0]!);

    // Look in AWS for each stage that would take the new name: a production one
    // deployed under any name keeps it; development always follows.
    const checks = new Map<string, Check>();
    if (!draft.unchanged) {
      for (const row of draft.rows) {
        if (row.outcome !== "follows" || !row.before) continue;
        checks.set(row.stage, await this.check(view.stages.find((stage) => stage.stage === row.stage)!, view.appId, row.before, profileFor(row.mode)));
      }
    }
    const keep = Object.fromEntries(draft.rows
      .filter((row) => row.mode === "prod" && checks.get(row.stage)?.check === "deployed")
      .map((row) => [row.stage, checks.get(row.stage)!.deployed!]));
    const preview = appNamePreview(view, name, keep);
    const rows = preview.rows.map((row) => (checks.has(row.stage) ? { ...row, ...checks.get(row.stage) } : row));

    // Legacy targets keep the full names they are keyed by; production stages AWS holds keep theirs.
    const declared = this.declaredTargets();
    const targets: Record<string, unknown> = { ...declared };
    for (const row of rows) {
      const stage = view.stages.find((candidate) => candidate.stage === row.stage)!;
      if (row.outcome !== "keeps" || stage.deployAs) continue;
      targets[row.stage] = { ...(declared[row.stage] ?? {}), deployAs: row.after };
    }

    // The rows state each outcome; warnings carry only the consequences the rows do not.
    const warnings: string[] = [];
    for (const row of rows) {
      if (row.mode === "dev" && row.outcome === "follows" && row.check === "deployed") {
        warnings.push(`${row.deployed} keeps running, and billing, until you delete it in Deploy.`);
      } else if (row.mode === "dev" && row.outcome === "follows" && row.check === "unknown") {
        warnings.push(`If ${row.before} is deployed, it keeps running until you delete it in Deploy.`);
      } else if (row.mode === "prod" && row.outcome === "follows" && row.check === "unknown") {
        warnings.push(`If production is already deployed, deploying ${row.after} stops and offers to keep its name.`);
      }
    }
    if (view.needsId) warnings.push(`Adds ${APP_ID_CONTEXT_KEY}, a permanent id every stack is tagged with, so this app's deployments are recognized whatever it is called.`);
    return this.stage(view, { name, appId: view.appId ?? newAppId(), targets, rows, warnings });
  }

  /**
   * Keeps a stage deploying under the name AWS shows it deployed as, when the
   * app's name no longer derives it: Deploy offers this for a stage found under
   * another name.
   */
  reviewDeployAs(input: { readonly stage?: unknown; readonly deployAs?: unknown; readonly hash?: unknown }): AppNameReview {
    const view = this.current(input.hash);
    if (!view.name || !view.appId) throw new OperationError(422, `Name this app in the navbar first, so ${CDK_FILE} has framework:app and framework:appId.`);
    const stage = view.stages.find((candidate) => candidate.stage === input.stage);
    if (!stage) throw new OperationError(422, `${String(input.stage)} is not a stage in ${TARGETS_CONTEXT_KEY}.`);
    const deployAs = typeof input.deployAs === "string" ? input.deployAs : "";
    const problem = deploymentNameProblem(deployAs);
    if (problem) throw new OperationError(422, `deployAs ${problem}`);
    const before = stage.deployAs ?? `${view.name}-${stage.stage}`;
    if (before === deployAs) throw new OperationError(422, `The ${stage.stage} stage already deploys as ${deployAs}.`);
    const declared = this.declaredTargets();
    const targets = { ...declared, [stage.stage]: { ...(declared[stage.stage] ?? {}), deployAs } };
    const row: AppNameRow = { stage: stage.stage, mode: stage.mode, before, after: deployAs, outcome: "keeps", check: "deployed", deployed: deployAs };
    return this.stage(view, { name: view.name, appId: view.appId, targets, rows: [row], warnings: [] });
  }

  apply(id: string): { name: string } {
    const pending = this.pending;
    if (!pending || pending.review.id !== id) throw new OperationError(409, "The review expired. Review again.");
    const file = path.join(this.root, CDK_FILE);
    const current = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (current !== pending.before) throw new OperationError(409, `${CDK_FILE} changed after review. Nothing was written; review again.`);
    writeSourceChange(this.root, file, pending.before, pending.after);
    this.ownWrites.set(CDK_FILE, sha256(pending.after));
    this.pending = undefined;
    return { name: pending.review.name };
  }
}
