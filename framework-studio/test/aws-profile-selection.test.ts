import { test } from "node:test";
import assert from "./support/assert";
import { parseModeProfiles } from "../src/aws-profile-selection";

test("browser cache accepts only profile names for the two declaration modes", () => {
  assert.deepEqual(parseModeProfiles('{"dev":"shared","prod":"shared","credentials":"ignored"}'), { dev: "shared", prod: "shared" });
  for (const invalid of [null, "bad json", "null", "[]", '"dev"']) assert.deepEqual(parseModeProfiles(invalid), {});
  assert.deepEqual(parseModeProfiles('{"dev":42,"prod":""}'), {});
  assert.deepEqual(parseModeProfiles('{"dev":"   ","prod":"production"}'), { prod: "production" });
});
