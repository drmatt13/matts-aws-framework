import type { AuthenticatedCognitoSession } from "@repo/framework/runtime/auth";
import type { Database } from "@repo/database";
import { notFound } from "./schema/errors";

export type GraphQLContext = {
  session: AuthenticatedCognitoSession;
  database: Database;
};

/**
 * One lookup per request, however many resolvers ask. Keyed by the context
 * object, which GraphQL creates once per request and discards with it.
 */
const currentUserIds = new WeakMap<GraphQLContext, Promise<string>>();

/**
 * The application user id behind this request's session.
 *
 * The session carries a Cognito sub; application rows are owned by the
 * application user's id. Every owner-scoped resolver needs the second, and a
 * request touching three root fields would otherwise look it up three times.
 * Answers NOT_FOUND when the signed-in user has no application row yet.
 */
export function requireCurrentUserId(context: GraphQLContext): Promise<string> {
  let pending = currentUserIds.get(context);
  if (!pending) {
    pending = context.database.users
      .findByCognitoSub(context.session.payload.sub)
      .then((user) => {
        if (!user) throw notFound("User not found");
        return user.id;
      });
    currentUserIds.set(context, pending);
  }
  return pending;
}
