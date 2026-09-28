import type { ProjectRecord } from "@repo/database";
import { z } from "zod";
import { builder } from "./builder";
import { invalidPayload, notFound } from "./errors";
import { requireCurrentUserId } from "../graphql-context";

const CreateProjectSchema = z
  .object({ name: z.string().trim().min(1).max(200) })
  .strict();

// Only the fields listed here reach the client. `ownerId` is deliberately
// absent: a foreign key is internal plumbing, and every row this API returns
// already belongs to the caller.
const Project = builder.objectRef<ProjectRecord>("Project").implement({
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
    archived: t.exposeBoolean("archived"),
    createdAt: t.exposeString("createdAt"),
    updatedAt: t.exposeString("updatedAt"),
  }),
});

const CreateProjectPayload = builder
  .objectRef<{ project: ProjectRecord }>("CreateProjectPayload")
  .implement({
    fields: (t) => ({
      project: t.field({
        type: Project,
        resolve: (payload) => payload.project,
      }),
    }),
  });

const SetProjectArchivedPayload = builder
  .objectRef<{ project: ProjectRecord }>("SetProjectArchivedPayload")
  .implement({
    fields: (t) => ({
      project: t.field({
        type: Project,
        resolve: (payload) => payload.project,
      }),
    }),
  });

const CreateProjectInput = builder.inputType("CreateProjectInput", {
  fields: (t) => ({ name: t.string({ required: true }) }),
});

const DeleteProjectPayload = builder
  .objectRef<{ deletedId: string }>("DeleteProjectPayload")
  .implement({
    fields: (t) => ({ deletedId: t.exposeID("deletedId") }),
  });

builder.mutationField("deleteProject", (t) =>
  t.field({
    type: DeleteProjectPayload,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_parent, args, context) => {
      // Scoped by owner in the same statement: someone else's project and a
      // project that does not exist are both NOT_FOUND.
      const deleted = await context.database.projects.deleteOwnedById(
        String(args.id),
        await requireCurrentUserId(context),
      );
      if (!deleted) {
        throw notFound("Project not found");
      }

      return { deletedId: deleted.id };
    },
  }),
);

builder.queryField("projects", (t) =>
  t.field({
    type: [Project],
    resolve: async (_parent, _args, context) =>
      context.database.projects.listByOwner(await requireCurrentUserId(context)),
  }),
);

builder.mutationField("createProject", (t) =>
  t.field({
    type: CreateProjectPayload,
    args: { data: t.arg({ type: CreateProjectInput, required: true }) },
    resolve: async (_parent, args, context) => {
      const parsed = CreateProjectSchema.safeParse(args.data);

      if (!parsed.success) {
        throw invalidPayload("Invalid project payload", parsed.error);
      }

      const ownerId = await requireCurrentUserId(context);
      const project = await context.database.projects.create({
        ownerId,
        name: parsed.data.name,
      });

      return { project };
    },
  }),
);

builder.mutationField("setProjectArchived", (t) =>
  t.field({
    type: SetProjectArchivedPayload,
    args: {
      id: t.arg.id({ required: true }),
      archived: t.arg.boolean({ required: true }),
    },
    resolve: async (_parent, args, context) => {
      const project = await context.database.projects.updateOwnedById(
        String(args.id),
        await requireCurrentUserId(context),
        { archived: args.archived },
      );

      if (!project) {
        throw notFound("Project not found");
      }

      return { project };
    },
  }),
);
