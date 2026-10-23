import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDeploymentInputs } from "../deployment";

const configured = { CDK_DEFAULT_ACCOUNT: "111122223333", CDK_DEFAULT_REGION: "us-east-1", USE_COGNITO_CUSTOM_DOMAIN: "true", COGNITO_DOMAIN_NAME: "auth.example.com", COGNITO_DOMAIN_CERTIFICATE_ARN: "arn:aws:acm:us-east-1:111122223333:certificate/1234abcd" };
test("Cognito custom-domain intent is parked in dev and applies only to prod", () => {
  const dev = resolveDeploymentInputs({ getContext: () => undefined, env: configured });
  assert.equal(dev.cognitoDomainName, undefined);
  assert.equal(dev.cognitoDomainCertificateArn, undefined);
  assert.ok(dev.warnings.some(warning => warning.includes("custom domain may be removed")));
  const prod = resolveDeploymentInputs({ getContext: key => key === "prodDeployment" ? true : undefined, env: configured });
  assert.equal(prod.cognitoDomainName, "auth.example.com");
  assert.equal(prod.cognitoDomainCertificateArn, configured.COGNITO_DOMAIN_CERTIFICATE_ARN);
});
test("dev does not validate an inactive custom-domain certificate or hostname", () => {
  const dev = resolveDeploymentInputs({ getContext: () => undefined, env: { ...configured, COGNITO_DOMAIN_NAME: "https://bad.example.com/path", COGNITO_DOMAIN_CERTIFICATE_ARN: "not-an-arn" } });
  assert.equal(dev.cognitoDomainName, undefined);
});
