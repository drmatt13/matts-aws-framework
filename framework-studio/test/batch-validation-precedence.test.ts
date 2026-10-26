import assert from "./support/assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { BatchEditor, type BatchJournal } from "../server/edits/batch";
import { EditError } from "../server/edits/io";
import { failedModel } from "../server/model/project";
import type { SnapshotBuilder } from "../server/snapshot";
import type { Mode, ModeModel } from "../shared/model";

function model(mode: Mode, fallback: string): ModeModel {
  return { ...failedModel(mode, "fixture"), status: "ok", diagnostics: [], resources: [
    { id: "resource:probe", kind: "input", path: ["probe"], absent: false, fromEnv: "PROBE", default: fallback },
  ] };
}

// The reviewed minimal input model has no workloads, routes, networks or tags.
const reviewedSignature = JSON.stringify({ targets: [], routes: [], resources: [
  { id: "resource:probe", kind: "input", absent: false, fromEnv: "PROBE", fallback: "reviewed" },
], workflows: [], tagging: "[]", edges: [] });

for (const guard of ["creationModels", "operationModels"] as const) {
  for (const rejected of [true, false]) test(`${guard}: ${rejected ? "failed preflight reports 422 before semantic mismatch" : "validated changed semantics still report 409"}`, async () => {
    const parent = path.resolve(__dirname, "../../.cache/framework-studio");
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(path.join(parent, "validation-precedence-"));
    const source = path.join(root, "framework.config.ts");
    writeFileSync(source, "// Source must remain untouched.\nexport default {};\n");
    const original = readFileSync(source, "utf8");
    let writes = 0, records = 0;
    const baseline = { dev: model("dev", "reviewed"), prod: model("prod", "reviewed") };
    const builder = { current: { snapshot: { revision: "fixture", models: baseline, source: { capabilityFiles: {} } } },
      refresh: async () => { throw new Error("Rejected validation must not refresh written source."); },
    } as unknown as SnapshotBuilder;
    const editor = new BatchEditor(root, builder, new Map(), () => { writes++; });
    const models = rejected
      ? { dev: failedModel("dev", "Controlled evaluator deadline"), prod: baseline.prod }
      : { dev: model("dev", "changed"), prod: baseline.prod };
    const preflight = {
      dev: { mode: "dev" as const, ok: !rejected, diagnostics: rejected ? models.dev.diagnostics : [] },
      prod: { mode: "prod" as const, ok: true, diagnostics: [] },
    };
    // Inject only the completed validator result; exercise the real write guards.
    (editor as unknown as { validate: () => Promise<unknown> }).validate = async () => ({ models, preflight });
    const entry: BatchJournal = {
      kind: "batch", label: "Reviewed input", changes: [], edits: [], routes: [], replayTargets: [], replaySources: [],
      [guard]: { forward: { dev: reviewedSignature, prod: reviewedSignature }, inverse: { dev: reviewedSignature, prod: reviewedSignature } },
    };
    try {
      await assert.rejects(editor.replay(entry, false, () => { records++; }), (error: unknown) =>
        error instanceof EditError && error.status === (rejected ? 422 : 409));
      assert.equal(writes, 0);
      assert.equal(records, 0);
      assert.equal(readFileSync(source, "utf8"), original);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
