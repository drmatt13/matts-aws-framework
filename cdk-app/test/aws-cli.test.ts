import assert from "node:assert/strict";
import test from "node:test";
import { AwsCliError, classifyAwsError, runAwsSync } from "../../scripts/aws-cli";
import { classifyAwsConnectionError } from "../../scripts/aws-connections";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

test("missing credentials retain their diagnosis when the CLI suggests aws login", () => {
  assert.equal(classifyAwsError('aws: [ERROR]: An error occurred (NoCredentials): Unable to locate credentials. You can configure credentials by running "aws login".'), "no-credentials");
  assert.equal(classifyAwsError('Unable to locate credentials. Run "aws sso login".'), "no-credentials");
});

test("explicit expired sessions and tokens retain their diagnosis", () => {
  for (const message of [
    "An error occurred (ExpiredToken) when calling GetCallerIdentity: token has expired",
    "The SSO session associated with this profile has expired. Run aws sso login.",
    "Error loading SSO Token: refresh failed; Unable to locate credentials",
    "Run aws login to refresh the session.",
  ]) assert.equal(classifyAwsError(message), "expired", message);
});

test("AWS resource absence is not confused with the ENOTFOUND transport code", () => {
  const absent = "An error occurred (ResourceNotFoundException) when calling the DescribeSecret operation: Secrets Manager can't find the specified secret.";
  assert.equal(classifyAwsError(absent), "not-found", "planning must recognize a secret that has not been created yet");
  assert.notEqual(classifyAwsConnectionError(absent).code, "network");
  for (const code of ["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT"]) {
    assert.equal(classifyAwsConnectionError(`request failed: ${code} example.test`).code, "network");
    assert.equal(classifyAwsError(`request failed: ${code} example.test`), "failed");
  }
});

test("network and TLS refresh failures retain a network remedy instead of requesting sign-in", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "aws-network-error-"));
  const fake = path.join(directory, "fake.mjs");
  const previous = process.env.FRAMEWORK_AWS_CLI;
  try {
    const message = 'The SSO session has expired: refresh failed due SSL validation failed. Run aws sso login.';
    assert.equal(classifyAwsError(message), "failed");
    assert.equal(classifyAwsError("refresh failed: Could not connect to the endpoint URL. Run aws login."), "failed");
    writeFileSync(fake, `process.stderr.write(${JSON.stringify(message)}); process.exitCode=1;`);
    process.env.FRAMEWORK_AWS_CLI = fake;
    assert.throws(() => runAwsSync(["sts", "get-caller-identity"]), error => error instanceof AwsCliError && error.kind === "failed" && /network, proxy, TLS/.test(error.message) && !/Sign in again/.test(error.message) && !error.detail);
  } finally { if (previous === undefined) delete process.env.FRAMEWORK_AWS_CLI; else process.env.FRAMEWORK_AWS_CLI = previous; rmSync(directory, { recursive: true, force: true }); }
});
