import type { ModeModel, ModelResource, Snapshot } from "../shared/model";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { EvaluatorLifetime, EvaluatorPool, type Evaluation } from "./evaluator/pool";
import { hashEditableFiles, sha256 } from "./files";
import { buildSourceIndex, SourceFiles, type BuiltSourceIndex } from "./source";
import type { CatalogEntrySource } from "./source/catalog";
import { readDeclaredSchema, readLocalDatabases, withLocalDatabases } from "./database";
import { withDeploymentInputs } from "./deployment-inputs";
import { withExportStacks } from "./source/export-stacks";
import { readDescriptions } from "./descriptions";
import { withConnectionEvidence } from "./source/evidence";
import { withConnectionAuthorizations } from "../shared/permissions";
import { withClientEnvironment } from "./client-environment";
import { readClientMappings } from "./client-environment-source";
import { STACK_MEMBER_TAGGING, tagFacts, withAbsentTagging } from "./model/tags";
import { failedModel } from "./model/project";
import { replaceFileAtomic } from "../../scripts/atomic-replace.cjs";

/**
 * The studio's current understanding of the repository, rebuilt as a whole.
 *
 * A snapshot is never patched: a change anywhere evaluates both modes again,
 * re-reads the source and replaces it. Refreshes are serialized, and one that
 * is asked for while another runs is coalesced into a single follow-up.
 */

/** A stack's members as its class declares them, merged with the ones workloads read. */
function withClassMembers(model: ModeModel, catalog: ReadonlyMap<string, CatalogEntrySource>, cdkEdges: ModeModel["edges"]): ModeModel {
  const tagging = { ...model.tagging };
  const resources: ModelResource[] = [...model.resources];
  const index = new Map(resources.map((resource, position) => [resource.id, position]));
  for (const [catalogPath, entry] of catalog) {
    if (!entry.stack) continue;
    const stack = resources[index.get(`resource:${catalogPath}`) ?? -1];
    for (const member of entry.stack.members) {
      const id = `resource:${catalogPath}.${member.name}`;
      const parent = `resource:${catalogPath}`;
      const capability = member.category === "value" ? { kind: "logical" as const, note: "Public stack values have no independently taggable AWS resource." } : STACK_MEMBER_TAGGING;
      tagging[id] = { ...(tagging[id] ?? tagFacts(id, {}, capability, { entity: parent, tags: tagging[parent]?.effective ?? {} })), aws: capability };
      const existing = index.get(id);
      if (existing !== undefined) {
        const resource = resources[existing]!;
        const managed = resource.frameworkManaged === "database";
        resources[existing] = { ...resource, typeText: member.typeText, memberSource: "both",
          networkPlacement: managed ? model.managedDatabase?.subnet ?? member.networkPlacement : member.networkPlacement,
          networkId: managed ? model.databaseNetworkId : member.networkId };
        continue;
      }
      index.set(id, resources.length);
      resources.push({
        id,
        path: [...catalogPath.split("."), member.name],
        kind: "member",
        parent: `resource:${catalogPath}`,
        absent: stack?.absent === true,
        typeText: member.typeText,
        memberSource: "class",
        networkPlacement: member.networkPlacement, networkId: member.networkId,
      });
    }
    if (stack) resources[index.get(`resource:${catalogPath}`)!] = { ...stack, stackClass: entry.stack.className, stackUsage: entry.stackUsage };
  }
  const ids = new Set([...resources.map((resource) => resource.id), ...model.targets.map((target) => target.ref)]);
  const ownership = resources.filter((resource) => resource.frameworkManaged && resource.networkPlacement && resource.parent && ids.has(resource.parent)).map((resource): ModeModel["edges"][number] => ({
    id: `contains:${resource.parent}->${resource.id}`,
    relation: "contains",
    from: resource.parent!,
    to: resource.id,
    provenance: "derived",
    label: "Database in stack",
    detail: "This stack declares the application's framework-managed database.",
  }));
  return { ...model, resources, tagging,
    networks: model.networks?.map(network => ({ ...network, builtInProd: network.builtInProd || [...catalog].some(([name, entry]) => entry.stack?.networkIds?.includes(network.id) && entry.stackUsage?.status === "referenced" && resources.some(resource => resource.id === `resource:${name}` && !resource.absent)) })),
    edges: [...model.edges, ...ownership, ...cdkEdges.filter((edge) => ids.has(edge.from) && ids.has(edge.to))] };
}

export interface StudioState {
  readonly snapshot: Snapshot;
  readonly evaluation: Evaluation;
  readonly built: BuiltSourceIndex;
}

export class SnapshotBuilder {
  private closed = false;
  readonly evaluators = new EvaluatorLifetime();
  private generation = 0;
  private running: Promise<StudioState> | undefined;
  private pending: Promise<StudioState> | undefined;
  private latest: StudioState | undefined;
  readonly pool: EvaluatorPool;

