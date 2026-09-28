import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import {
  createProjectMutation,
  deleteProjectMutation,
  projectsQuery,
  setProjectArchivedMutation,
} from "#/api/projects/operations";
import { GraphQLRequestError } from "#/api/graphql/client";
import Button from "#/components/Button";

/**
 * The `Project` table, end to end: list query, create mutation, and an
 * owner-scoped update and deletion. This is the worked example
 * `docs/DATA-FEATURES.md` describes, kept as real code so the
 * documentation cannot drift from it.
 *
 * Unlike the rest of this page it owns its own loading and error states: it is
 * not part of the layout route's guarantee, so a failure here should degrade to
 * a message rather than take the page down.
 */
function errorMessage(error: unknown): string {
  // The resolver's `extensions.code` survives the transport, so the UI can say
  // something specific instead of echoing a raw server string.
  if (error instanceof GraphQLRequestError) {
    switch (error.code) {
      case "NOT_FOUND":
        return "That project no longer exists.";
      case "BAD_USER_INPUT":
        return error.message;
      default:
        break;
    }
  }

  return error instanceof Error ? error.message : "Something went wrong.";
}

export default function ProjectsPanel() {
  const [name, setName] = useState("");

  const projects = useQuery(projectsQuery);
  const createProject = useMutation(createProjectMutation);
  const setArchived = useMutation(setProjectArchivedMutation);
  const deleteProject = useMutation(deleteProjectMutation);

  const failure =
    projects.error ??
    createProject.error ??
    setArchived.error ??
    deleteProject.error;

  function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed || createProject.isPending) return;

    createProject.mutate(
      { data: { name: trimmed } },
      { onSuccess: () => setName("") },
    );
  }

  return (
    <section className="card mt-4">
      <h2 className="text-sm font-semibold">Projects</h2>
      <p className="mt-1.5 text-sm text-muted">
        A second table wired all the way through: Prisma contract, repository,
        GraphQL schema, generated types, and React Query.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          className="min-w-48 flex-1 rounded-lg bg-ink/5 px-3 py-2 text-sm"
          placeholder="New project name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") handleCreate();
          }}
        />
        <Button
          text={createProject.isPending ? "Creating..." : "Create"}
          icon="plus"
          onClick={handleCreate}
          disabled={createProject.isPending || name.trim().length === 0}
        />
      </div>

      {failure ? (
        <p className="mt-4 text-sm text-red-600">{errorMessage(failure)}</p>
      ) : null}

      {projects.isPending ? (
        <p className="mt-4 text-sm text-muted">Loading projects...</p>
      ) : null}

      {projects.data?.length === 0 ? (
        <p className="mt-4 text-sm text-muted">No projects yet.</p>
      ) : null}

      <ul className="mt-4 space-y-2">
        {projects.data?.map((project) => (
          <li
            key={project.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-ink/5 px-3 py-2"
          >
            <span
              className={`text-sm ${project.archived ? "text-muted line-through" : ""}`}
            >
              {project.name}
            </span>
            <div className="flex items-center gap-2">
              <Button
                text={project.archived ? "Unarchive" : "Archive"}
                style="secondary"
                onClick={() =>
                  setArchived.mutate({
                    id: project.id,
                    archived: !project.archived,
                  })
                }
                disabled={setArchived.isPending || deleteProject.isPending}
              />
              <Button
                text={
                  deleteProject.isPending &&
                  deleteProject.variables?.id === project.id
                    ? "Deleting..."
                    : "Delete"
                }
                style="secondary"
                onClick={() => deleteProject.mutate({ id: project.id })}
                disabled={deleteProject.isPending || setArchived.isPending}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
