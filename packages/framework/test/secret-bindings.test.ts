import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSecretBindingsDeployment,
  frameworkSecretName,
  frameworkSecretNameTemplate,
  parseSecretBindings,
  secretBindingKey,
  SecretBindingError,
  SECRET_BINDINGS_COMMAND,
  SECRET_BINDINGS_VERSION,
} from "@repo/framework/config";

/**
 * The note the retired sync command left for synth.
 *
 * Every refusal here has to name the command that fixes it, because the reader
 * is someone who ran a deploy and got an error about a file they have never
 * opened. The other property under test is that the *name* is derived, not
 * stored twice: the deploy command and the CDK app each compute it, and the two
 * cannot be allowed to drift silently.
 */

const DOCUMENT = {
  version: SECRET_BINDINGS_VERSION,
  deployment: "matts-aws-framework",
  account: "111122223333",
  region: "eu-west-2",
  secrets: {
    OPENAI_API_KEY: {
      name: "matts-aws-framework/secret/OPENAI_API_KEY",
      arn: "arn:aws:secretsmanager:eu-west-2:111122223333:secret:matts-aws-framework/secret/OPENAI_API_KEY-AbCdEf",
    },
  },
};

const identity = {
  deployment: "matts-aws-framework",
  account: "111122223333",
  region: "eu-west-2",
};

test("the binding document is read as written, with its deployment identity", () => {
  const document = parseSecretBindings(JSON.stringify(DOCUMENT));
  assert.equal(document.deployment, "matts-aws-framework");
  assert.equal(document.account, "111122223333");
  assert.equal(document.region, "eu-west-2");
  assert.deepEqual(
    document.secrets[secretBindingKey("OPENAI_API_KEY")],
    DOCUMENT.secrets.OPENAI_API_KEY,
  );
});

test("a document from an incompatible version is refused with what to re-run", () => {
  assert.throws(
    () => parseSecretBindings(JSON.stringify({ ...DOCUMENT, version: 1 })),
    (error: Error) => {
      assert.ok(error instanceof SecretBindingError);
      assert.match(error.message, /version 1/);
      assert.ok(error.message.includes(SECRET_BINDINGS_COMMAND));
      return true;
    },
  );
});

test("a document that is not JSON says it was never edited by hand", () => {
  assert.throws(
    () => parseSecretBindings("not json"),
    (error: Error) => {
      assert.match(error.message, /is not JSON/);
      assert.ok(error.message.includes(SECRET_BINDINGS_COMMAND));
      return true;
    },
  );
});

test("a binding that is not a name and an ARN names the entry it came from", () => {
  assert.throws(
    () =>
      parseSecretBindings(
        JSON.stringify({
          ...DOCUMENT,
          secrets: { OPENAI_API_KEY: { arn: "" } },
        }),
      ),
    /OPENAI_API_KEY/,
  );
});

test("a missing deployment identity is named as the missing field", () => {
  const { deployment: _omitted, ...rest } = DOCUMENT;
  assert.throws(() => parseSecretBindings(JSON.stringify(rest)), /missing "deployment"/);
});

test("a document for another deployment is refused by name", () => {
  const document = parseSecretBindings(JSON.stringify(DOCUMENT));
  assert.throws(
    () => assertSecretBindingsDeployment(document, { ...identity, deployment: "other-app" }),
    (error: Error) => {
      assert.match(error.message, /"matts-aws-framework"/);
      assert.match(error.message, /"other-app"/);
      return true;
    },
  );
  assert.throws(
    () => assertSecretBindingsDeployment(document, { ...identity, region: "us-east-1" }),
    /us-east-1/,
  );
  // The matching case is the one that must not throw.
  assertSecretBindingsDeployment(document, identity);
});

test("a secret name is derived from the deployment and the variable alone", () => {
  // Not from the workload that reads it: one authored value is one secret
  // however many workloads name it, which is what keying by consumer got
  // wrong.
  assert.equal(
    frameworkSecretName("matts-aws-framework", "OPENAI_API_KEY"),
    "matts-aws-framework/secret/OPENAI_API_KEY",
  );
  assert.equal(
    frameworkSecretName("matts-aws-framework", "REPORT_TOKEN"),
    "matts-aws-framework/secret/REPORT_TOKEN",
  );
});

test("a secret name outside the Secrets Manager character set is refused", () => {
  assert.throws(
    () => frameworkSecretName("app name", "OPENAI_API_KEY"),
    (error: Error) => {
      assert.ok(error instanceof SecretBindingError);
      assert.match(error.message, /Secrets Manager name/);
      return true;
    },
  );
  assert.throws(() => frameworkSecretName("a".repeat(600), "Y"), /Secrets Manager name/);
});

test("the example template leaves CDK_APP_NAME standing", () => {
  // Generation must not depend on which deployment the generating machine is
  // configured for, so this is a shape rather than a name.
  assert.equal(frameworkSecretNameTemplate(), "${CDK_APP_NAME}/secret/<NAME>");
  assert.equal(
    frameworkSecretNameTemplate("OPENAI_API_KEY"),
    "${CDK_APP_NAME}/secret/OPENAI_API_KEY",
  );
});
