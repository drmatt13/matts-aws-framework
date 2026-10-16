import {
  formatResourceReference,
  isResourceReference,
  isSecretArnReference,
  type ResourceReference,
} from "./resources";

/**
 * The application's user pool, named once in framework.config.ts.
 *
 * Its two fields are catalog references, never literals: a pool id belongs to
 * a deployment, not to source, and a reference resolves through the same
 * machinery as every other workload input — a CDK token in AWS, the
 * development resource manifest locally. Any string reference will do, so a
 * pool built by another stack, linked with `resource.cdk<IUserPool>()`, or
 * owned by another account and read with `resource.fromEnv(...)` is named the
 * same way as the one this repository builds.
 */
export interface FrameworkUserPool {
  /** The pool's id, such as `resources.cognito.userPool.userPoolId`. Handed over as USER_POOL_ID. */
  readonly userPoolId: ResourceReference<"string">;
  /**
   * The app client its sign-ins are issued to, such as
   * `resources.cognito.userPoolClient.userPoolClientId`. Handed over as
   * USER_POOL_CLIENT_ID.
   */
  readonly userPoolClientId: ResourceReference<"string">;
}

/**
 * The environment name each field of {@link FrameworkUserPool} arrives under.
 *
 * They are the names the framework's token verifier reads — `authenticated`,
 * `authenticatedTool` and an agent's adapter all share it — and the names a
 * handler that calls Cognito itself reads too.
 */
export const USER_POOL_ENVIRONMENT = {
  userPoolId: "USER_POOL_ID",
  userPoolClientId: "USER_POOL_CLIENT_ID",
} as const satisfies Record<keyof FrameworkUserPool, string>;

/** The verifier `authenticated` and `authenticatedTool` share reads these. */
export const COGNITO_VERIFIER_ENVIRONMENT = [
  USER_POOL_ENVIRONMENT.userPoolId,
  USER_POOL_ENVIRONMENT.userPoolClientId,
] as const;

/** How framework.config.ts names the pool, quoted by every message that asks for one. */
export const USER_POOL_DECLARATION_EXAMPLE =
  "userPool: { userPoolId: resources.cognito.userPool.userPoolId, userPoolClientId: resources.cognito.userPoolClient.userPoolClientId }";
const EXAMPLE = USER_POOL_DECLARATION_EXAMPLE;

/** Refuses a `userPool` that is not two catalog string references. */
export function assertFrameworkUserPool(value: unknown): asserts value is FrameworkUserPool {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`userPool names the application's user pool, as ${EXAMPLE}.`);
  }
  for (const key of Object.keys(value)) {
    if (!(key in USER_POOL_ENVIRONMENT)) {
      throw new Error(`userPool declares unknown field "${key}". It takes userPoolId and userPoolClientId, as ${EXAMPLE}.`);
    }
  }
  for (const field of Object.keys(USER_POOL_ENVIRONMENT) as (keyof FrameworkUserPool)[]) {
    const reference = (value as Record<string, unknown>)[field];
    if (!isResourceReference(reference)) {
      throw new Error(
        reference === undefined
          ? `userPool needs ${field}, as ${EXAMPLE}.`
          : `userPool.${field} is ${typeof reference === "string" ? "a literal" : String(reference)}. Name it from the resource catalog, as ${EXAMPLE}: a pool id belongs to a deployment, not to source.`,
      );
    }
    if (reference.kind !== "string" || isSecretArnReference(reference)) {
      throw new Error(`userPool.${field} is ${formatResourceReference(reference)}, which is not a string. Name the pool's own attribute, as ${EXAMPLE}.`);
    }
  }
}

/** What decides whether a declaration is handed the user pool. */
interface UserPoolConsumer {
  readonly userPool?: unknown;
  readonly auth?: unknown;
  readonly environment?: Readonly<Record<string, unknown>>;
}

/**
 * Whether a declaration is handed the application's user pool, and why.
 *
 * - "declared": it says `userPool: true`.
 * - "implied": it is a tool or an agent with `auth: true`, which means its
 *   handler is the framework's own verifier, and it names neither variable
 *   itself. An HTTP route's or a service's `auth: true` means its gateway
 *   checks the caller, which says nothing about its handler, so it implies
 *   nothing.
 *
 * Nothing is implied when the config names no pool, or when the declaration
 * names either variable itself: that is how a workload verifies against
 * another pool, and an explicit declaration is never second-guessed.
 */
export function userPoolDelivery(
  role: string,
  declaration: UserPoolConsumer,
  userPool: FrameworkUserPool | undefined,
): "declared" | "implied" | undefined {
  if (declaration.userPool === true) return "declared";
  if (userPool === undefined || declaration.auth !== true || (role !== "tool" && role !== "agent")) return undefined;
  const declared = COGNITO_VERIFIER_ENVIRONMENT.some((name) =>
    Object.prototype.hasOwnProperty.call(declaration.environment ?? {}, name),
  );
  return declared ? undefined : "implied";
}
