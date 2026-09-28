import { GraphQLError } from "graphql";
import type { ZodError } from "zod";

export function badUserInput(message: string): GraphQLError {
  return new GraphQLError(message, {
    extensions: {
      code: "BAD_USER_INPUT",
    },
  });
}

/**
 * Appends the first Zod issue to a BAD_USER_INPUT message so a rejected payload
 * names the field that failed instead of only the operation that failed. The
 * payload is the caller's own input, so this leaks nothing internal.
 */
export function invalidPayload(message: string, error: ZodError): GraphQLError {
  const issue = error.issues[0];

  if (!issue) {
    return badUserInput(message);
  }

  const path = issue.path.join(".");

  return badUserInput(
    path
      ? `${message} — ${path}: ${issue.message}`
      : `${message} — ${issue.message}`,
  );
}

export function notFound(message: string): GraphQLError {
  return new GraphQLError(message, {
    extensions: {
      code: "NOT_FOUND",
    },
  });
}

/**
 * The ownership/authorization failure code. Kept alongside the others so the
 * standard set is complete the moment a resolver guards a record it does not own.
 */
export function forbidden(message: string): GraphQLError {
  return new GraphQLError(message, {
    extensions: {
      code: "FORBIDDEN",
    },
  });
}
