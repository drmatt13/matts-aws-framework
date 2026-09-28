/* eslint-disable */
import * as types from './graphql';



/**
 * Map of all GraphQL operations in the project.
 *
 * This map has several performance disadvantages:
 * 1. It is not tree-shakeable, so it will include all operations in the project.
 * 2. It is not minifiable, so the string of a GraphQL query will be multiple times inside the bundle.
 * 3. It does not support dead code elimination, so it will add unused operations.
 *
 * Therefore it is highly recommended to use the babel or swc plugin for production.
 * Learn more about it here: https://the-guild.dev/graphql/codegen/plugins/presets/preset-client#reducing-bundle-size
 */
type Documents = {
    "\n  query GetCurrentUser {\n    currentUser {\n      id\n      email\n      firstName\n      lastName\n      updatedAt\n    }\n  }\n": typeof types.GetCurrentUserDocument,
    "\n  mutation UpdateCurrentUser($data: UpdateCurrentUserInput!) {\n    updateCurrentUser(data: $data) {\n      user {\n        id\n        email\n        firstName\n        lastName\n        updatedAt\n      }\n    }\n  }\n": typeof types.UpdateCurrentUserDocument,
    "\n  fragment ProjectSummary on Project {\n    id\n    name\n    archived\n    updatedAt\n  }\n": typeof types.ProjectSummaryFragmentDoc,
    "\n  query Projects {\n    projects {\n      ...ProjectSummary\n    }\n  }\n": typeof types.ProjectsDocument,
    "\n  mutation CreateProject($data: CreateProjectInput!) {\n    createProject(data: $data) {\n      project {\n        ...ProjectSummary\n      }\n    }\n  }\n": typeof types.CreateProjectDocument,
    "\n  mutation SetProjectArchived($id: ID!, $archived: Boolean!) {\n    setProjectArchived(id: $id, archived: $archived) {\n      project {\n        ...ProjectSummary\n      }\n    }\n  }\n": typeof types.SetProjectArchivedDocument,
    "\n  mutation DeleteProject($id: ID!) {\n    deleteProject(id: $id) {\n      deletedId\n    }\n  }\n": typeof types.DeleteProjectDocument,
};
const documents: Documents = {
    "\n  query GetCurrentUser {\n    currentUser {\n      id\n      email\n      firstName\n      lastName\n      updatedAt\n    }\n  }\n": types.GetCurrentUserDocument,
    "\n  mutation UpdateCurrentUser($data: UpdateCurrentUserInput!) {\n    updateCurrentUser(data: $data) {\n      user {\n        id\n        email\n        firstName\n        lastName\n        updatedAt\n      }\n    }\n  }\n": types.UpdateCurrentUserDocument,
    "\n  fragment ProjectSummary on Project {\n    id\n    name\n    archived\n    updatedAt\n  }\n": types.ProjectSummaryFragmentDoc,
    "\n  query Projects {\n    projects {\n      ...ProjectSummary\n    }\n  }\n": types.ProjectsDocument,
    "\n  mutation CreateProject($data: CreateProjectInput!) {\n    createProject(data: $data) {\n      project {\n        ...ProjectSummary\n      }\n    }\n  }\n": types.CreateProjectDocument,
    "\n  mutation SetProjectArchived($id: ID!, $archived: Boolean!) {\n    setProjectArchived(id: $id, archived: $archived) {\n      project {\n        ...ProjectSummary\n      }\n    }\n  }\n": types.SetProjectArchivedDocument,
    "\n  mutation DeleteProject($id: ID!) {\n    deleteProject(id: $id) {\n      deletedId\n    }\n  }\n": types.DeleteProjectDocument,
};

/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query GetCurrentUser {\n    currentUser {\n      id\n      email\n      firstName\n      lastName\n      updatedAt\n    }\n  }\n"): typeof import('./graphql').GetCurrentUserDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation UpdateCurrentUser($data: UpdateCurrentUserInput!) {\n    updateCurrentUser(data: $data) {\n      user {\n        id\n        email\n        firstName\n        lastName\n        updatedAt\n      }\n    }\n  }\n"): typeof import('./graphql').UpdateCurrentUserDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  fragment ProjectSummary on Project {\n    id\n    name\n    archived\n    updatedAt\n  }\n"): typeof import('./graphql').ProjectSummaryFragmentDoc;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query Projects {\n    projects {\n      ...ProjectSummary\n    }\n  }\n"): typeof import('./graphql').ProjectsDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation CreateProject($data: CreateProjectInput!) {\n    createProject(data: $data) {\n      project {\n        ...ProjectSummary\n      }\n    }\n  }\n"): typeof import('./graphql').CreateProjectDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation SetProjectArchived($id: ID!, $archived: Boolean!) {\n    setProjectArchived(id: $id, archived: $archived) {\n      project {\n        ...ProjectSummary\n      }\n    }\n  }\n"): typeof import('./graphql').SetProjectArchivedDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation DeleteProject($id: ID!) {\n    deleteProject(id: $id) {\n      deletedId\n    }\n  }\n"): typeof import('./graphql').DeleteProjectDocument;


export function graphql(source: string) {
  return (documents as any)[source] ?? {};
}
