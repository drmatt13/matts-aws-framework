import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, mock, test } from "node:test";
import { SnapshotBuilder } from "../server/snapshot";
import { EditService } from "../server/edits/transaction";

const require = createRequire(import.meta.url);
const atomic = require("../../scripts/atomic-replace.cjs") as typeof import("../../scripts/atomic-replace.cjs");
const repository = path.resolve(__dirname, "../..");
const cache = path.join(repository, ".cache/framework-studio/snapshot-recovery-tests");
mkdirSync(cache, { recursive: true });
afterEach(() => mock.restoreAll());

function fixture() {
  const root = mkdtempSync(path.join(cache, "case-"));
  mkdirSync(path.join(root, "framework-config"));
  mkdirSync(path.join(root, "cdk-app/lambda_functions/qa"), { recursive: true });
  cpSync(path.join(repository, "framework-config/defaults.ts"), path.join(root, "framework-config/defaults.ts"));
  writeFileSync(path.join(root, "package.json"), '{"private":true}');
  writeFileSync(path.join(root, "framework-config/http.ts"), 'export const http = { "/qa": { directory: "/lambda_functions/qa", methods: ["GET"] } };\n');
  writeFileSync(path.join(root, "cdk-app/lambda_functions/qa/index.ts"), 'export const lambdaHandler = async () => ({ statusCode: 200, body: "ready" });\n');
  writeFileSync(path.join(root, "framework.config.ts"), `import { defineFrameworkConfig, defineResources } from "@repo/framework/config";
import { defaults } from "./framework-config/defaults";
import { http } from "./framework-config/http";
export default defineFrameworkConfig({ defaults, resources: defineResources({}), http: [http], webSocket: [{}], events: [{}], services: [{}], tasks: [{}], workflows: [{}], tools: [{}], agents: [{}] });
`);
  return { root, builder: new SnapshotBuilder(root), cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

test("permanent projection failure publishes stale evidence, blocks all edits and recovers only after a successful refresh", async () => {
  const f = fixture();
  const projection = path.join(f.root, ".cache/framework-studio/cdk-links.json");
  try {
    const first = await f.builder.refresh();
    assert.equal(first.snapshot.models.dev.status, "ok", JSON.stringify(first.snapshot.models.dev.diagnostics));
    assert.ok(first.snapshot.models.dev.targets.length > 0);
    const before = readFileSync(projection, "utf8");
    const authored = readFileSync(path.join(f.root, "framework-config/http.ts"), "utf8");
    const original = atomic.replaceFileAtomic;
    const failure = Object.assign(new Error("do-not-copy-authored-exception-values"), { code: "EIO", path: projection });
    const replacement = mock.method(atomic, "replaceFileAtomic", (from: string, to: string, options?: import("../../scripts/atomic-replace.cjs").AtomicReplacementOptions) => {
      if (to === projection) throw failure;
      return original(from, to, options);
    });
    const failed = await f.builder.refresh();
    assert.notEqual(failed.snapshot.revision, first.snapshot.revision);
    assert.equal(f.builder.current, failed);
    assert.deepEqual(failed.snapshot.source, first.snapshot.source);
    for (const mode of ["dev", "prod"] as const) {
      assert.equal(failed.snapshot.models[mode].status, "error");
      assert.equal(failed.snapshot.models[mode].stale, true);
      assert.equal(failed.snapshot.models[mode].diagnostics[0]!.stage, "load");
      assert.deepEqual(failed.snapshot.models[mode].targets, first.snapshot.models[mode].targets);
      assert.match(failed.snapshot.models[mode].diagnostics[0]!.message, /Snapshot refresh failed.*EIO.*cdk-links\.json.*cannot be edited/);
    }
    assert.doesNotMatch(JSON.stringify(failed.snapshot), /do-not-copy-authored-exception-values/);
    const request = { target: "lambda:qa", field: "lambda.memorySize", patch: { origin: 'http["/qa"]', path: ["memorySize"], value: 256 } };
    const preflight = await failed.evaluation.preflight(request);
    assert.equal(preflight.dev.ok, false);
    assert.match(preflight.dev.diagnostics[0]!.message, /Snapshot refresh failed/);
    await assert.rejects(new EditService(f.root, f.builder).plan({ target: "lambda:qa", field: "lambda.memorySize", value: 256 }, failed.snapshot.revision), /stale|configuration|errors/i);
    failure.path = path.join(path.dirname(f.root), "outside-sensitive-path");
    const failedAgain = await f.builder.refresh();
    assert.notEqual(failedAgain.snapshot.revision, failed.snapshot.revision);
    assert.doesNotMatch(JSON.stringify(failedAgain.snapshot.models.dev.diagnostics), /outside-sensitive-path/);
    assert.equal(readFileSync(projection, "utf8"), before, "failed replacement preserves the complete prior projection");
    assert.ok(!readdirSync(path.dirname(projection)).some(file => /^cdk-links-.*\.tmp$/.test(file)), "failed projection cleans only its temporary file");
    assert.equal(readFileSync(path.join(f.root, "framework-config/http.ts"), "utf8"), authored);
    replacement.mock.restore();
    const recovered = await f.builder.refresh();
    assert.equal(recovered.snapshot.models.dev.status, "ok");
    assert.ok(!recovered.snapshot.models.dev.stale);
    const healthy = await recovered.evaluation.preflight(request);
    assert.equal(healthy.dev.ok, true, JSON.stringify(healthy));
    assert.equal(healthy.prod.ok, true, JSON.stringify(healthy));
  } finally { mock.restoreAll(); await f.builder.dispose(); f.cleanup(); }
});

test("initial snapshot I/O failure rejects without publishing a usable graph", async () => {
  const f = fixture();
  const failure = Object.assign(new Error("initial projection failure"), { code: "EIO" });
  mock.method(atomic, "replaceFileAtomic", () => { throw failure; });
  try {
    await assert.rejects(f.builder.refresh(), error => error === failure);
    assert.equal(f.builder.current, undefined);
  } finally { mock.restoreAll(); await f.builder.dispose(); f.cleanup(); }
});
