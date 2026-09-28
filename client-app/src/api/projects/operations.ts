import { mutationOptions, queryOptions } from "@tanstack/react-query";
import type { VariablesOf } from "@graphql-typed-document-node/core";
import { graphql } from "#/api/generated";
import { executeGraphQL } from "#/api/graphql/client";

graphql(`
  fragment ProjectSummary on Project {
    id
    name
    archived
    updatedAt
  }
`);

const ProjectsDocument = graphql(`
  query Projects {
    projects {
      ...ProjectSummary
    }
  }
`);

const CreateProjectDocument = graphql(`
  mutation CreateProject($data: CreateProjectInput!) {
    createProject(data: $data) {
      project {
        ...ProjectSummary
      }
    }
  }
`);

const SetProjectArchivedDocument = graphql(`
  mutation SetProjectArchived($id: ID!, $archived: Boolean!) {
    setProjectArchived(id: $id, archived: $archived) {
      project {
        ...ProjectSummary
      }
    }
  }
`);

/**
 * Every query this feature caches lives under one prefix, so a mutation
 * invalidates all of them — the list today, a detail query tomorrow — with
 * one call and nothing to remember.
 */
export const projectKeys = {
  all: ["projects"] as const,
  list: () => [...projectKeys.all, "list"] as const,
};

export const projectsQuery = queryOptions({
  queryKey: projectKeys.list(),
  queryFn: async () => (await executeGraphQL(ProjectsDocument)).projects,
});

const DeleteProjectDocument = graphql(`
  mutation DeleteProject($id: ID!) {
    deleteProject(id: $id) {
      deletedId
    }
  }
`);

export const deleteProjectMutation = mutationOptions({
  mutationFn: async (variables: VariablesOf<typeof DeleteProjectDocument>) =>
    (await executeGraphQL(DeleteProjectDocument, variables)).deleteProject
      .deletedId,
  onSuccess: (_data, _variables, _result, { client }) =>
    client.invalidateQueries({ queryKey: projectKeys.all }),
});

export const createProjectMutation = mutationOptions({
  mutationFn: async (variables: VariablesOf<typeof CreateProjectDocument>) =>
    (await executeGraphQL(CreateProjectDocument, variables)).createProject
      .project,
  onSuccess: (_data, _variables, _result, { client }) =>
    client.invalidateQueries({ queryKey: projectKeys.all }),
});

export const setProjectArchivedMutation = mutationOptions({
  mutationFn: async (
    variables: VariablesOf<typeof SetProjectArchivedDocument>,
  ) =>
    (await executeGraphQL(SetProjectArchivedDocument, variables))
      .setProjectArchived.project,
  onSuccess: (_data, _variables, _result, { client }) =>
    client.invalidateQueries({ queryKey: projectKeys.all }),
});
