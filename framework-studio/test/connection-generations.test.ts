import test from "node:test";
import assert from "./support/assert";
import { advanceConnectionGeneration, connectionGeneration } from "../src/connection-generations";

test("credential generations isolate affected profiles and invalidate both modes sharing a profile", () => {
  const initial = {};
  const generation = advanceConnectionGeneration(undefined, ["shared", "shared"]);
  const live = { awsConnectionGeneration: generation };
  assert.equal(connectionGeneration(initial, "shared"), "0:0");
  assert.equal(connectionGeneration(live, "shared"), "0:1");
  assert.equal(connectionGeneration(live, "unrelated"), "0:0");
  assert.equal(connectionGeneration(live, undefined), "0:0");
  const second = advanceConnectionGeneration(generation, ["unrelated"]);
  assert.equal(connectionGeneration({ awsConnectionGeneration: second }, "shared"), "0:1");
  assert.equal(connectionGeneration({ awsConnectionGeneration: second }, "unrelated"), "0:1");
  assert.deepEqual(generation, { all: 0, profiles: { shared: 1 } }, "generation updates preserve prior identities");
});

test("global invalidation supersedes every profile and handles literal profile names", () => {
  const first = advanceConnectionGeneration(undefined, ["__proto__", "constructor", "toString"]);
  for (const profile of ["__proto__", "constructor", "toString"])
    assert.equal(connectionGeneration({ awsConnectionGeneration: first }, profile), "0:1");
  const all = advanceConnectionGeneration(first, []);
  for (const profile of ["shared", "__proto__", undefined])
    assert.equal(connectionGeneration({ awsConnectionGeneration: all }, profile), "1:0");
  assert.equal(connectionGeneration({ awsConnectionGeneration: advanceConnectionGeneration(all) }, "shared"), "2:0");
});
