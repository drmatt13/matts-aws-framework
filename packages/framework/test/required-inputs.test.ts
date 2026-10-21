import { applicationVpc as fixtureVpc } from "../../../framework-config/networks/application";
import assert from "node:assert/strict";
import test from "node:test";
import { assertRequirementsMet, defineFrameworkConfig, defineResources, getFrameworkTargets, resource, resolveCloudValues, type ResourceReference } from "../src/config";
import { resolveLocalWorkloadEnvironment } from "../src/local/environment";
import { defaults } from "../../../framework-config/defaults";

test("catalog required flags become consumer requirements for parameters and secret ARN projections", async () => {
  const prefix = resource.fromEnv("REQUIRED_INPUT");
  const resources = defineResources({ input: prefix.required(), optional: prefix, key: resource.secret("REQUIRED_KEY").required() });
  assert.equal(resources.optional.required, undefined, "builder prefixes are immutable");
  assert.equal(resources.key.arn.required, true);
  const config = defineFrameworkConfig({ networks: [fixtureVpc], resources, defaults, http: [{ "/fixture": { directory: "/lambda_functions/http_functions/required-fixture", methods: ["GET"], environment: { INPUT: resources.input, KEY_ARN: resources.key.arn } } }], webSocket: [], events: [], services: [] });
  const target = getFrameworkTargets(config)[0]!;
  assert.deepEqual(target.cloud.requirements.map((rule) => rule.require[0]!.path), [["input"], ["key"]]);
  assert.throws(() => assertRequirementsMet(target.cloud.requirements, { select: () => undefined, supplied: () => false }, "fixture"), /required/);
  const arn = "arn:aws:secretsmanager:us-east-1:111122223333:secret:fixture-AbCdEf";
  const resolve = (reference: ResourceReference) => reference.kind === "secret" ? { secretArn: arn } : reference.secretArn ? arn : "provided";
  assert.equal(resolveCloudValues(target, resolve, "fixture").environment.INPUT, "provided");
  const localConfig = defineFrameworkConfig({ networks: [fixtureVpc], resources, defaults, http: [{ "/fixture": { directory: "/lambda_functions/http_functions/required-fixture", methods: ["GET"], environment: { INPUT: resources.input } } }], webSocket: [], events: [], services: [] });
  await assert.rejects(resolveLocalWorkloadEnvironment(localConfig, target.reference, { repositoryRoot: ".", authored: {}, environment: {} }), /required/);
  assert.equal((await resolveLocalWorkloadEnvironment(localConfig, target.reference, { repositoryRoot: ".", authored: { REQUIRED_INPUT: "provided" }, environment: {} })).INPUT, "provided");
});
