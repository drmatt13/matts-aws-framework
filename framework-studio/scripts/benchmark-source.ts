import { sourceFixtureCheckpoint } from "../test/support/source-fixture";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { DraftEdit } from "../shared/api";

/** Real source review/apply in a private, env-free copy. No AWS, Docker or database effects. */
async function main() {
  const root = path.resolve(__dirname, "../..");
  const argument = (name: string, fallback: string) => {
    const at = process.argv.indexOf(name);
    return at < 0 ? fallback : process.argv[at + 1] ?? fallback;
  };
  const samples = Number(argument("--samples", "5"));
  assert.ok(Number.isInteger(samples) && samples > 0 && samples <= 100);
  const output = path.resolve(argument("--output", ".framework/job4/source.json"));
  mkdirSync(path.dirname(output), { recursive: true });
  const fixture = mkdtempSync(path.join(path.dirname(output), "source fixture "));
  const skip = new Set(["node_modules", ".git", ".cache", ".framework", "cdk.out", "dist", "build", "coverage"]);
  const filter = (file: string) => !skip.has(path.basename(file)) && (!path.basename(file).startsWith(".env") || /\.env\.(?:example|(?:dev|prod)\.template)$/.test(file));
  for (const relative of ["framework.config.ts", "framework-config", "package.json", "package-lock.json", "docker-compose.yml", "docker-compose.services.yml", "packages/framework/src", "packages/api-contract/src/generated", "cdk-app/lib", "cdk-app/bin", "cdk-app/deployment.ts", "cdk-app/database-settings.ts", "cdk-app/stateful-resources.ts", "cdk-app/cdk.json", "cdk-app/tsconfig.json", "cdk-app/lambda_functions", "cdk-app/ecs_containers", "agents", "scripts"]) {
    if (existsSync(path.join(root, relative))) cpSync(path.join(root, relative), path.join(fixture, relative), { recursive: true, filter });
  }
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  for (const relative of globSync(manifest.workspaces.map((pattern: string) => `${pattern}/package.json`), { cwd: root })) {
    mkdirSync(path.dirname(path.join(fixture, relative)), { recursive: true });
    cpSync(path.join(root, relative), path.join(fixture, relative));
  }
  type Span = { stage: string; ms: number };
  let spans: Span[] = [];
  const spawn = childProcess.spawn;
  const fork = childProcess.fork;
  childProcess.spawn = ((...args: Parameters<typeof spawn>) => {
    const started = performance.now();
    const child = spawn(...args);
    const list = args[1] as readonly string[];
    const stage = list?.some(arg => /generate-contracts\.ts$/.test(arg)) ? "generator subprocess" : "subprocess";
    child.once("exit", () => spans.push({ stage, ms: performance.now() - started }));
    return child;
  }) as typeof spawn;
  childProcess.fork = ((...args: Parameters<typeof fork>) => {
    const started = performance.now();
    const child = fork(...args);
    child.once("message", () => spans.push({ stage: "evaluator first answer", ms: performance.now() - started }));
    return child;
  }) as typeof fork;
  syncBuiltinESMExports();
  const { SnapshotBuilder } = await import("../server/snapshot");
  const { EditService } = await import("../server/edits/transaction");
  const { BatchEditor } = await import("../server/edits/batch");
  const { EvaluatorPool } = await import("../server/evaluator/pool");
  const { creationDefaults, readCreationRequest } = await import("../shared/creation");
  // Optional benchmark-only wrappers; production hot paths carry no timers.
  for (const [prototype, name, stage] of [[BatchEditor.prototype, "validate", "both-mode validation"], [EvaluatorPool.prototype, "evaluate", "both-mode evaluation"]] as const) {
    const holder = prototype as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const original = holder[name]!;
    holder[name] = async function (...args: unknown[]) {
      const started = performance.now();
      try { return await original.apply(this, args); }
      finally { spans.push({ stage, ms: performance.now() - started }); }
    };
  }
  const builder = new SnapshotBuilder(fixture);
  const edits = new EditService(fixture, builder);
  const records: { operation: string; ms: number; spans: Span[]; bytes?: number; rss: number }[] = [];
  async function measure<T>(operation: string, run: () => Promise<T>): Promise<T> {
    spans = [];
    const started = performance.now();
    const result = await run();
    const response = result && typeof result === "object" && "snapshot" in result ? result.snapshot : result;
    records.push({ operation, ms: performance.now() - started, spans: [...spans], bytes: response === undefined ? undefined : Buffer.byteLength(JSON.stringify(response)), rss: process.memoryUsage().rss });
    return result;
  }
  const revision = () => builder.current!.snapshot.revision;
  const field: DraftEdit = { kind: "field", intent: { target: "lambda:graphql-api", field: "lambda.memorySize", value: 768 } };
  const review = async (changes: readonly DraftEdit[]) => {
    const result = await edits.planBatch(changes, revision());
    assert.ok(result.ok, JSON.stringify(result.preflight));
    return result;
  };
  try {
    await measure("snapshot cold", () => builder.refresh());
    assert.equal(builder.current!.snapshot.models.dev.status, "ok");
    const snapshotOutput = argument("--snapshot-output", "");
    if (snapshotOutput) writeFileSync(path.resolve(snapshotOutput), JSON.stringify(builder.current!.snapshot));
    const cases: [string, readonly DraftEdit[]][] = [
      ["small Lambda property", [field]],
      ["add environment mapping", [{ kind: "connection", target: "lambda:graphql-api", connection: "resource", destination: "resource:langgraph.modelProvider", variable: "JOB4_PUBLIC_SETTING", enabled: true }]],
      ["add scoped IAM grant", [{ kind: "connection", target: "lambda:graphql-api", connection: "grant", destination: "resource:referenceExamples.documentsBucket", grant: "grantRead", scope: "job4/*", enabled: true }]],
      ["create HTTP Lambda", [{ kind: "create", request: readCreationRequest({ kind: "function", ...creationDefaults("function"), id: "job4-probe", category: "http", path: "/job4-probe", method: "GET", auth: false }) }]],
      ["multi-resource edit", [field, { kind: "field", intent: { target: "lambda:python-example", field: "lambda.memorySize", value: 768 } }]],
      ["description only", [{ kind: "description", entity: "lambda:graphql-api", value: "Job 4 benchmark" }]],
    ];
    const restoreSource = sourceFixtureCheckpoint(fixture, builder);
    for (const [name, changes] of cases) for (let sample = 0; sample < samples; sample++) await measure(name, () => review(changes));
    for (let sample = 0; sample < samples; sample++) {
      const plan = await review([field]);
      const applied = await measure("source Apply", () => edits.applyBatch(plan.planId));
      assert.equal(applied.status, "applied", applied.message);
      await restoreSource();
    }
    for (let sample = 0; sample < samples; sample++) {
      await measure("no-op refusal", async () => { await assert.rejects(review([{ kind: "description", entity: "lambda:graphql-api", value: builder.current!.snapshot.descriptions.values["lambda:graphql-api"] ?? "" }])); });
      await measure("invalid field refusal", async () => { await assert.rejects(review([{ kind: "field", intent: { target: "lambda:graphql-api", field: "lambda.memorySize", value: -1 } }])); });
      const file = path.join(fixture, "framework-config/workloads/http.ts");
      const before = readFileSync(file, "utf8");
      writeFileSync(file, `${before}\n// External edit ${sample}\n`);
      await measure("external source refresh", () => builder.refresh());
    }
    // These unchanged stages are measured separately, after the comparable
    // end-to-end scenarios; they do not warm the proposal samples above.
    const { planEdit, diffOf } = await import("../server/edits/plan");
    const { fieldById } = await import("../server/edits/fields");
    for (let sample = 0; sample < samples; sample++) {
      const model = builder.current!.snapshot.models.dev;
      const fact = model.fields["lambda:graphql-api"]!.find(fact => fact.field === "lambda.memorySize")!;
      const target = model.targets.find(target => target.ref === "lambda:graphql-api")!;
      const planned = await measure("AST splice and exact diff (unchanged stage)", async () => planEdit({ repositoryRoot: fixture, origin: target.origins[0]!, field: fieldById("lambda.memorySize")!, fact, intent: { target: target.ref, field: "lambda.memorySize", value: 768 } }));
      assert.ok("planned" in planned);
      await measure("diff calculation only (unchanged stage)", async () => diffOf(planned.planned.relativeFile, planned.planned.before, planned.planned.after));
      const response = await review([field]);
      await measure("proposal JSON serialization (unchanged stage)", async () => JSON.stringify(response));
    }
  } finally {
    await builder.dispose();
    childProcess.spawn = spawn;
    childProcess.fork = fork;
    syncBuiltinESMExports();
    const operations = [...new Set(records.map(record => record.operation))].map(operation => {
      const values = records.filter(record => record.operation === operation).map(record => record.ms).sort((a, b) => a - b);
      return { operation, n: values.length, medianMs: values[Math.floor(values.length / 2)], maxMs: values.at(-1) };
    });
    const patch = childProcess.execFileSync("git", ["diff", "--binary", "HEAD", "--", "framework-studio/server", "packages/framework/src/config", "packages/framework/scripts"], { cwd: root });
    writeFileSync(output, JSON.stringify({ capturedAt: new Date().toISOString(), sourceRevision: childProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), sourcePatchHash: createHash("sha256").update(patch).digest("hex"), environment: { platform: process.platform, arch: process.arch, node: process.version, npm: manifest.packageManager, os: os.release(), cpu: os.cpus()[0]?.model, cores: os.cpus().length, memory: os.totalmem() }, note: "Serial local samples; cold is process-cold, not OS-cache-cold. Stages nest and must not be added together. Max is reported; n is too small for p95.", fixture: { targets: builder.current?.snapshot.models.dev.targets.length, resources: builder.current?.snapshot.models.dev.resources.length }, operations, records }, null, 2) + "\n");
    rmSync(fixture, { recursive: true, force: true });
    console.log(JSON.stringify({ output, operations }, null, 2));
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
