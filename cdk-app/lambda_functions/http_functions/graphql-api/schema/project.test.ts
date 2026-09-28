import assert from "node:assert/strict";
import { test } from "node:test";
import { graphql } from "graphql";
import type { ProjectRecord, ProjectRepository } from "@repo/database";
import type { GraphQLContext } from "../graphql-context";
import { schema } from "./index";

const project: ProjectRecord = {
  id: "project-1",
  ownerId: "user-1",
  name: "Example",
  archived: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const archive = `mutation($id: ID!, $archived: Boolean!) {
  setProjectArchived(id: $id, archived: $archived) { project { id archived } }
}`;
const create = `mutation($data: CreateProjectInput!) {
  createProject(data: $data) { project { id name } }
}`;
const remove = `mutation($id: ID!) {
  deleteProject(id: $id) { deletedId }
}`;

function fixture(
  options: {
    /** Who owns the stored row. The session user is always "user-1". */
    owner?: string;
    missing?: boolean;
    missingUser?: boolean;
  } = {},
) {
  const calls: Array<{ method: string; value: unknown }> = [];
  // Behaves like the owner-scoped statement: a row matches only when it exists
  // and its owner is the one the resolver passed.
  const owned = (id: string, ownerId: string) =>
    !options.missing &&
    id === project.id &&
    ownerId === (options.owner ?? project.ownerId);
  const projects: ProjectRepository = {
    listByOwner: async (ownerId) => {
      calls.push({ method: "list", value: ownerId });
      return [project];
    },
    create: async (input) => {
      calls.push({ method: "create", value: input });
      return { ...project, ...input };
    },
    updateOwnedById: async (id, ownerId, input) => {
      calls.push({ method: "update", value: { id, ownerId, ...input } });
      return owned(id, ownerId) ? { ...project, ...input } : null;
    },
    deleteOwnedById: async (id, ownerId) => {
      calls.push({ method: "delete", value: { id, ownerId } });
      return owned(id, ownerId) ? project : null;
    },
  };
  // Only these repository methods are used by this schema's Project resolvers.
  const contextValue = {
    session: { payload: { sub: "subject-1" } },
    database: {
      users: {
        findByCognitoSub: async (sub: string) => {
          calls.push({ method: "user", value: sub });
          return options.missingUser ? null : { id: "user-1" };
        },
      },
      projects,
    },
  } as unknown as GraphQLContext;
  return {
    calls,
    writes: () => calls.filter((call) => call.method !== "user"),
    run: (source: string, variableValues?: Record<string, unknown>) =>
      graphql({ schema, source, variableValues, contextValue }),
  };
}

test("projects lists only the session user's records and withholds internal fields", async () => {
  const { run, calls } = fixture();
  const result = await run(
    "{ projects { id name archived createdAt updatedAt } }",
  );
  assert.equal(result.errors, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(result.data)), {
    projects: [
      {
        id: project.id,
        name: project.name,
        archived: project.archived,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      },
    ],
  });
  assert.deepEqual(
    calls.filter((call) => call.method === "list"),
    [{ method: "list", value: "user-1" }],
  );
  assert.equal(schema.getTypeMap().Project.toString(), "Project");
  const rejected = await run("{ projects { ownerId } }");
  assert.match(rejected.errors![0].message, /Cannot query field "ownerId"/);
});

test("create trims input and takes ownership from the session", async () => {
  const { run, writes } = fixture();
  const result = await run(create, { data: { name: "  New project  " } });
  assert.equal(result.errors, undefined);
  assert.deepEqual(writes(), [
    { method: "create", value: { name: "New project", ownerId: "user-1" } },
  ]);
  assert.ok(
    (await run(create, { data: { name: "New", ownerId: "other" } })).errors,
  );
  assert.equal(writes().length, 1);
});

test("invalid project names never reach persistence", async () => {
  const { run, writes } = fixture();
  for (const name of [" ", "x".repeat(201)]) {
    const result = await run(create, { data: { name } });
    assert.equal(result.errors![0].extensions.code, "BAD_USER_INPUT");
  }
  assert.deepEqual(writes(), []);
});

test("archive updates an owned record, scoped to the session user", async () => {
  const { run, writes } = fixture();
  assert.equal(
    (await run(archive, { id: project.id, archived: true })).errors,
    undefined,
  );
  assert.deepEqual(writes(), [
    {
      method: "update",
      value: { id: project.id, ownerId: "user-1", archived: true },
    },
  ]);
});

test("another owner's record is indistinguishable from a missing one", async () => {
  for (const options of [{ owner: "other-user" }, { missing: true }]) {
    for (const [source, variables] of [
      [archive, { id: project.id, archived: true }],
      [remove, { id: project.id }],
    ] as const) {
      const { run } = fixture(options);
      const result = await run(source, variables);
      assert.equal(result.errors![0].extensions.code, "NOT_FOUND");
    }
  }
});

test("a missing application user returns NOT_FOUND without writing", async () => {
  for (const source of [archive, remove]) {
    const { run, writes } = fixture({ missingUser: true });
    const result = await run(source, { id: project.id, archived: true });
    assert.equal(result.errors![0].extensions.code, "NOT_FOUND");
    assert.deepEqual(writes(), []);
  }
});

test("delete removes an owned project and returns its id", async () => {
  const { run, writes } = fixture();
  const result = await run(remove, { id: project.id });
  assert.equal(result.errors, undefined);
  assert.equal(
    (result.data?.deleteProject as { deletedId: string }).deletedId,
    project.id,
  );
  assert.deepEqual(writes(), [
    { method: "delete", value: { id: project.id, ownerId: "user-1" } },
  ]);
});

test("the application user is looked up once per request", async () => {
  const { run, calls } = fixture();
  const result = await run(`{ first: projects { id } second: projects { id } }`);
  assert.equal(result.errors, undefined);
  assert.equal(calls.filter((call) => call.method === "user").length, 1);
});

test("delete requires an id before reaching persistence", async () => {
  const { run, writes } = fixture();
  assert.ok((await run(remove)).errors);
  assert.deepEqual(writes(), []);
});
