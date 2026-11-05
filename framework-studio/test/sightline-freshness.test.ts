import test from "node:test";
import assert from "node:assert/strict";
import { deploymentFreshness } from "../src/sightline/freshness";

test("Sightline freshness follows the read owner's policy without enabling a query or clock", () => {
  const input = { capturedAt: 1001, updatedAt: 1000, staleTime: 20000, invalidated: false, failed: false, available: true };
  assert.equal(deploymentFreshness(input).stale, false);
  assert.equal(deploymentFreshness({ ...input, capturedAt: 1000 + input.staleTime }).stale, true);
  assert.equal(deploymentFreshness(input).freshUntil, new Date(1000 + input.staleTime).toISOString());
  for (const change of [{ invalidated: true }, { failed: true }, { available: false }, { updatedAt: 0 }])
    assert.equal(deploymentFreshness({ ...input, ...change }).stale, true);
  assert.equal(deploymentFreshness({ ...input, updatedAt: 0 }).freshUntil, undefined);
});
