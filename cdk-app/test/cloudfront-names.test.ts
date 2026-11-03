import assert from "node:assert/strict";
import test from "node:test";
import { cloudFrontFunctionName } from "../lib/app/frontend-website-s3-stack";

test("CloudFront function names within AWS's 64 characters are exactly <stack>-<suffix>", () => {
  // The deployed production names, which must never change.
  assert.equal(cloudFrontFunctionName("my-aws-app-prod-FrontendWebsiteS3Stack", "strip-api-prefix"), "my-aws-app-prod-FrontendWebsiteS3Stack-strip-api-prefix");
  assert.equal(cloudFrontFunctionName("my-aws-app-prod-FrontendWebsiteS3Stack", "spa-rewrite"), "my-aws-app-prod-FrontendWebsiteS3Stack-spa-rewrite");
  const fits = "a".repeat(64 - "-spa-rewrite".length);
  assert.equal(cloudFrontFunctionName(fits, "spa-rewrite"), `${fits}-spa-rewrite`);
});

test("a longer name keeps its suffix and a stable hash within 64 characters, distinct per stack", () => {
  const stack = `${"a".repeat(63)}-FrontendWebsiteS3Stack`;
  const name = cloudFrontFunctionName(stack, "strip-api-prefix");
  assert.ok(name.length <= 64, `${name} is ${name.length} characters`);
  assert.match(name, /^a+-[0-9a-f]{8}-strip-api-prefix$/);
  assert.equal(cloudFrontFunctionName(stack, "strip-api-prefix"), name, "deterministic");
  assert.notEqual(cloudFrontFunctionName(`${"a".repeat(63)}-OtherStack-FrontendWebsiteS3Stack`, "strip-api-prefix"), name);
  assert.notEqual(cloudFrontFunctionName(stack, "spa-rewrite"), name);
});
