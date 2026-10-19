import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { locateConfigSource } from "../../../packages/framework/scripts/config-source";
import type { ApplyResponse, BatchPlanResponse, DraftEdit } from "../../shared/api";
import type { ModeModel } from "../../shared/model";
import { EvaluatorPool } from "../evaluator/pool";
import { assertWritable, hashEditableFiles, sha256, toRelative } from "../files";
import type { SnapshotBuilder, StudioState } from "../snapshot";
import { SourceFiles } from "../source";
import { fieldById } from "./fields";
import { EditError, writeAtomically } from "./io";
import { diffOf, planEdit } from "./plan";
import { formatLiteral } from "./splice";
import { replayHandlerFile, rewriteReplayHandler } from "./local-replay";
import type { RouteChange } from "./route";
import { DESCRIPTION_FILE, descriptionEntityIds } from "../../shared/descriptions";
import { parseDescriptions, renameRouteDescriptions, rewriteDescription } from "../descriptions";
import { resourceTypeErrors } from "../resources-source";
import { planFailureDestination, planTriggers, validateTriggerBindings } from "./triggers";
import { triggerTiming } from "../../shared/trigger-availability";
import { assertStackFile, nativeSignature, planNativeRemovals, scanWith } from "./native-triggers";

interface Change { readonly file: string; readonly before: string; readonly after: string }
export interface BatchJournal {
  readonly kind: "batch";
  readonly label: string;
  readonly changes: readonly Change[];
  readonly edits: readonly DraftEdit[];
  readonly routes: readonly RouteChange[];
  readonly replayTargets: readonly string[];
  readonly replaySources: readonly Change[];
  readonly triggerSources?: Readonly<Record<string, string>>;
  /** Linked CDK stack files written by native trigger removal (absolute paths). */
  readonly cdkSources?: readonly string[];
}
interface StoredBatch extends BatchJournal { readonly response: BatchPlanResponse; readonly revision: string; readonly hashes: Record<string, string> }
const identity = (model: ModeModel) => JSON.stringify(model.targets.map((target) => [target.ref, target.constructId]).sort((a, b) => a[0]!.localeCompare(b[0]!)));

/** Composes the existing literal splices in memory, then validates the final source once.
 * Its journal is owned by EditService, alongside the existing single-edit journal. */
