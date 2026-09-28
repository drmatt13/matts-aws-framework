import type { DocumentTypeDecoration } from "@graphql-typed-document-node/core";
import { API_ROUTE } from "@repo/api-contract";
import { FrameworkHttpApiFetch } from "#/lib/auth";

/**
 * A document codegen generated: a typed string, carrying the hash the
 * persisted-document manifest lists it under.
 */
type GraphQLDocument<TData, TVariables> = DocumentTypeDecoration<TData, TVariables> &
  String & { readonly __meta__?: { readonly hash?: string } };

/**
 * The manifest names documents `sha256:<hex>`; the request carries the bare
 * hex in the standard persisted-query extension. A server enforcing persisted
 * documents executes the manifest's copy and ignores the text; one that is not
 * enforcing ignores the extension.
 */
function persistedQueryExtension(hash: string | undefined) {
  const hex = hash?.startsWith("sha256:") ? hash.slice("sha256:".length) : undefined;
  return hex
    ? { extensions: { persistedQuery: { version: 1, sha256Hash: hex } } }
    : {};
}

/** The codes `schema/errors.ts` puts on `extensions.code`. */
export type GraphQLErrorCode =
  | "BAD_USER_INPUT"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INTERNAL_SERVER_ERROR";

type GraphQLResponseError = {
  message?: string;
  path?: ReadonlyArray<string | number>;
  extensions?: { code?: string };
};

type GraphQLResponse<TData> = {
  data?: TData;
  errors?: GraphQLResponseError[];
};

/**
 * Carries the resolver's own `extensions.code` to the caller.
 *
 * Without this the UI cannot tell "you may not read this" from "this is gone"
 * from "your input was rejected" — they all arrive as the same bare string, and
 * the codes the schema takes care to set are lost at the transport boundary.
 */
export class GraphQLRequestError extends Error {
  readonly code: GraphQLErrorCode | undefined;
  readonly status: number;
  readonly path: ReadonlyArray<string | number> | undefined;
  /** Every error the response carried, not only the first. */
  readonly errors: ReadonlyArray<GraphQLResponseError>;

  constructor(
    message: string,
    options: {
      status: number;
      code?: string;
      path?: ReadonlyArray<string | number>;
      errors?: ReadonlyArray<GraphQLResponseError>;
    },
  ) {
    super(message);
    this.name = "GraphQLRequestError";
    this.status = options.status;
    this.code = options.code as GraphQLErrorCode | undefined;
    this.path = options.path;
    this.errors = options.errors ?? [];
  }
}

export function isGraphQLErrorCode(
  error: unknown,
  code: GraphQLErrorCode,
): boolean {
  return error instanceof GraphQLRequestError && error.code === code;
}

function toRequestError(
  status: number,
  errors: ReadonlyArray<GraphQLResponseError>,
  fallback: string,
): GraphQLRequestError {
  const first = errors[0];

  return new GraphQLRequestError(first?.message ?? fallback, {
    status,
    code: first?.extensions?.code,
    path: first?.path,
    errors,
  });
}

export async function executeGraphQL<TData, TVariables>(
  document: GraphQLDocument<TData, TVariables>,
  ...[variables]: {} extends TVariables
    ? [variables?: NoInfer<TVariables>]
    : [variables: NoInfer<TVariables>]
): Promise<TData> {
  const res = await FrameworkHttpApiFetch(API_ROUTE["/graphql"], {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: document.toString(),
      variables,
      ...persistedQueryExtension(document.__meta__?.hash),
    }),
  });

  // Read the body before branching on status: a GraphQL error response is
  // often a non-2xx that still carries the errors array worth reporting.
  const result = (await res
    .json()
    .catch(() => null)) as GraphQLResponse<TData> | null;

  if (result?.errors?.length) {
    throw toRequestError(
      res.status,
      result.errors,
      "GraphQL request returned an error",
    );
  }

  if (!res.ok) {
    throw new GraphQLRequestError(`GraphQL request failed: ${res.status}`, {
      status: res.status,
    });
  }

  if (!result?.data) {
    throw new GraphQLRequestError("GraphQL request did not return data", {
      status: res.status,
    });
  }

  return result.data;
}
