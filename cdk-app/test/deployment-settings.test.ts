import assert from "node:assert/strict";
import test from "node:test";
import { listResourceDeclarations } from "@repo/framework/config";
import { resolveDeploymentInputs } from "../deployment";
import { deploymentInputs } from "../deployment-inputs";

const platform = { CDK_DEFAULT_ACCOUNT: "111122223333", CDK_DEFAULT_REGION: "us-east-1" };
const resolve = (file: Record<string, string> = {}, context: Record<string, unknown> = {}) =>
  resolveDeploymentInputs({ getContext: (key) => context[key], env: { ...platform, ...file } });

test("deployment settings resolve like workload inputs: -c, then the inputs file, then the declared default", () => {
  assert.equal(resolve().deploymentName, "matts-aws-framework");
  assert.equal(resolve({ CDK_APP_NAME: "from-file" }).deploymentName, "from-file");
  assert.equal(resolve({ CDK_APP_NAME: "from-file" }, { cdkAppName: "from-context" }).deploymentName, "from-context");
  assert.equal(resolve({ CDK_APP_NAME: " " }).deploymentName, "matts-aws-framework", "a blank line counts as unset");
  assert.equal(resolve({ SKIP_EMAIL_VERIFICATION: "TRUE" }).requestedSkipEmailVerification, true, "choices match without regard to case");
  assert.throws(() => resolve({ USE_FRONTEND_CUSTOM_DOMAIN: "maybe" }), /USE_FRONTEND_CUSTOM_DOMAIN \(or -c useFrontendCustomDomain\) must be "true" or "false"\. Received: maybe/);
  assert.equal(resolve({ GOOGLE_CLIENT_ID: "  client  " }).googleClientId, "client");
});

test("older and differently cased context keys are still honored", () => {
  const prod = { prodDeployment: "true" };
  const certificate = "arn:aws:acm:us-east-1:111122223333:certificate/abcd";
  const frontend = resolve({ FRONTEND_URL: "https://app.example.com" }, { ...prod, frontendCloudFrontCertificateArn: certificate });
  assert.equal(frontend.configuredFrontendCloudFrontCertificateArn, certificate);
  const legacy = resolve({}, { retainStatefulResouces: "true" });
  assert.equal(legacy.retainStatefulResources, true);
  assert.ok(legacy.warnings.some((warning) => /retainStatefulResouces is misspelled/.test(warning)));
  assert.equal(resolve({ RETAIN_STATEFUL_RESOURCES: "true" }, { retainStatefulResources: "false" }).retainStatefulResources, false, "the current spelling wins");
});

test("every deployment setting is a documented declaration the same in both graphs", () => {
  const dev = listResourceDeclarations(deploymentInputs("dev"));
  const prod = listResourceDeclarations(deploymentInputs("prod"));
  assert.deepEqual(dev, prod, "development settings are refused in production out loud, so production still reads them");
  for (const reference of dev) {
    assert.ok(reference.note, `${reference.fromEnv} explains itself where Studio shows it`);
    assert.equal(reference.kind, "string");
  }
});
