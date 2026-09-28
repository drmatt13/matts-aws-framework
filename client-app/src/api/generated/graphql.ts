/* eslint-disable */
/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
import type { DocumentTypeDecoration } from '@graphql-typed-document-node/core';
export type CreateProjectInput = {
  name: string;
};

export type UpdateCurrentUserInput = {
  firstName?: string | null | undefined;
  lastName?: string | null | undefined;
};

export type GetCurrentUserQueryVariables = Exact<{ [key: string]: never; }>;


export type GetCurrentUserQuery = { currentUser: { id: string, email: string, firstName: string, lastName: string, updatedAt: string } };

export type UpdateCurrentUserMutationVariables = Exact<{
  data: UpdateCurrentUserInput;
}>;


export type UpdateCurrentUserMutation = { updateCurrentUser: { user: { id: string, email: string, firstName: string, lastName: string, updatedAt: string } } };

export type ProjectSummaryFragment = { id: string, name: string, archived: boolean, updatedAt: string };

export type ProjectsQueryVariables = Exact<{ [key: string]: never; }>;


export type ProjectsQuery = { projects: Array<{ id: string, name: string, archived: boolean, updatedAt: string }> };

export type CreateProjectMutationVariables = Exact<{
  data: CreateProjectInput;
}>;


export type CreateProjectMutation = { createProject: { project: { id: string, name: string, archived: boolean, updatedAt: string } } };

export type SetProjectArchivedMutationVariables = Exact<{
  id: string | number;
  archived: boolean;
}>;


export type SetProjectArchivedMutation = { setProjectArchived: { project: { id: string, name: string, archived: boolean, updatedAt: string } } };

export type DeleteProjectMutationVariables = Exact<{
  id: string | number;
}>;


export type DeleteProjectMutation = { deleteProject: { deletedId: string } };

export class TypedDocumentString<TResult, TVariables>
  extends String
  implements DocumentTypeDecoration<TResult, TVariables>
{
  __apiType?: NonNullable<DocumentTypeDecoration<TResult, TVariables>['__apiType']>;
  private value: string;
  public __meta__?: Record<string, any> | undefined;

  constructor(value: string, __meta__?: Record<string, any> | undefined) {
    super(value);
    this.value = value;
    this.__meta__ = __meta__;
  }

  override toString(): string & DocumentTypeDecoration<TResult, TVariables> {
    return this.value;
  }
}
export const ProjectSummaryFragmentDoc = new TypedDocumentString(`
    fragment ProjectSummary on Project {
  id
  name
  archived
  updatedAt
}
    `, {"fragmentName":"ProjectSummary"}) as unknown as TypedDocumentString<ProjectSummaryFragment, unknown>;
export const GetCurrentUserDocument = new TypedDocumentString(`
    query GetCurrentUser {
  currentUser {
    id
    email
    firstName
    lastName
    updatedAt
  }
}
    `, {"hash":"sha256:af8e1ae51013b0447b2f85c0f7c70ef04b729d14f06917c0ce7a147162eabbfb"}) as unknown as TypedDocumentString<GetCurrentUserQuery, GetCurrentUserQueryVariables>;
export const UpdateCurrentUserDocument = new TypedDocumentString(`
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
    `, {"hash":"sha256:40d716b767bb51cf495181bd9f0c8d2287e91d02b3ebaebe05267fa8726788c3"}) as unknown as TypedDocumentString<UpdateCurrentUserMutation, UpdateCurrentUserMutationVariables>;
export const ProjectsDocument = new TypedDocumentString(`
    query Projects {
  projects {
    ...ProjectSummary
  }
}
    fragment ProjectSummary on Project {
  id
  name
  archived
  updatedAt
}`, {"hash":"sha256:6a5f0d618d672c4aad9a4d132dfb290ba306800d6235aa57d0240d139fd5f057"}) as unknown as TypedDocumentString<ProjectsQuery, ProjectsQueryVariables>;
export const CreateProjectDocument = new TypedDocumentString(`
    mutation CreateProject($data: CreateProjectInput!) {
  createProject(data: $data) {
    project {
      ...ProjectSummary
    }
  }
}
    fragment ProjectSummary on Project {
  id
  name
  archived
  updatedAt
}`, {"hash":"sha256:43d2ed07aa2dbad1dd304b7842a3c7fc1bf5ee2009aad45cff3b3e0f988218eb"}) as unknown as TypedDocumentString<CreateProjectMutation, CreateProjectMutationVariables>;
export const SetProjectArchivedDocument = new TypedDocumentString(`
    mutation SetProjectArchived($id: ID!, $archived: Boolean!) {
  setProjectArchived(id: $id, archived: $archived) {
    project {
      ...ProjectSummary
    }
  }
}
    fragment ProjectSummary on Project {
  id
  name
  archived
  updatedAt
}`, {"hash":"sha256:ecacab456f70095a6e0d557772dfb7a58491d44523a104f6ca513e53b781d78a"}) as unknown as TypedDocumentString<SetProjectArchivedMutation, SetProjectArchivedMutationVariables>;
export const DeleteProjectDocument = new TypedDocumentString(`
    mutation DeleteProject($id: ID!) {
  deleteProject(id: $id) {
    deletedId
  }
}
    `, {"hash":"sha256:3f94ccdab2a1444ca2384d1deb0ee0260593841e91548ddbaad54b8e843d8540"}) as unknown as TypedDocumentString<DeleteProjectMutation, DeleteProjectMutationVariables>;