import type { DatabaseClient } from "./client.js";
import type { ProjectRepository } from "./contracts.js";

/**
 * Ownership is part of every statement. An update or delete matches on id
 * *and* owner, so another user's row is indistinguishable from a missing one
 * and there is no gap between checking ownership and writing.
 */
export function createProjectRepository(
  client: DatabaseClient,
): ProjectRepository {
  const projects = client.orm.public.Project;

  return {
    listByOwner: async (ownerId) => projects.where({ ownerId }).all(),
    create: async (input) => projects.create(input),
    updateOwnedById: async (id, ownerId, input) =>
      projects.where({ id, ownerId }).update(input),
    deleteOwnedById: async (id, ownerId) =>
      projects.where({ id, ownerId }).delete(),
  };
}
