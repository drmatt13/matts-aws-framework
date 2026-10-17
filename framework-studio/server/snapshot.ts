import type { ModeModel, ModelResource, Snapshot } from "../shared/model";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { EvaluatorPool, type Evaluation } from "./evaluator/pool";
import { hashEditableFiles, sha256 } from "./files";
import { readDeploymentSettings } from "./inputs";
import { buildSourceIndex, type BuiltSourceIndex } from "./source";
import type { CatalogEntrySource } from "./source/catalog";
import { readDeclaredSchema, readLocalDatabases, withLocalDatabases } from "./database";
import { withDeploymentInputs } from "./deployment-inputs";

/**
 * The studio's current understanding of the repository, rebuilt as a whole.
 *
 * A snapshot is never patched: a change anywhere evaluates both modes again,
 * re-reads the source and replaces it. Refreshes are serialized, and one that
 * is asked for while another runs is coalesced into a single follow-up.
 */

/** A stack's members as its class declares them, merged with the ones workloads read. */
function withClassMembers(model: ModeModel, catalog: ReadonlyMap<string, CatalogEntrySource>, cdkEdges: ModeModel["edges"]): ModeModel {
  const resources: ModelResource[] = [...model.resources];
  const index = new Map(resources.map((resource, position) => [resource.id, position]));
  for (const [catalogPath, entry] of catalog) {
    if (!entry.stack) continue;
    const stack = resources[index.get(`resource:${catalogPath}`) ?? -1];
    for (const member of entry.stack.members) {
      const id = `resource:${catalogPath}.${member.name}`;
      const existing = index.get(id);
      if (existing !== undefined) {
        resources[existing] = { ...resources[existing]!, typeText: member.typeText, memberSource: "both" };
        continue;
      }
      index.set(id, resources.length);
      resources.push({
        id,
        path: [catalogPath, member.name],
        kind: "member",
        parent: `resource:${catalogPath}`,
        absent: stack?.absent === true,
        typeText: member.typeText,
        memberSource: "class",
      });
    }
    if (stack) resources[index.get(`resource:${catalogPath}`)!] = { ...stack, stackClass: entry.stack.className };
  }
  const ids = new Set(resources.map((resource) => resource.id));
  return { ...model, resources, edges: [...model.edges, ...cdkEdges.filter((edge) => ids.has(edge.from) && ids.has(edge.to))] };
}

export interface StudioState {
  readonly snapshot: Snapshot;
  readonly evaluation: Evaluation;
  readonly built: BuiltSourceIndex;
}

export class SnapshotBuilder {
  private generation = 0;
  private running: Promise<StudioState> | undefined;
  private pending: Promise<StudioState> | undefined;
  private latest: StudioState | undefined;
  readonly pool: EvaluatorPool;

  constructor(
    readonly repositoryRoot: string,
    log: (line: string) => void = () => {},
  ) {
    this.pool = new EvaluatorPool(repositoryRoot, log);
  }

  get current(): StudioState | undefined {
    return this.latest;
  }

  /**
   * Rebuilds. While a rebuild runs, every request joins one follow-up that
   * starts when it finishes, so the last change is always seen and no more than
   * one extra evaluation is ever queued.
   */
  refresh(): Promise<StudioState> {
    if (this.pending) return this.pending;
    if (this.running) {
      this.pending = this.running
        .catch(() => undefined)
        .then(() => {
          this.pending = undefined;
          return this.start();
        });
      return this.pending;
    }
    return this.start();
  }

  private start(): Promise<StudioState> {
    this.running = this.build().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /**
   * A mode that failed to load keeps showing its last good model, marked stale
   * and carrying the new diagnostics, so a half-typed edit in an editor does
   * not blank the view. A stale model is never edited against.
   */
  private lastGood(fresh: ModeModel): ModeModel {
    const loaded = !(fresh.status === "error" && fresh.targets.length === 0);
    const previous = this.latest?.snapshot.models[fresh.mode];
    if (loaded || !previous || previous.targets.length === 0) return fresh;
    return { ...previous, status: "error", stale: true, diagnostics: fresh.diagnostics, evaluatedInMs: fresh.evaluatedInMs };
  }

  private async build(): Promise<StudioState> {
    const settings = readDeploymentSettings(this.repositoryRoot);
    const files = hashEditableFiles(this.repositoryRoot);
    const evaluation = await this.pool.evaluate(settings.webSocketApi);
    const dev = this.lastGood(evaluation.dev);
    const prod = this.lastGood(evaluation.prod);
    const preferred = settings.currentMode === "prod" ? prod : dev;
    const fallback = settings.currentMode === "prod" ? dev : prod;
    const base = !preferred.stale && preferred.targets.length > 0 ? preferred : fallback;
    const built = base.stale && this.latest ? this.latest.built : buildSourceIndex(this.repositoryRoot, base);
    const schema = readDeclaredSchema(this.repositoryRoot);
    const localDatabase = readLocalDatabases(this.repositoryRoot);
    // A disposable studio projection, never a configuration input. Replace atomically.
    const directory = path.join(this.repositoryRoot, ".cache", "framework-studio");
    mkdirSync(directory, { recursive: true });
    const temporary = path.join(directory, `cdk-links-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify(built.index.cdkLinks, null, 2)}\n`, "utf8");
      renameSync(temporary, path.join(directory, "cdk-links.json"));
    } finally {
      rmSync(temporary, { force: true });
    }
    this.generation += 1;
    const content = sha256(JSON.stringify({ files, settings, schema: schema.hash, localDatabase }));
    const snapshot: Snapshot = {
      schema,
      databaseProblems: localDatabase.problems,
      revision: `${this.generation}-${content.slice(0, 12)}`,
      generatedAt: new Date().toISOString(),
      currentMode: settings.currentMode,
      webSocketApi: settings.webSocketApi,
      repositoryRoot: this.repositoryRoot,
      models: {
        dev: withDeploymentInputs(this.repositoryRoot, withLocalDatabases(dev.stale ? dev : withClassMembers(dev, built.catalog, built.index.cdkLinks.edges), localDatabase.services)),
        prod: withDeploymentInputs(this.repositoryRoot, withLocalDatabases(prod.stale ? prod : withClassMembers(prod, built.catalog, built.index.cdkLinks.edges), localDatabase.services)),
      },
      source: built.index,
      files,
    };
    this.latest = { snapshot, evaluation, built };
    return this.latest;
  }

  dispose(): Promise<void> {
    return this.pool.dispose();
  }
}
