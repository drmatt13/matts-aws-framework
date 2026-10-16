import ts from "typescript";
import {
  COGNITO_VERIFIER_ENVIRONMENT,
  getFrameworkTargets,
  isNodeLambdaRuntime,
  resolveLambdaTarget,
  USER_POOL_DECLARATION_EXAMPLE,
  type FrameworkConfig,
} from "../src/config/index";

/**
 * A Lambda whose handler verifies a Cognito token declares the pool it verifies
 * against.
 *
 * The verifier behind `authenticated()` reads USER_POOL_ID and
 * USER_POOL_CLIENT_ID, which the declaration supplies with `userPool: true`
 * (or by naming both itself). Without them the route type-checks, generates
 * and starts, then answers its first signed-in request with a 500. Tools and
 * agents are checked from their `auth: true` (see validateAgentCoreConfig); a
 * Lambda is checked from its handler instead, because an `auth: true` route
 * may rely on the gateway's authorizer alone, and a handler may verify a token
 * on a route without one.
 *
 * Read as a syntax tree, not as text: only a verifier imported from the
 * framework and then called counts, so a comment, a string or a function of
 * the same name never does, and an aliased or namespace import still does.
 * Only a zip Node Lambda is read, whose index.ts is certainly its entry point.
 */

const VERIFIER_MODULE = "@repo/framework/runtime/auth";
const VERIFIERS: ReadonlySet<string> = new Set([
  "authenticated",
  "getAuthenticatedSession",
  "getAuthenticatedUser",
  "getAuthenticatedSub",
  "getAuthenticatedHttpSession",
  "verifyCognitoIdToken",
]);

/** The verifier a module imports from the framework and calls, by its exported name. */
export function calledVerifier(source: string): string | undefined {
  const file = ts.createSourceFile("index.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const named = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== VERIFIER_MODULE || statement.importClause?.isTypeOnly) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const exported = (element.propertyName ?? element.name).text;
        if (!element.isTypeOnly && VERIFIERS.has(exported)) named.set(element.name.text, exported);
      }
    }
  }
  if (named.size === 0 && namespaces.size === 0) return undefined;
  let found: string | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) found = named.get(callee.text);
      else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && namespaces.has(callee.expression.text) && VERIFIERS.has(callee.name.text)) {
        found = callee.name.text;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** `read(reference)` is the entry module's source, or undefined when there is none. */
export function assertCognitoVerifierInputs(
  config: FrameworkConfig,
  read: (reference: string) => string | undefined,
): void {
  for (const target of getFrameworkTargets(config)) {
    if (target.kind !== "lambda") continue;
    const spec = resolveLambdaTarget(config, target.id);
    if (spec.packaging !== "zip" || !isNodeLambdaRuntime(spec.runtime)) continue;
    const source = read(target.reference);
    const verifier = source === undefined ? undefined : calledVerifier(source);
    if (verifier === undefined) continue;
    const missing = COGNITO_VERIFIER_ENVIRONMENT.filter((name) => target.environment[name] === undefined);
    if (missing.length === 0) continue;
    const origin = target.origins[0] ?? target.reference;
    const verifies = `${origin}'s handler verifies a Cognito token with ${verifier}(), which reads ${COGNITO_VERIFIER_ENVIRONMENT.join(" and ")}`;
    // One of the two named by hand is a workload choosing its own pool.
    if (missing.length < COGNITO_VERIFIER_ENVIRONMENT.length) {
      throw new Error(`${verifies}, but its environment names only one of them. Declare ${missing.join(" and ")} as well, or neither and add userPool: true.`);
    }
    throw new Error(
      config.userPool === undefined
        ? `${verifies}, and is handed neither, so every signed-in request would fail. Name the application's pool once in framework.config.ts, as ${USER_POOL_DECLARATION_EXAMPLE}, then add userPool: true to this declaration.`
        : `${verifies}, and is handed neither, so every signed-in request would fail. Add userPool: true to this declaration.`,
    );
  }
}
