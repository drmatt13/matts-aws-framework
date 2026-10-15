import { COGNITO_VERIFIER_ENVIRONMENT, getFrameworkTargets, type FrameworkConfig } from "../src/config/index";

/**
 * A Lambda whose handler verifies a Cognito token declares the pool it verifies
 * against.
 *
 * The verifier behind `authenticated()` reads USER_POOL_ID and
 * USER_POOL_CLIENT_ID, and only the declaration can supply them. Without them
 * the route type-checks, generates and starts, then answers its first
 * signed-in request with a 500. Tools and agents are checked from their
 * `auth: true` (see validateAgentCoreConfig); a Lambda is checked from its
 * handler instead, because an `auth: true` route may rely on the gateway's
 * authorizer alone, and a handler may verify a token on a route without one.
 */

const VERIFIER_CALL =
  /(?<![\w.$])(authenticated|getAuthenticatedSession|getAuthenticatedUser|getAuthenticatedSub|getAuthenticatedHttpSession|verifyCognitoIdToken)\s*\(/;

const EXAMPLE_VALUES: Readonly<Record<(typeof COGNITO_VERIFIER_ENVIRONMENT)[number], string>> = {
  USER_POOL_ID: "resources.cognito.userPool.userPoolId",
  USER_POOL_CLIENT_ID: "resources.cognito.userPoolClient.userPoolClientId",
};

/** `read(reference)` is the entry module's source, or undefined when there is none. */
export function assertCognitoVerifierInputs(
  config: FrameworkConfig,
  read: (reference: string) => string | undefined,
): void {
  for (const target of getFrameworkTargets(config)) {
    if (target.kind !== "lambda") continue;
    const source = read(target.reference);
    const verifier = source === undefined ? undefined : VERIFIER_CALL.exec(source)?.[1];
    if (verifier === undefined) continue;
    const missing = COGNITO_VERIFIER_ENVIRONMENT.filter((name) => target.environment[name] === undefined);
    if (missing.length === 0) continue;
    const origin = target.origins[0] ?? target.reference;
    throw new Error(
      `${origin}'s handler verifies a Cognito token with ${verifier}(), which reads ${COGNITO_VERIFIER_ENVIRONMENT.join(" and ")}, but its declaration does not set ${missing.join(" or ")}, so every signed-in request would fail. Add to its environment:\n${missing
        .map((name) => `  ${name}: ${EXAMPLE_VALUES[name]},`)
        .join("\n")}`,
    );
  }
}
