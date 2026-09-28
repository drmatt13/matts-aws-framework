import { readLocalResourceManifest } from "./environment";
import { findRepositoryRoot } from "../config/source";
import {
  integrationKey,
  type IntegrationSpec,
} from "@repo/framework/config";

/**
 * Which real AWS resources a locally orchestrated workflow talks to.
 *
 * Local development runs orchestration and compute on this machine and leaves
 * DynamoDB, SQS, SNS and EventBridge in AWS. That only works if the runner
 * knows *which* table and *which* queue — and the honest answer is: the ones
 * the selected development deployment created. It is not guessed from a naming
 * convention and not inferred from whichever credentials happen to be in the
 * environment, because both of those guesses are wrong exactly when it matters,
 * which is when someone has two deployments.
 *
 * So the deployment publishes the answer. `npm run export:cdk-outputs` collects
 * every binding output the deployment's stacks emit, adds the deployment's own
 * identity, and writes .framework/local/resources.json, mounted read-only into
 * the runner. Reading it is a parse, not a lookup: no AWS call
 * and no credential is needed to know what a workflow is pointed at.
 *
 * The document holds names, URLs and ARNs. It holds no secret, and nothing here
 * should ever put one in it.
 */

/** Diagnostic label for the integration document inside the local manifest. */
export const WORKFLOW_BINDINGS_DESCRIPTION = "Development workflow bindings";

export const WORKFLOW_BINDINGS_VERSION = 1;

export interface WorkflowBindingDocument {
  readonly version: number;
  /** `CDK_APP_NAME`: which deployment these bindings belong to. */
  readonly deployment: string;
  readonly account: string;
  readonly region: string;
  /** Which graph produced them. A dev deployment builds no state machines. */
  readonly mode: "dev" | "prod";
  /** `queue:approvals` to the queue URL, table name, topic ARN or bus name. */
  readonly integrations: Readonly<Record<string, string>>;
}

export class WorkflowBindingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WorkflowBindingError";
  }
}

function requireString(
  document: Record<string, unknown>,
  field: string,
): string {
  const value = document[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkflowBindingError(
      `${WORKFLOW_BINDINGS_DESCRIPTION} is missing "${field}". Re-run npm run export:cdk-outputs against the development deployment.`,
    );
  }
  return value;
}

/** Reads the document, or explains precisely what is wrong with it. */
export function parseWorkflowBindings(raw: string): WorkflowBindingDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WorkflowBindingError(
      `${WORKFLOW_BINDINGS_DESCRIPTION} is not JSON. It is written by npm run export:cdk-outputs and should not be edited by hand.`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkflowBindingError(`${WORKFLOW_BINDINGS_DESCRIPTION} is not an object.`);
  }
  const document = parsed as Record<string, unknown>;
  if (document.version !== WORKFLOW_BINDINGS_VERSION) {
    throw new WorkflowBindingError(
      `${WORKFLOW_BINDINGS_DESCRIPTION} is version ${String(document.version)}; this runner reads version ${WORKFLOW_BINDINGS_VERSION}. Re-run npm run export:cdk-outputs.`,
    );
  }
  const mode = document.mode;
  if (mode !== "dev" && mode !== "prod") {
    throw new WorkflowBindingError(
      `${WORKFLOW_BINDINGS_DESCRIPTION} has mode ${JSON.stringify(mode)}; it must be "dev" or "prod".`,
    );
  }
  const integrations: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    (document.integrations ?? {}) as Record<string, unknown>,
  )) {
    if (typeof value !== "string" || value.length === 0) {
      throw new WorkflowBindingError(
        `${WORKFLOW_BINDINGS_DESCRIPTION} binds ${key} to something that is not a string.`,
      );
    }
    integrations[key] = value;
  }

  return {
    version: WORKFLOW_BINDINGS_VERSION,
    deployment: requireString(document, "deployment"),
    account: requireString(document, "account"),
    region: requireString(document, "region"),
    mode,
    integrations,
  };
}

/** The document this process was given, or `undefined` when there is none. */
export function readWorkflowBindings(
  environment: NodeJS.ProcessEnv = process.env,
): WorkflowBindingDocument | undefined {
  const manifest = readLocalResourceManifest(findRepositoryRoot(), environment);
  return manifest ? { version: WORKFLOW_BINDINGS_VERSION, deployment: manifest.deployment, account: manifest.account, region: manifest.region, mode: manifest.mode, integrations: manifest.integrations } : undefined;
}

/**
 * The resource one reference is bound to in this deployment.
 *
 * An unbound reference is an error naming the deployment it was looked for in,
 * because "the queue is missing" and "you are pointed at last week's
 * deployment" are different problems with the same symptom.
 */
export function requireBinding(
  bindings: WorkflowBindingDocument | undefined,
  spec: IntegrationSpec,
): string {
  const key = integrationKey(spec);
  if (bindings === undefined) {
    throw new WorkflowBindingError(
      `This workflow talks to ${key}, and no binding document was supplied. Run npm run export:cdk-outputs against the development deployment and restart the local runner.`,
    );
  }
  const bound = bindings.integrations[key];
  if (bound === undefined) {
    const known = Object.keys(bindings.integrations);
    throw new WorkflowBindingError(
      `${key} is not bound in deployment "${bindings.deployment}". Call linkResource(...) beside the construct in application CDK and re-export. Bound here: ${known.length > 0 ? known.join(", ") : "nothing"}.`,
    );
  }
  return bound;
}