  constructor(
    readonly repositoryRoot: string,
    log: (line: string) => void = () => {},
  ) {
    this.pool = new EvaluatorPool(repositoryRoot, log, this.evaluators);
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
    if (this.closed) return Promise.reject(new Error("The snapshot builder is closed."));
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
    if (this.closed) return Promise.reject(new Error("The snapshot builder is closed."));
    this.running = this.build().catch(async (error: unknown) => {
      // evaluate() has already replaced the previous workers. Never leave the
      // previous graph looking current while its preflight workers are gone.
      await this.pool.dispose();
      const previous = this.latest;
      if (!previous) throw error;
      const failure = error as NodeJS.ErrnoException | undefined;
      const code = typeof failure?.code === "string" && /^[A-Z][A-Z0-9_]{1,30}$/.test(failure.code) ? failure.code : undefined;
      const relative = typeof failure?.path === "string" && path.isAbsolute(failure.path) ? path.relative(this.repositoryRoot, failure.path) : undefined;
      const file = relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) ? relative.replaceAll("\\", "/").replace(/[\r\n\t]/g, " ").slice(0, 300) : undefined;
      // Source evaluation has its own diagnostics. This path handles refresh
      // I/O/index failures without copying arbitrary authored exception values.
      const reason = new Error(`Snapshot refresh failed${code ? ` (${code}${file ? `: ${file}` : ""})` : ""}. The last successful graph is retained and cannot be edited. Resolve the refresh failure and refresh Studio.`);
      const dev = failedModel("dev", reason, 0), prod = failedModel("prod", reason, 0);
      const evaluation: Evaluation = { dev, prod, preflight: async () => ({
        dev: { mode: "dev", ok: false, diagnostics: dev.diagnostics },
        prod: { mode: "prod", ok: false, diagnostics: prod.diagnostics },
      }) };
      this.generation += 1;
      const stale = (model: ModeModel, failed: ModeModel): ModeModel => ({ ...model, status: "error", stale: true, diagnostics: failed.diagnostics });
      this.latest = { ...previous, evaluation, snapshot: { ...previous.snapshot,
        revision: `${this.generation}-${sha256(`${previous.snapshot.revision}\n${reason.message}`).slice(0, 12)}`,
        generatedAt: new Date().toISOString(),
        models: { dev: stale(previous.snapshot.models.dev, dev), prod: stale(previous.snapshot.models.prod, prod) },
      } };
      return this.latest;
    }).finally(() => {
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
    const files = hashEditableFiles(this.repositoryRoot);
    const evaluation = await this.pool.evaluate();
    const freshDev = this.lastGood(evaluation.dev), freshProd = this.lastGood(evaluation.prod);
    const dev = withAbsentTagging(freshDev, freshProd);
    const prod = withAbsentTagging(freshProd, freshDev);
    const base = !dev.stale && dev.targets.length > 0 ? dev : prod;
    // One parse of each source file serves the index and both modes' evidence.
    const sources = new SourceFiles();
    const built = base.stale && this.latest ? this.latest.built : buildSourceIndex(this.repositoryRoot, base, sources);
    const schema = readDeclaredSchema(this.repositoryRoot);
    const localDatabase = readLocalDatabases(this.repositoryRoot);
    const clientMappings = readClientMappings(this.repositoryRoot);
    // A disposable studio projection, never a configuration input. Replace atomically.
    const directory = process.env.FRAMEWORK_STUDIO_STATE_DIRECTORY ? path.resolve(process.env.FRAMEWORK_STUDIO_STATE_DIRECTORY) : path.join(this.repositoryRoot, ".cache", "framework-studio");
    mkdirSync(directory, { recursive: true });
    const temporary = path.join(directory, `cdk-links-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify(built.index.cdkLinks, null, 2)}\n`, "utf8");
      replaceFileAtomic(temporary, path.join(directory, "cdk-links.json"));
    } finally {
      rmSync(temporary, { force: true });
    }
    this.generation += 1;
    const content = sha256(JSON.stringify({ files, conditions: [dev.targets.map(target => target.lanes.when), prod.targets.map(target => target.lanes.when)], schema: schema.hash, localDatabase }));
    const project = (model: ModeModel): ModeModel => {
      const declared = model.stale ? model : withExportStacks(withClassMembers(model, built.catalog, built.index.cdkLinks.edges), built.exportStacks);
      const comparisons = Object.values(clientMappings.mappings).flatMap(modes => Object.values(modes).flatMap(binding => binding.when ? [binding.when] : []));
      const enriched = withClientEnvironment(withDeploymentInputs(this.repositoryRoot, withLocalDatabases(declared, localDatabase.services), { dev, prod }, comparisons), clientMappings);
      return withConnectionAuthorizations(withConnectionEvidence(this.repositoryRoot, enriched, built.index, built.catalog, sources));
    };
    const snapshot: Snapshot = {
      descriptions: readDescriptions(this.repositoryRoot),
      schema,
      databaseProblems: localDatabase.problems,
      revision: `${this.generation}-${content.slice(0, 12)}`,
      generatedAt: new Date().toISOString(),
      repositoryRoot: this.repositoryRoot,
      models: {
        dev: project(dev),
        prod: project(prod),
      },
      source: built.index,
      files,
    };
    this.latest = { snapshot, evaluation, built };
    return this.latest;
  }

  dispose(): Promise<void> {
    this.closed = true;
    return this.evaluators.dispose();
  }
}
