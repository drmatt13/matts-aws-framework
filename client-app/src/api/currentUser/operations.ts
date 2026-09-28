import { graphql } from "#/api/generated";
import type {
  GetCurrentUserQuery,
  UpdateCurrentUserMutationVariables,
} from "#/api/generated/graphql";
import { executeGraphQL } from "#/api/graphql/client";

// The generated operation result is the frontend's type. There is no hand-written
// mirror of it: add a field to the document below and it appears here for free.
export type CurrentUser = GetCurrentUserQuery["currentUser"];
export type UpdateUserPayload = UpdateCurrentUserMutationVariables["data"];

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

// API operations consumed by hooks and other feature callers.
export async function getCurrentUser(): Promise<CurrentUser> {
  const data = await executeGraphQL(GetCurrentUserDocument);
  return data.currentUser;
}

export async function updateUser(
  payload: UpdateUserPayload,
): Promise<CurrentUser> {
  const data = await executeGraphQL(UpdateCurrentUserDocument, {
    data: payload,
  });
  return data.updateCurrentUser.user;
}
