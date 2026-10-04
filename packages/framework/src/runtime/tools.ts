import type { Context } from "aws-lambda";
import { IDENTITY_ARGUMENT } from "../protocol/agentcore";
import {
  AuthUnavailableError,
  verifyCognitoIdToken,
  type AuthenticatedCognitoSession,
} from "./cognito";

/**
 * Writing an AgentCore tool.
 *
 *   export const lambdaHandler = tool(contract, async (input) => {
 *     return { title: "…", status: "open" };
 *   });
 *
 *   export const lambdaHandler = authenticatedTool(contract, async (input, session) => {
 *     return casesRepository.findOwned(session.payload.sub, input.caseNumber);
 *   });
 *
 * `contract` is the module beside the handler — `{ description, request,
 * response }` as Zod schemas — and the same wrapper runs under the local
 * Gateway emulator and behind the deployed Gateway, so a tool is validated the
 * same way in both lanes. The Gateway schema is a projection of this contract
 * for the model to read; this is where it is enforced.
 *
 * Pair `authenticatedTool` with `auth: true` on the declaration, exactly as
 * `authenticated` pairs with an `auth: true` route; framework:check refuses one
 * without the other.
 */

/** The part of a Zod schema a wrapper uses. Structural, so any Zod version fits. */
export interface ContractSchema<Output> {
  safeParse(value: unknown):
    | { readonly success: true; readonly data: Output }
    | {
        readonly success: false;
        readonly error: { readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[] };
      };
}

export interface ToolContract<Request = unknown, Response = unknown> {
  /** What the model reads to decide when to call the tool. */
  readonly description: string;
  readonly request: ContractSchema<Request>;
  readonly response: ContractSchema<Response>;
}

type RequestOf<Contract> = Contract extends ToolContract<infer Request, unknown> ? Request : never;
type ResponseOf<Contract> = Contract extends ToolContract<unknown, infer Response> ? Response : never;

/** What a Gateway Lambda target is invoked with: the argument map, and Lambda's context. */
export type ToolLambdaHandler<Response> = (event: unknown, context: Context) => Promise<Response>;

/**
 * The model sent arguments the contract refuses. Its message names each field
 * and is safe to show the model, which can correct the call and retry.
 */
export class ToolInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/** A user tool was called without a verifiable signed-in user. */
export class ToolAuthorizationError extends Error {
  public constructor() {
    super("This tool acts as the signed-in user, and the call carried no valid session.");
    this.name = "ToolAuthorizationError";
  }
}

function describeIssues(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): string {
  return issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.map(String).join(".") : "arguments"}: ${issue.message}`)
    .join("; ");
}

/** The argument map without the identity, and the identity if one was sent. */
function separateIdentity(event: unknown): { readonly args: unknown; readonly identity: unknown } {
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    return { args: event, identity: undefined };
  }
  const { [IDENTITY_ARGUMENT]: identity, ...args } = event as Record<string, unknown>;
  return { args, identity };
}

async function runTool<Request, Response>(
  contract: ToolContract<Request, Response>,
  args: unknown,
  body: (input: Request) => Promise<Response>,
): Promise<Response> {
  const request = contract.request.safeParse(args);
  if (!request.success) {
    throw new ToolInputError(`Invalid arguments. ${describeIssues(request.error.issues)}`);
  }

  // Everything below the contract check is the tool's own business. Its errors
  // are logged here, with their stack, and answered with one sentence: what a
  // tool throws can carry a query, a credential or a row, and the answer goes
  // back through the Gateway to a model.
  let result: Response;
  try {
    result = await body(request.data);
  } catch (error) {
    console.error("Tool failed:", error);
    throw new Error("Tool execution failed.");
  }
  const response = contract.response.safeParse(result);
  if (!response.success) {
    console.error(`Tool returned a result its contract refuses: ${describeIssues(response.error.issues)}`);
    throw new Error("Tool execution failed.");
  }
  return response.data;
}

/** A tool with service authority: it acts as the application, never as a user. */
export function tool<Contract extends ToolContract>(
  contract: Contract,
  handler: (input: RequestOf<Contract>, context: Context) => Promise<ResponseOf<Contract>>,
): ToolLambdaHandler<ResponseOf<Contract>> {
  return async (event, context) => {
    // A service tool ignores an identity rather than refusing one, so binding it
    // to an agent with users later changes nothing about how it is called.
    const { args } = separateIdentity(event);
    return runTool(contract as ToolContract<RequestOf<Contract>, ResponseOf<Contract>>, args, (input) =>
      handler(input, context),
    );
  };
}

/**
 * A tool that acts as the signed-in user whose agent called it. The session is
 * verified here, against Cognito, with the verifier `authenticated` uses — the
 * tool trusts neither the agent nor the Gateway for who the user is.
 */
export function authenticatedTool<Contract extends ToolContract>(
  contract: Contract,
  handler: (
    input: RequestOf<Contract>,
    session: AuthenticatedCognitoSession,
    context: Context,
  ) => Promise<ResponseOf<Contract>>,
): ToolLambdaHandler<ResponseOf<Contract>> {
  return async (event, context) => {
    const { args, identity } = separateIdentity(event);
    if (typeof identity !== "string" || identity.length === 0) throw new ToolAuthorizationError();
    let payload: Awaited<ReturnType<typeof verifyCognitoIdToken>>;
    try {
      payload = await verifyCognitoIdToken(identity);
    } catch (error) {
      if (error instanceof AuthUnavailableError) console.error(error.message, error.reason);
      throw error;
    }
    if (!payload) throw new ToolAuthorizationError();
    const session: AuthenticatedCognitoSession = { idToken: identity, payload };
    return runTool(contract as ToolContract<RequestOf<Contract>, ResponseOf<Contract>>, args, (input) =>
      handler(input, session, context),
    );
  };
}
