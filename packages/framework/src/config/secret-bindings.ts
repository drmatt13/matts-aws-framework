/**
 * The name every managed secret is derived under, and the retired document that
 * used to record it.
 *
 * Such a secret is declared once in the catalog and its value authored once, in
 * cdk-app/.env. Locally that is the whole story: Compose passes the value to
 * the container. A deployment cannot read your laptop, and both ways of
 * delivering a secret name it by ARN — ECS injects one, and a Lambda reads one
 * — so `npm run deploy` copies the value into Secrets Manager and hands the CDK
 * app the ARN it was given.
 *
 * {@link frameworkSecretName} is that derivation, and it is the live half of
 * this module: the deploy command and the CDK app each compute the name, and
 * neither stores it.
 *
 * The other half reads the note a separate sync command used to leave for
 * synth. `npm run deploy` supplies each ARN as a generated CloudFormation
 * parameter instead, so synthesis asks for no such document and an existing
 * file can be deleted. The parser stays because a supplied document is still
 * how a stack can be exercised with fixture handles, and a wrong one should say
 * so rather than point a workload at another deployment's secret.
 *
 * The ARN is deliberately the whole answer: `importSecret` imports by *complete*
 * ARN, so nothing downstream has to cope with a partial one.
 *
 * The document holds names and ARNs. It holds no secret value, and nothing here
 * should ever put one in it.
 */

/** Left by the retired sync command. Never authored by hand, and no longer read. */
export const SECRET_BINDINGS_FILE = "cdk-app/.secret-bindings.json";

/**
 * 2 since secrets moved into the resource catalog.
 *
 * A version 1 document keyed each secret by the workload that read it, so one
 * value read by two workloads was two secrets. The catalog is the inventory
 * now, and a mismatch here is the operator being told to re-run the command
 * rather than a deployment pointing at a secret nothing updates.
 */
export const SECRET_BINDINGS_VERSION = 2;

/** The command that supplies secret ARNs now, named in every diagnostic here. */
export const SECRET_BINDINGS_COMMAND = "npm run deploy";

/** The Secrets Manager secret one declared startup secret was synced to. */
export interface SyncedSecret {
  /** The Secrets Manager name this deployment synced the value under. */
  readonly name: string;
  /** Full ARN including the six-character suffix, as the API returned it. */
  readonly arn: string;
}

export interface SecretBindingDocument {
  readonly version: number;
  /** `CDK_APP_NAME`: which deployment these secrets belong to. */
  readonly deployment: string;
  readonly account: string;
  readonly region: string;
  /** `OPENAI_API_KEY` to the secret it was synced to. */
  readonly secrets: Readonly<Record<string, SyncedSecret>>;
}

export class SecretBindingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SecretBindingError";
  }
}

/**
 * Secrets Manager's own name grammar.
 *
 * Checked rather than trusted, because every part of a derived name comes from
 * something an author chose: a deployment name, a target id, an environment
 * name. A name this rejects would otherwise fail inside the AWS SDK, in a
 * message about a request rather than about a declaration.
 */
const SECRET_NAME_PATTERN = /^[A-Za-z0-9/_+=.@-]{1,512}$/;

/**
 * How one secret is keyed in the document: by the variable it is authored
 * under, which is the name the catalog derived and the operator typed.
 *
 * Deliberately not keyed by the workload that reads it. One authored value is
 * one secret however many workloads name it, and keying by consumer used to
 * mean two copies of one key in Secrets Manager the moment a second workload
 * wanted it.
 */
export function secretBindingKey(variable: string): string {
  return variable;
}

/**
 * The Secrets Manager name for one secret, derived identically by the deploy
 * command and by the CDK app.
 *
 * Keyed on the deployment name rather than a stack name, because the upload
 * happens before any stack exists — and because `CDK_APP_NAME` is already
 * the one thing that tells two deployments of this repository apart. Two real
 * environments are two `CDK_APP_NAME`s, so the CDK graph a deployment happens
 * to be building is deliberately not part of the name.
 *
 * Both sides derive it from the same two inputs, so a renamed declaration is a
 * secret the deploy command creates and uploads under the new name rather than
 * a workload quietly pointing at the secret nobody updates any more.
 */