export class BatchEditor {
  private readonly plans = new Map<string, StoredBatch>();
  constructor(private readonly root: string, private readonly builder: SnapshotBuilder, private readonly ownWrites: Map<string, string>) {}
  expirePlans(): void { this.plans.clear(); }
  private state(): StudioState {
    if (!this.builder.current) throw new EditError(503, "The configuration has not loaded yet.");
    return this.builder.current;
  }
  private unchanged(revision: string, hashes: Record<string, string>, triggerSources: Readonly<Record<string, string>> = {}): void {
    if (this.state().snapshot.revision !== revision || JSON.stringify(hashEditableFiles(this.root)) !== JSON.stringify(hashes)) throw new EditError(409, "Source files changed during this editing session. Your draft is preserved; discard it to load the latest configuration.");
    for (const [file, hash] of Object.entries(triggerSources)) {
      let actual: string | undefined;
      try { actual = sha256(readFileSync(path.join(this.root, file), "utf8")); } catch { /* A removed source also expires the review. */ }
      if (actual !== hash) throw new EditError(409, "Trigger capability or wiring source changed. Refresh and review again.");
    }
  }
  async plan(edits: readonly DraftEdit[], revision: string): Promise<BatchPlanResponse> {
    const state = this.state();
    const triggerSources = edits.some((edit) => edit.kind === "triggers" || edit.kind === "nativeTrigger" || edit.kind === "onFailure") ? state.snapshot.source.capabilityFiles : undefined;
    const hashes = hashEditableFiles(this.root);
    this.unchanged(revision, state.snapshot.files, triggerSources);
    if (!edits.length || edits.length > 100) throw new EditError(400, "Review between 1 and 100 setting changes together.");
    if (Object.values(state.snapshot.models).some((model) => model.stale || model.status === "error")) throw new EditError(422, "Fix configuration errors before reviewing changes.");
    const model = state.snapshot.models[state.snapshot.currentMode];
    const overrides = new Map<string, string>();
    const seen = new Set<string>();
    const summaries: string[] = [];
    const replayTargets: string[] = [];
    const handlerBefore = new Map<string, string>();
    for (const edit of edits) {
      const key = edit.kind === "field" ? `${edit.intent.target}:${edit.intent.field}` : edit.kind === "description" ? `description:${edit.entity}` : edit.kind === "triggers" ? `triggers:${edit.event}` : edit.kind === "onFailure" ? `onFailure:${edit.event}` : edit.kind === "nativeTrigger" ? `native:${edit.edge}` : edit.route;
      if (seen.has(key)) throw new EditError(400, "A draft can change each setting only once.");
      seen.add(key);
      if (edit.kind === "triggers") {
        try {
          const planned = planTriggers(this.root, state, edit.event, edit.bindings, new SourceFiles(overrides));
          overrides.set(planned.file, planned.after);
          summaries.push(`${edit.event} — update triggers`);
        } catch (error) { throw new EditError(422, error instanceof Error ? error.message : String(error)); }
      }
      if (edit.kind === "onFailure") {
        try {
          const planned = planFailureDestination(this.root, state, edit.event, edit.value, new SourceFiles(overrides));
          overrides.set(planned.file, planned.after);
          summaries.push(`${edit.event} — ${edit.value ? "set" : "remove"} failure destination`);
        } catch (error) { throw new EditError(422, error instanceof Error ? error.message : String(error)); }
      }
      if (edit.kind === "description") {
        if (!descriptionEntityIds(Object.values(state.snapshot.models)).has(edit.entity)) throw new EditError(404, "Select a managed map item to edit its description.");
        const file = assertWritable(this.root, DESCRIPTION_FILE);
        try { overrides.set(file, rewriteDescription(new SourceFiles(overrides).text(file), edit.entity, edit.value)); }
        catch (error) { throw new EditError(422, error instanceof Error ? error.message : String(error)); }
        summaries.push(`${edit.entity} — update description`);
      }
      if (edit.kind !== "field") continue;
      const { intent } = edit;
      const field = fieldById(intent.field);
      const fact = model.fields[intent.target]?.find((fact) => fact.field === intent.field);
      const origin = model.defaults?.find((group) => group.ref === intent.target)?.origin ?? model.targets.find((target) => target.ref === intent.target)?.origins[0];
      if (!field || !fact || !origin) throw new EditError(404, `${intent.target} has no editable setting ${intent.field}.`);
      const result = planEdit({ repositoryRoot: this.root, origin, field, fact, intent, files: new SourceFiles(overrides) });
      if ("refused" in result) throw new EditError(422, result.refused);
      assertWritable(this.root, result.planned.relativeFile);
      overrides.set(result.planned.file, result.planned.after);
      if (field.id === "events.localReplay") {
        const target = model.targets.find((target) => target.ref === intent.target)!;
        try {
          const { file, name } = replayHandlerFile(this.root, target);
          if (handlerBefore.has(file)) throw new Error("These events share a handler. Update their local replay settings together in source.");
          const before = new SourceFiles(overrides).text(file);
          handlerBefore.set(file, before);
          overrides.set(file, rewriteReplayHandler(file, before, name, !intent.inherit && intent.value === true));
          replayTargets.push(target.ref);
        } catch (error) { throw new EditError(422, error instanceof Error ? error.message : String(error)); }
      }
      summaries.push(`${intent.target} — ${result.planned.summary}`);
    }
    const nativeEdits = edits.flatMap((edit) => edit.kind === "nativeTrigger" ? [edit.edge] : []);
    let native: ReturnType<typeof planNativeRemovals> | undefined;
    if (nativeEdits.length) {
      try { native = planNativeRemovals(this.root, state, nativeEdits, new SourceFiles(overrides)); }
      catch (error) { throw new EditError(422, error instanceof Error ? error.message : String(error)); }
      for (const [file, after] of native.changes) overrides.set(file, after);
      for (const edge of native.removed) summaries.push(`${edge.to.replace(/^lambda:/, "")} — remove native ${edge.label} (${edge.source!.file}:${edge.source!.line})`);
    }
    // Rename all public keys together, after field splices, so aliases can swap paths
    // without rejecting a temporary duplicate or losing a preceding field edit.
    const files = new SourceFiles(overrides);
    const located = locateConfigSource(path.join(this.root, "framework.config.ts"), { repositoryRoot: this.root, host: files.host() });
    const replacements = new Map<string, { start: number; end: number; value: string }[]>();
    const routes: RouteChange[] = [];
    for (const edit of edits) {
      if (edit.kind !== "route") continue;
      const route = model.routes.find((route) => route.id === edit.route);
      if (!route || route.kind !== "http") throw new EditError(404, "Select an HTTP Lambda route.");
      if (!edit.value.startsWith("/") || edit.value.trim() !== edit.value || /[\r\n\0]/.test(edit.value)) throw new EditError(422, "A route must start with / and have no surrounding whitespace.");
      const entry = located.sections.http.find((entry) => entry.key === route.path);
      if (!entry) throw new EditError(422, "This route could not be located in source.");
      const quote = files.text(entry.file)[entry.keySpan.start];
      if (quote !== '"' && quote !== "'") throw new EditError(422, "Computed route keys must be edited in source.");
      const list = replacements.get(entry.file) ?? [];
      list.push({ start: entry.keySpan.start, end: entry.keySpan.end, value: formatLiteral(edit.value, quote) });
      replacements.set(entry.file, list);
      routes.push({ before: route.path, after: edit.value, target: route.target });
      summaries.push(`Route: ${route.path} → ${edit.value}`);
    }
    for (const [file, edits] of replacements) {
      assertWritable(this.root, toRelative(this.root, file));
      let text = files.text(file);
      for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
      overrides.set(file, text);
    }
    const descriptionFile = path.join(this.root, DESCRIPTION_FILE);
    if (routes.length && state.snapshot.files[DESCRIPTION_FILE]) {
      assertWritable(this.root, DESCRIPTION_FILE);
      try {
        const before = new SourceFiles(overrides).text(descriptionFile);
        const after = renameRouteDescriptions(before, routes);
        if (after !== before) overrides.set(descriptionFile, after);
      } catch (error) { throw new EditError(422, error instanceof Error ? error.message : String(error)); }
    }
    const changes = [...overrides].map(([file, after]) => ({ file, before: handlerBefore.get(file) ?? readFileSync(file, "utf8"), after })).filter((change) => change.before !== change.after);
    if (!changes.length) throw new EditError(422, "This draft has no source changes.");
    // Removing native wiring must take away exactly the selected triggers and nothing else.
    const expectedNative = native && (() => {
      const remaining = nativeSignature(state.snapshot.source.cdkLinks);
      for (const edge of native.removed) remaining.splice(remaining.indexOf(`trigger|${edge.from}|${edge.to}|${edge.label}|${edge.source?.file}`), 1);
      return remaining;
    })();
    const checked = await this.validate(Object.fromEntries(overrides), state, routes, expectedNative);
    for (const [file, before] of handlerBefore) if (readFileSync(file, "utf8") !== before) throw new EditError(409, "The event handler changed during review. Your draft is preserved; review it again.");
    for (const mode of [checked.models.dev, checked.models.prod]) for (const ref of replayTargets) {
      if (!checked.preflight[mode.mode].ok) continue;
      const target = mode.targets.find((target) => target.ref === ref);
      if (!target || !handlerBefore.has(replayHandlerFile(this.root, target).file)) throw new EditError(422, "Local replay must keep the event's TypeScript handler entry point.");
    }
    this.unchanged(revision, hashes, triggerSources);
    const response: BatchPlanResponse = {
      planId: randomUUID(), summaries,
      changes: changes.map(({ file, before, after }) => ({ file: toRelative(this.root, file), diff: diffOf(toRelative(this.root, file), before, after) })),
      preflight: checked.preflight, ok: checked.preflight.dev.ok && checked.preflight.prod.ok,
      impact: ["Applies this complete draft as one undoable change. Individual workload overrides remain in place when shared defaults change.",
        ...(replayTargets.length ? ["Updates localReplay and the handler's withLocalReplay wrapper together. Run framework:generate before deploying to refresh the replay manifest. Events that require local execution cannot turn replay off."] : []),
        ...(routes.length ? ["Public route paths change; Lambda target and construct identities are preserved. Regenerate the API contract and update callers before deployment."] : []),
        ...(triggerSources ? edits.filter((edit) => edit.kind === "triggers").flatMap((edit) => {
          const before = model.triggers?.filter((binding) => binding.event === edit.event) ?? [];
          return [
            ...before.filter((binding) => !edit.bindings.some((next) => JSON.stringify(next) === JSON.stringify(binding))).map((binding) => `Remove/update ${binding.resource || binding.adapter} → lambda:${edit.event} (${binding.id}).`),
            ...edit.bindings.filter((binding) => !before.some((old) => JSON.stringify(old) === JSON.stringify(binding))).flatMap((binding) => [
              `${binding.resource || binding.adapter} → lambda:${edit.event}: ${model.triggerAdapters?.find((item) => item.kind === binding.adapter)?.delivery ?? binding.adapter}. Handler contract acknowledged: ${binding.accepts}.`,
              ...[triggerTiming(state.snapshot, { ...binding, event: edit.event }).recommendation].filter((line): line is string => !!line),
              ...model.edges.filter((edge) => binding.adapter === "s3" && edge.relation === "grant" && edge.from === `lambda:${edit.event}` && edge.to === binding.resource && /grant(Read)?Write|grantPut/.test(edge.label)).map((edge) => `lambda:${edit.event} can write to this bucket (${edge.label}); its writes must not match this trigger's filter.`),
            ]),
          ];
        }) : []),
        ...edits.flatMap((edit) => edit.kind !== "onFailure" ? [] : [edit.value
          ? `Failed asynchronous runs of lambda:${edit.event} go to ${edit.value.destination} after ${edit.value.retryAttempts ?? 2} retries; the function is granted permission to send there. Queue and stream triggers keep their own failure handling.`
          : `Failed asynchronous runs of lambda:${edit.event} are dropped after Lambda's retries.`]),
        ...(native?.removed ?? []).flatMap((edge) => {
          const adapter = model.triggerAdapters?.find((item) => item.nativeSlots?.[edge.label] !== undefined || Object.values(item.nativeSlots ?? {}).includes(edge.label));
          const remaining = [...state.snapshot.source.cdkLinks.edges, ...model.edges.filter((item) => item.provenance === "declared")].filter((item) => item.relation === "trigger" && item.to === edge.to && !native!.removed.includes(item));
          return [
            `Removes native ${edge.label} (${edge.from} → ${edge.to}) from ${edge.source!.file}:${edge.source!.line}; it stops on the next deploy.`,
            ...(adapter?.kind === "cognito" && !["postConfirmation", "postAuthentication"].includes(edge.label) ? [`⚠ Cognito stops calling ${edge.label} synchronously: any sign-up, sign-in or message validation it performs no longer runs.`] : []),
            ...(remaining.length ? [] : [`${edge.to} keeps its declaration and will have no trigger.`]),
          ];
        }),
        "Compose Watch may restart local workloads after the source files are written. Deployment is a separate action."],
    };
    const replaySources = [...handlerBefore].map(([file, before]) => ({ file, before, after: overrides.get(file)! }));
    this.plans.set(response.planId, { kind: "batch", label: `${edits.length} inspector changes`, response, revision, hashes, changes, edits, routes, replayTargets, replaySources, triggerSources, ...(native ? { cdkSources: [...native.changes.keys()] } : {}) });
    return response;
  }
  private async validate(overrides: Record<string, string>, state: StudioState, routes: readonly RouteChange[], expectedNative?: readonly string[]) {
    const descriptions = overrides[path.join(this.root, DESCRIPTION_FILE)];
    if (descriptions !== undefined) parseDescriptions(descriptions);
    const pool = new EvaluatorPool(this.root);
    try {
      const models = await pool.evaluate(state.snapshot.webSocketApi, overrides);
      const triggerChange = [models.dev, models.prod].some((model: ModeModel) => JSON.stringify([model.triggers, model.failureDestinations]) !== JSON.stringify([state.snapshot.models[model.mode].triggers, state.snapshot.models[model.mode].failureDestinations]));
      const stackChange = Object.keys(overrides).some((file) => toRelative(this.root, file).startsWith("cdk-app/lib/"));
      const typeErrors = triggerChange || stackChange ? resourceTypeErrors(this.root, overrides) : [];
      const native = stackChange ? nativeSignature(scanWith(this.root, state, overrides)) : undefined;
      const unexpected = expectedNative && native ? [...native.filter((item) => !expectedNative.includes(item)).map((item) => `adds ${item}`), ...expectedNative.filter((item) => !native.includes(item)).map((item) => `removes ${item}`)] : [];
      const nativeMismatch = expectedNative && (JSON.stringify(native) !== JSON.stringify(expectedNative));
      const verdict = (model: ModeModel) => {
        const diagnostics = [...model.diagnostics];
        for (const message of typeErrors) diagnostics.push({ severity: "error", stage: "validate", message });
        if (nativeMismatch) diagnostics.push({ severity: "error", stage: "validate", message: `Removing this wiring would also change other native wiring (${unexpected.slice(0, 3).join("; ").replaceAll("|", " ") || "order"}). Edit it in source.` });
        for (const binding of model.triggers ?? []) {
          try { validateTriggerBindings(state.snapshot, binding.event, [binding]); }
          catch (error) { diagnostics.push({ severity: "error", stage: "validate", message: error instanceof Error ? error.message : String(error) }); }
        }
        if (identity(model) !== identity(state.snapshot.models[model.mode])) diagnostics.push({ severity: "error", stage: "validate", message: "An inspector edit must preserve workload target and construct identities." });
        for (const route of routes) if (!model.routes.some((item) => item.kind === "http" && item.path === route.after && item.target === route.target)) diagnostics.push({ severity: "error", stage: "validate", message: `Route ${route.after} must still reach ${route.target}.` });
        return { mode: model.mode, ok: !diagnostics.some((item) => item.severity === "error"), diagnostics };
      };
      return { models, native, preflight: { dev: verdict(models.dev), prod: verdict(models.prod) } };
    } finally { await pool.dispose(); }
  }
  async apply(planId: string, record: (entry: BatchJournal) => void): Promise<ApplyResponse> {
    const plan = this.plans.get(planId);
    if (!plan) throw new EditError(410, "This review expired. Your draft is preserved; review it again.");
    if (!plan.response.ok) throw new EditError(422, "Fix the rejected settings before applying this draft.");
    this.unchanged(plan.revision, plan.hashes, plan.triggerSources);
    return this.write(plan, false, () => record(plan));
  }
  replay(entry: BatchJournal, inverse: boolean, record: () => void): Promise<ApplyResponse> { return this.write(entry, inverse, record); }
  private async write(entry: BatchJournal, inverse: boolean, record: () => void): Promise<ApplyResponse> {
    const state = this.state();
    const hashes = hashEditableFiles(this.root);
    const triggerSources = entry.triggerSources ? state.snapshot.source.capabilityFiles : undefined;
    this.unchanged(state.snapshot.revision, hashes, triggerSources);
    const changes = entry.changes.map((change) => inverse ? { ...change, before: change.after, after: change.before } : change);
    const handlers = entry.replayTargets.map((ref) => state.snapshot.models[state.snapshot.currentMode].targets.find((target) => target.ref === ref)).map((target) => target && replayHandlerFile(this.root, target).file);
    for (const source of entry.replaySources) {
      if (!handlers.includes(source.file) || readFileSync(source.file, "utf8") !== (inverse ? source.after : source.before)) throw new EditError(409, "The event handler changed since review. No files were written.");
    }
    for (const change of changes) {
      if ((entry.cdkSources ?? []).includes(change.file)) assertStackFile(this.root, state, toRelative(this.root, change.file));
      else if (!handlers.includes(change.file)) assertWritable(this.root, toRelative(this.root, change.file));
      if (readFileSync(change.file, "utf8") !== change.before) throw new EditError(409, `${toRelative(this.root, change.file)} changed. Your draft is preserved; no files were written.`);
    }
    const routes = entry.routes.map((route) => inverse ? { ...route, before: route.after, after: route.before } : route);
    const checked = await this.validate(Object.fromEntries(changes.map((change) => [change.file, change.after])), state, routes);
    if (!checked.preflight.dev.ok || !checked.preflight.prod.ok) throw new EditError(422, "The complete draft no longer validates. Review the current configuration before trying again.");
    this.unchanged(state.snapshot.revision, hashes, triggerSources);
    for (const source of entry.replaySources) if (readFileSync(source.file, "utf8") !== (inverse ? source.after : source.before)) throw new EditError(409, "The event handler changed while validating. No files were written.");
    const written: Change[] = [];
    try {
      for (const change of changes) {
        if (readFileSync(change.file, "utf8") !== change.before) throw new Error("A source file changed while applying the draft.");
        writeAtomically(this.root, change.file, change.after);
        written.push(change);
        this.ownWrites.set(toRelative(this.root, change.file), sha256(change.after));
      }
      const actual = await this.builder.refresh();
      const descriptionChange = changes.find((change) => change.file === path.join(this.root, DESCRIPTION_FILE));
      if (descriptionChange && (actual.snapshot.descriptions.problem || JSON.stringify(actual.snapshot.descriptions.values) !== JSON.stringify(parseDescriptions(descriptionChange.after).values))) throw new Error("The descriptions did not match the review.");
      for (const mode of ["dev", "prod"] as const) {
        const model = actual.snapshot.models[mode];
        const expected = checked.models[mode];
        if (model.stale || model.status === "error" || identity(model) !== identity(expected)) throw new Error(`The ${mode} configuration did not match the review.`);
        if (JSON.stringify(model.triggers) !== JSON.stringify(expected.triggers)) throw new Error("Trigger connections did not match the review.");
        if (JSON.stringify(model.failureDestinations) !== JSON.stringify(expected.failureDestinations)) throw new Error("Failure destinations did not match the review.");
        if (checked.native && JSON.stringify(nativeSignature(actual.snapshot.source.cdkLinks)) !== JSON.stringify(checked.native)) throw new Error("Native triggers did not match the review.");
        for (const edit of entry.edits) {
          if (edit.kind !== "field") continue;
          const field = (model: ModeModel) => model.fields[edit.intent.target]?.find((fact) => fact.field === edit.intent.field);
          if (JSON.stringify([field(model)?.authored, field(model)?.effective]) !== JSON.stringify([field(expected)?.authored, field(expected)?.effective])) throw new Error(`The setting ${edit.intent.field} did not match the review.`);
        }
        for (const route of routes) if (!model.routes.some((item) => item.path === route.after && item.target === route.target)) throw new Error("A route did not match the review.");
      }
      record(); this.expirePlans();
      return { status: "applied", message: `Applied all ${entry.edits.length} changes.`, revision: actual.snapshot.revision };
    } catch (error) {
      let conflicted = false;
      for (const change of written.reverse()) {
        if (readFileSync(change.file, "utf8") !== change.after) { conflicted = true; continue; }
        writeAtomically(this.root, change.file, change.before);
        this.ownWrites.set(toRelative(this.root, change.file), sha256(change.before));
      }
      const actual = await this.builder.refresh(); this.expirePlans();
      return { status: conflicted ? "unconfirmed" : "reverted", message: `${error instanceof Error ? error.message : "The draft could not be applied."} ${conflicted ? "Concurrent edits were preserved; inspect the affected files." : "The source was restored."} Your draft is preserved.`, revision: actual.snapshot.revision };
    }
  }
}
