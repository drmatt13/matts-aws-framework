import assert from "./support/assert";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { projectSynthesisSummary } from "../server/operations/summaries";
import type { JobView } from "../shared/operations";

function fixture() {
  const state = mkdtempSync(path.join(os.tmpdir(), "studio-summary-"));
  const directory = path.join(state, "plans", "fixture-plan");
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "plan.json");
  const plan = { planId: "saved-plan-id", status: "ready", profile: "dev", createdAt: "2026-01-01", expiresAt: "2030-01-01",
    identity: { deployment: "fixture-dev", mode: "dev", region: "us-east-1", account: "123456789012" },
    stacks: [{ name: "fixture-dev-Stack", changes: Array.from({ length: 65 }, (_, index) => ({ logicalId: `Resource${index}`, type: "AWS::S3::Bucket", action: "add" })) }] };
  const save = (value: unknown = plan) => writeFileSync(file, JSON.stringify(value));
  save();
  const job: JobView = { id: "job-fixture", kind: "deploy-plan", title: "Synthesize fixture-dev", params: { deployment: "fixture-dev", profile: "dev" },
    status: "succeeded", planId: "fixture-plan", deployment: "fixture-dev", startedAt: "2026-01-01", lastSeq: 0,
    summary: "Synthesis ready: [redacted]5 resource changes to review; applying needs the name fixture-[redacted]." };
  return { state, file, plan, job, save, close: () => rmSync(state, { recursive: true, force: true }) };
}

test("historical synthesis summaries recover only their saved computed count without changing evidence", () => {
  const f = fixture();
  try {
    const bytes = readFileSync(f.file, "utf8");
    const projected = projectSynthesisSummary(f.state, f.job);
    assert.equal(projected.summary, "Synthesis ready: 65 resource changes to review; applying needs the name fixture-[redacted].");
    assert.equal(f.job.summary, "Synthesis ready: [redacted]5 resource changes to review; applying needs the name fixture-[redacted].");
    assert.equal(readFileSync(f.file, "utf8"), bytes);
  } finally { f.close(); }
});

test("unrelated, unfinished, differently scoped or unmasked jobs retain their recorded summaries", () => {
  const f = fixture();
  try {
    for (const patch of [
      { kind: "deploy-apply" as const }, { status: "failed" as const }, { status: "running" as const },
      { deployment: "other-dev" }, { deployment: undefined }, { params: { deployment: "fixture-dev" } }, { params: { ...f.job.params, profile: "other" } },
      { params: { ...f.job.params, deployment: "other-dev" } }, { params: { ...f.job.params, region: "us-west-2" } },
      { params: { ...f.job.params, mode: "prod" } }, { planId: "../foreign" },
      { summary: "Synthesis ready: 65 resource changes to review." }, { summary: "Private value: [redacted]5" },
    ]) {
      const job = { ...f.job, ...patch };
      assert.equal(projectSynthesisSummary(f.state, job), job);
    }
  } finally { f.close(); }
});

test("missing, unreadable, incomplete or differently owned plans never invent a historical count", () => {
  const f = fixture();
  try {
    for (const document of [
      { ...f.plan, identity: { ...f.plan.identity, deployment: "other-dev" } },
      { ...f.plan, profile: "other" }, { ...f.plan, status: "blocked" },
      { ...f.plan, stacks: undefined }, { ...f.plan, stacks: [{}] }, { ...f.plan, planId: undefined },
      { ...f.plan, stacks: [{ changes: "not-an-array" }] },
    ]) {
      f.save(document);
      assert.equal(projectSynthesisSummary(f.state, f.job), f.job);
    }
    writeFileSync(f.file, "unreadable");
    assert.equal(projectSynthesisSummary(f.state, f.job), f.job);
    rmSync(f.file);
    assert.equal(projectSynthesisSummary(f.state, f.job), f.job);
  } finally { f.close(); }
});
