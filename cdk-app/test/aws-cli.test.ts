import assert from "node:assert/strict";
import test from "node:test";
import { classifyAwsError } from "../../scripts/aws-cli";

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
