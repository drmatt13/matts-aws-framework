import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { getFrameworkTargets, getLambdaTargets, getLocalTargets, resolveLambdaTarget, validateFrameworkConfig, type FrameworkConfig } from "../src/config/index";
import { assertTargetArtifacts, createTargetArtifactValidator, type TargetSourceHost } from "../src/config/source";
import { createCognitoVerifierInputValidator } from "../scripts/check-auth";

function fixture(size = 3): FrameworkConfig {
  return {
    defaults: { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: {} } },
    http: Object.fromEntries(Array.from({ length: size }, (_, index) => [`/fixture-${index}`, { directory: `/lambda_functions/http_functions/fixture-${index}`, methods: ["GET"] }])),
    webSocket: {}, events: {}, services: {}, tasks: {}, workflows: {},
  } as FrameworkConfig;
}

const nodeHost: TargetSourceHost = {
  exists: (file) => path.basename(file) === "index.ts",
  isDirectory: () => true, realpath: (file) => file, entries: () => ["index.ts"],
};

test("batch Lambda resolution preserves the standalone resolver's complete settings", () => {
  const config = fixture();
  assert.deepEqual(getLambdaTargets(config), getFrameworkTargets(config).map(target => resolveLambdaTarget(config, target.id)));
});

test("artifact and verifier checks share operation-local settings without rereading the config per target", () => {
  const config = fixture(100);
  const targets = getFrameworkTargets(config), http = config.http;
  let reads = 0;
  Object.defineProperty(config, "http", { get() { reads++; return http; } });
  const artifacts = createTargetArtifactValidator(config, nodeHost);
  const verifier = createCognitoVerifierInputValidator(config);
  const preparedReads = reads;
  for (const target of targets) {
    artifacts(target, `/fixture/${target.id}`);
    verifier(target, () => "export const lambdaHandler = async () => ({});");
  }
  assert.equal(reads, preparedReads, "a target check must not normalize the complete config again");
});

test("fresh artifact operations and standalone callers see in-place build-setting changes", () => {
  const config = fixture(1), target = getFrameworkTargets(config)[0]!;
  createTargetArtifactValidator(config, nodeHost)(target, "/fixture");
  Object.assign(config.defaults.lambda, { runtime: "python3.13" });
  assert.throws(() => createTargetArtifactValidator(config, nodeHost)(target, "/fixture"), /has no lambda_function\.py/);
  assert.throws(() => assertTargetArtifacts(config, target, "/fixture", nodeHost), /has no lambda_function\.py/);
});

test("eager operation factories preserve the existing invalid-target diagnostic", () => {
  const config = fixture(2);
  Object.assign(config.http["/fixture-1"], { logRetentionDays: 2 });
  const failure = (operation: () => unknown) => { try { operation(); } catch (error) { return (error as Error).message; } throw new Error("Expected an invalid build setting"); };
  const previous = failure(() => getFrameworkTargets(config));
  assert.match(previous, /lambda:fixture-1 keeps logs for 2 days/);
  assert.equal(failure(() => createTargetArtifactValidator(config, nodeHost)), previous);
  assert.equal(failure(() => createCognitoVerifierInputValidator(config)), previous);
});

test("fresh verifier operations observe changed build settings, source and permission inputs", () => {
  const config = fixture(1);
  const source = 'import {authenticated} from "@repo/framework/runtime/auth"; export const lambdaHandler=authenticated(async()=>({}));';
  const check = () => createCognitoVerifierInputValidator(config)(getFrameworkTargets(config)[0]!, () => source);
  assert.throws(check, /handed neither/);
  Object.assign(config.http["/fixture-0"], { environment: { USER_POOL_ID: "fixture-pool", USER_POOL_CLIENT_ID: "fixture-client" } });
  assert.doesNotThrow(check);
  Object.assign(config.http["/fixture-0"], { environment: { USER_POOL_ID: "fixture-pool" } });
  assert.throws(check, /names only one/);
  Object.assign(config.http["/fixture-0"], { packaging: "container" });
  assert.doesNotThrow(check, "container source is not assumed to be a Node entry point");
  Object.assign(config.http["/fixture-0"], { packaging: "zip" });
  assert.throws(check, /names only one/, "a later invocation must resolve the new packaging");
});

test("standalone declaration validation and local selection normalize once per operation", () => {
  const config = fixture(100), http = config.http;
  let reads = 0;
  Object.defineProperty(config, "http", { get() { reads++; return http; } });
  validateFrameworkConfig(config);
  const validationReads = reads;
  reads = 0;
  assert.equal(getLocalTargets(config, ["http"]).length, 100);
  assert.equal(reads, validationReads, "neither operation may normalize once per route or target");
  assert.ok(reads <= 2, "whole-config HTTP discovery remains bounded");
});

test("local lane selection and disabled-route warnings preserve deploy settings", () => {
  const config = fixture(4);
  for (const [index, setting] of ["both", "local-only", "cloud-only", "none"].entries()) Object.assign(config.http[`/fixture-${index}`], { deploy: setting });
  assert.deepEqual(getLocalTargets(config, ["http"]).map(target => target.id), ["fixture-0", "fixture-1"]);
  const warnings: string[] = [], warn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try { validateFrameworkConfig(config); } finally { console.warn = warn; }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /HTTP route "\/fixture-3".*disabled in both cloud and local/);
});