export function frameworkSecretName(deployment: string, variable: string): string {
  const name = `${deployment}/secret/${variable}`;
  if (!SECRET_NAME_PATTERN.test(name)) {
    throw new SecretBindingError(
      `Secret name "${name}" is not a Secrets Manager name. Names are at most 512 of the characters A-Z a-z 0-9 / _ + = . @ - and are derived from CDK_APP_NAME and the declaration's environment variable.`,
    );
  }
  return name;
}

/**
 * The same shape, written for a reader of a generated example.
 *
 * Deployment-independent by construction: generation must not depend on which
 * deployment happens to be configured on the machine running it, so the name is
 * shown with `CDK_APP_NAME` left standing.
 */
export function frameworkSecretNameTemplate(variable?: string): string {
  return `\${CDK_APP_NAME}/secret/${variable ?? "<NAME>"}`;
}

function requireString(document: Record<string, unknown>, field: string): string {
  const value = document[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new SecretBindingError(
      `${SECRET_BINDINGS_FILE} is missing "${field}". Delete it and deploy with ${SECRET_BINDINGS_COMMAND}, which supplies secret ARNs itself.`,
    );
  }
  return value;
}

/** Reads the document, or explains precisely what is wrong with it. */
export function parseSecretBindings(raw: string): SecretBindingDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SecretBindingError(
      `${SECRET_BINDINGS_FILE} is not JSON. It was never authored by hand; delete it and deploy with ${SECRET_BINDINGS_COMMAND}.`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SecretBindingError(`${SECRET_BINDINGS_FILE} is not an object.`);
  }
  const document = parsed as Record<string, unknown>;
  if (document.version !== SECRET_BINDINGS_VERSION) {
    throw new SecretBindingError(
      `${SECRET_BINDINGS_FILE} is version ${String(document.version)}; this configuration reads version ${SECRET_BINDINGS_VERSION}. Delete it and deploy with ${SECRET_BINDINGS_COMMAND}.`,
    );
  }
  const secrets: Record<string, SyncedSecret> = {};
  for (const [key, value] of Object.entries(
    (document.secrets ?? {}) as Record<string, unknown>,
  )) {
    const binding = value as SyncedSecret | undefined;
    if (
      binding === null ||
      typeof binding !== "object" ||
      typeof binding.name !== "string" ||
      binding.name.length === 0 ||
      typeof binding.arn !== "string" ||
      binding.arn.length === 0
    ) {
      throw new SecretBindingError(
        `${SECRET_BINDINGS_FILE} binds ${key} to something that is not a { name, arn }. Delete it and deploy with ${SECRET_BINDINGS_COMMAND}.`,
      );
    }
    secrets[key] = { name: binding.name, arn: binding.arn };
  }

  return {
    version: SECRET_BINDINGS_VERSION,
    deployment: requireString(document, "deployment"),
    account: requireString(document, "account"),
    region: requireString(document, "region"),
    secrets,
  };
}

/**
 * Refuses a document written for somewhere else.
 *
 * "The secret is missing" and "you are pointed at another deployment" are
 * different problems with the same symptom, and the second one is the one that
 * would otherwise deploy a task reading another environment's key.
 */
export function assertSecretBindingsDeployment(
  document: SecretBindingDocument,
  expected: {
    readonly deployment: string;
    readonly account: string;
    readonly region: string;
  },
): void {
  if (
    document.deployment === expected.deployment &&
    document.account === expected.account &&
    document.region === expected.region
  ) {
    return;
  }
  throw new SecretBindingError(
    `${SECRET_BINDINGS_FILE} holds secrets for deployment "${document.deployment}" in ${document.account}/${document.region}; this deployment is "${expected.deployment}" in ${expected.account}/${expected.region}. Delete it and run ${SECRET_BINDINGS_COMMAND} against this deployment.`,
  );
}
