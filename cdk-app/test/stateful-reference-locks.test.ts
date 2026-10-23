import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { acquireStatefulReferenceLocks } from "../../scripts/stateful-reference-locks";

const destination = { account: "111122223333", region: "us-east-1" };
const stack = (kind: "database" | "cognito", id: string) => ({ template: { Metadata: { "framework:stateful-reference": { kind, reference: kind === "database" ? { instanceIdentifier: id } : { userPoolId: id } } } } });
test("different destination names cannot concurrently reference the same physical stateful resource", () => {
  const scratch = path.resolve(__dirname, "../../.cache"); mkdirSync(scratch, { recursive: true });
  const cache = mkdtempSync(path.join(scratch, "stateful-lock-"));
  const reference = stack("cognito", "us-east-1_Original");
  let release = () => {};
  try {
    release = acquireStatefulReferenceLocks(cache, [reference], destination);
    assert.throws(() => acquireStatefulReferenceLocks(cache, [reference], { ...destination }), /Retained-resource operation.*cannot start.*Another deployment/);
    const releaseOtherAccount = acquireStatefulReferenceLocks(cache, [reference], { ...destination, account: "999988887777" });
    releaseOtherAccount();
    release();
    const releaseRetry = acquireStatefulReferenceLocks(cache, [reference], destination);
    releaseRetry();
    assert.deepEqual(readdirSync(cache), [], "Terminal and failed operation release is idempotent.");
  } finally { release(); rmSync(cache, { recursive: true, force: true }); }
});
test("multi-reference contention releases every partially acquired lock and ignores stack order", () => {
  const scratch = path.resolve(__dirname, "../../.cache"); mkdirSync(scratch, { recursive: true });
  const cache = mkdtempSync(path.join(scratch, "stateful-lock-"));
  const refs = [stack("cognito", "us-east-1_Pool"), stack("database", "original-db")];
  let release = () => {};
  try {
    release = acquireStatefulReferenceLocks(cache, refs.slice(0, 1), destination);
    assert.throws(() => acquireStatefulReferenceLocks(cache, [...refs].reverse(), destination), /cannot start/);
    assert.equal(readdirSync(cache).length, 1, "Contender did not leak a previously acquired physical lock.");
    release();
    const all = acquireStatefulReferenceLocks(cache, [...refs].reverse(), destination);
    assert.equal(readdirSync(cache).length, 2);
    all();
  } finally { release(); rmSync(cache, { recursive: true, force: true }); }
});
