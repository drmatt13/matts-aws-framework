import { mutationOptions, queryOptions } from "@tanstack/react-query";
import type { VariablesOf } from "@graphql-typed-document-node/core";
import { graphql } from "#/api/generated";
import { executeGraphQL } from "#/api/graphql/client";
import { isSessionExpiredError } from "#/lib/auth";

// Typed GraphQL documents for this feature's operations.
const GetCurrentUserDocument = graphql(`
  query GetCurrentUser {
    currentUser {
      id
      email
      firstName
      lastName
      updatedAt
    }
  }
`);

const UpdateCurrentUserDocument = graphql(`
  mutation UpdateCurrentUser($data: UpdateCurrentUserInput!) {
    updateCurrentUser(data: $data) {
      user {
        id
        email
        firstName
        lastName
        updatedAt
      }
    }
  }
`);

// This singleton keeps its existing cache key; all consumers share one profile.
export const currentUserKeys = {
  all: ["currentUser"] as const,
};

export const currentUserQuery = queryOptions({
  queryKey: currentUserKeys.all,
  queryFn: async () => (await executeGraphQL(GetCurrentUserDocument)).currentUser,
  retry: (failureCount, error) =>
    !isSessionExpiredError(error) && failureCount < 2,
});

export const updateCurrentUserMutation = mutationOptions({
  mutationFn: async (variables: VariablesOf<typeof UpdateCurrentUserDocument>) =>
    (await executeGraphQL(UpdateCurrentUserDocument, variables)).updateCurrentUser
      .user,
  onSuccess: (_data, _variables, _result, { client }) =>
    client.invalidateQueries({ queryKey: currentUserKeys.all }),
});
