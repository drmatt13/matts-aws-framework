import type { DatabaseObservation, DatabaseSaveResult, DatabaseSourceReview, DatabaseValidation, DatabaseWorkbench } from "../shared/database-workbench";
import type { DeclaredSchema } from "../shared/database";

export interface DatabaseSessionApi {
  validate(source: string, signal?: AbortSignal): Promise<DatabaseValidation>;
  review(source: string, expectedRevision: string): Promise<DatabaseSourceReview>;
  save(reviewId: string): Promise<DatabaseSaveResult>;
}
export interface DatabaseSessionState {
  readonly baseline?: DatabaseWorkbench;
  readonly latest?: DatabaseWorkbench;
  readonly source: string;
  readonly version: number;
  readonly validation?: DatabaseValidation;
  readonly diagram?: DeclaredSchema;
  readonly validationVersion: number;
  readonly validating: boolean;
  readonly busy?: "review" | "save";
  readonly review?: DatabaseSourceReview;
  readonly error?: string;
  readonly observation?: DatabaseObservation;
}

/** An in-memory source session. Revisions, request generations and targets have separate identities. */
export class DatabaseSession {
  private state: DatabaseSessionState = { source: "", version: 0, validationVersion: -1, validating: false };
  private listeners = new Set<() => void>();
  private validationRequest = 0;
  private observationRequest = 0;
  private observationTarget?: { id: string; identity: string };
  private controller?: AbortController;
  constructor(private readonly api: DatabaseSessionApi) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.state;
  private update(change: Partial<DatabaseSessionState>) { this.state = { ...this.state, ...change }; this.listeners.forEach(listener => listener()); }
  get dirty() { return !!this.state.baseline && this.state.source !== this.state.baseline.source; }
  get conflict() { return !!this.state.baseline && !!this.state.latest && this.state.baseline.revision !== this.state.latest.revision; }
  get currentValid() { return this.state.validationVersion === this.state.version && this.state.validation?.valid === true; }
  sync(next: DatabaseWorkbench) {
    if (this.state.busy === "save") return;
    if (this.state.baseline?.revision === next.revision) {
      const previous = this.state.latest ?? this.state.baseline;
      if (this.state.baseline.configRevision !== next.configRevision) {
        this.cancelValidation(); this.invalidateObservation();
        const version = this.state.version + 1;
        if (this.dirty) this.update({ baseline: next, latest: next, version, validationVersion: -1, review: undefined, error: "Prisma configuration changed. Your draft is preserved; validate it again before reviewing." });
        else this.update({ baseline: next, latest: next, source: next.source, version, validation: next.validation, validationVersion: version, diagram: next.validation.schema ?? this.state.diagram, review: undefined, error: undefined });
        return;
      }
      if (JSON.stringify(previous.targets) !== JSON.stringify(next.targets)) this.invalidateObservation();
      this.update({ latest: next }); return;
    }
    this.invalidateObservation();
    if (this.dirty && this.state.source !== next.source) { this.update({ latest: next, review: undefined }); return; }
    this.cancelValidation();
    const version = this.state.version + 1;
    this.update({ baseline: next, latest: next, source: next.source, version, validation: next.validation, validationVersion: version, diagram: next.validation.schema ?? this.state.diagram, review: undefined, error: undefined });
  }
  setSource(source: string) {
    if (this.state.busy || source === this.state.source) return;
    this.cancelValidation(); this.invalidateObservation();
    this.update({ source, version: this.state.version + 1, review: undefined, error: undefined });
  }
  cancelValidation() { this.validationRequest++; this.controller?.abort(); this.controller = undefined; if (this.state.validating) this.update({ validating: false }); }
  async validate() {
    if (!this.state.baseline || this.state.busy) return;
    this.cancelValidation();
    const request = ++this.validationRequest;
    const version = this.state.version;
    const source = this.state.source;
    const controller = this.controller = new AbortController();
    this.update({ validating: true, error: undefined });
    try {
      const validation = await this.api.validate(source, controller.signal);
      if (request !== this.validationRequest || version !== this.state.version) return;
      this.update({ validation, validationVersion: version, validating: false, ...(validation.valid && validation.schema ? { diagram: validation.schema } : {}) });
    } catch (error) {
      if (request === this.validationRequest && !controller.signal.aborted) this.update({ validating: false, error: message(error) });
    }
  }
  async review() {
    if (!this.dirty || this.conflict || this.state.busy || !this.state.baseline) return;
    const version = this.state.version;
    const revision = this.state.baseline.revision;
    this.cancelValidation();
    this.update({ busy: "review", error: undefined });
    try {
      const review = await this.api.review(this.state.source, this.state.baseline.revision);
      if (version === this.state.version && revision === this.state.baseline?.revision && !this.conflict) this.update({ review, validation: review.validation, validationVersion: version, diagram: review.validation.schema ?? this.state.diagram });
    } catch (error) { this.update({ error: message(error) }); }
    finally { this.update({ busy: undefined }); }
  }
  closeReview() { if (!this.state.busy) this.update({ review: undefined }); }
  async save(): Promise<DatabaseSaveResult | undefined> {
    if (!this.state.review || this.conflict || this.state.busy || !this.state.baseline) return;
    const review = this.state.review;
    this.update({ busy: "save", error: undefined });
    try {
      const result = await this.api.save(review.reviewId);
      const baseline = { ...this.state.baseline, source: result.source, revision: result.revision, validation: review.validation };
      this.invalidateObservation();
      this.update({ baseline, latest: baseline, source: result.source, review: undefined });
      return result;
    } catch (error) { this.update({ error: message(error), review: undefined }); }
    finally { this.update({ busy: undefined }); }
  }
  /** Discard is an explicit document replacement; the editor retains its own undo history. */
  discard() {
    if (this.state.busy) return;
    const latest = this.state.latest ?? this.state.baseline;
    if (!latest) return;
    this.cancelValidation(); this.invalidateObservation();
    const version = this.state.version + 1;
    this.update({ baseline: latest, latest, source: latest.source, version, validation: latest.validation, validationVersion: version, diagram: latest.validation.schema ?? this.state.diagram, review: undefined, error: undefined });
  }
  /** Rebase preserves the draft bytes. The subsequent review shows all differences against latest saved source. */
  useLatestBaseline() {
    if (this.state.busy || !this.state.latest) return;
    this.update({ baseline: this.state.latest, review: undefined, error: undefined });
  }
  invalidateObservation() { this.observationRequest++; this.observationTarget = undefined; if (this.state.observation) this.update({ observation: undefined }); }
  beginObservation(targetId?: string) {
    this.invalidateObservation();
    const target = this.state.latest?.targets.find(target => target.id === targetId);
    if (target) this.observationTarget = { id: target.id, identity: target.identity };
    return this.observationRequest;
  }
  acceptObservation(request: number, observation: DatabaseObservation) {
    const target = this.state.latest?.targets.find(target => target.id === observation.targetId);
    if (request === this.observationRequest && observation.savedRevision === this.state.latest?.revision
      && target?.identity === observation.targetIdentity
      && (!this.observationTarget || this.observationTarget.id === observation.targetId && this.observationTarget.identity === observation.targetIdentity)) this.update({ observation });
  }
  dispose() { this.cancelValidation(); this.invalidateObservation(); }
}
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
