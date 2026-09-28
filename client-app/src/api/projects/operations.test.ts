import { QueryClient } from "@tanstack/react-query";
import { parse } from "graphql";
import { beforeEach, expect, it, vi } from "vitest";
import { executeGraphQL } from "../graphql/client";
import {
  createProjectMutation,
  deleteProjectMutation,
  projectsQuery,
  setProjectArchivedMutation,
} from "./operations";

vi.mock("../graphql/client", () => ({ executeGraphQL: vi.fn() }));
const execute = vi.mocked(executeGraphQL);
beforeEach(() => {
  execute.mockReset();
});

function client() {
  const instance = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  instance.setQueryData(projectsQuery.queryKey, []);
  instance.setQueryData(["currentUser"], { id: "user" });
  return instance;
}

it("query options select the projects result", async () => {
  const queryClient = client();
  execute.mockResolvedValue({ projects: [{ id: "one" }] });
  expect(await queryClient.fetchQuery(projectsQuery)).toEqual([{ id: "one" }]);
  // Documents are typed strings; parse one to inspect what it selects.
  const document = parse(String(execute.mock.calls[0][0]));
  const fragment = document.definitions.find(
    (node) => node.kind === "FragmentDefinition",
  );
  expect(fragment?.name.value).toBe("ProjectSummary");
  expect(
    fragment?.selectionSet.selections.map((node) =>
      node.kind === "Field" ? node.name.value : node.kind,
    ),
  ).toEqual(["id", "name", "archived", "updatedAt"]);
  queryClient.clear();
});

it("successful create invalidates projects without invalidating unrelated data", async () => {
  const queryClient = client();
  const project = { id: "one" };
  execute.mockResolvedValue({ createProject: { project } });
  expect(
    await queryClient
      .getMutationCache()
      .build(queryClient, createProjectMutation)
      .execute({ data: { name: "New" } }),
  ).toEqual(project);
  expect(queryClient.getQueryState(projectsQuery.queryKey)?.isInvalidated).toBe(
    true,
  );
  expect(queryClient.getQueryState(["currentUser"])?.isInvalidated).toBe(false);
  queryClient.clear();
});

it("successful archive invalidates projects", async () => {
  const queryClient = client();
  execute.mockResolvedValue({
    setProjectArchived: { project: { id: "one", archived: true } },
  });
  await queryClient
    .getMutationCache()
    .build(queryClient, setProjectArchivedMutation)
    .execute({ id: "one", archived: true });
  expect(queryClient.getQueryState(projectsQuery.queryKey)?.isInvalidated).toBe(
    true,
  );
  queryClient.clear();
});

it("failed mutation leaves cached data fresh", async () => {
  const queryClient = client();
  execute.mockRejectedValue(new Error("Forbidden"));
  await expect(
    queryClient
      .getMutationCache()
      .build(queryClient, setProjectArchivedMutation)
      .execute({ id: "one", archived: true }),
  ).rejects.toThrow("Forbidden");
  expect(queryClient.getQueryState(projectsQuery.queryKey)?.isInvalidated).toBe(
    false,
  );
  queryClient.clear();
});

it("successful delete sends the id and invalidates only projects", async () => {
  const queryClient = client();
  execute.mockResolvedValue({ deleteProject: { deletedId: "one" } });
  expect(
    await queryClient
      .getMutationCache()
      .build(queryClient, deleteProjectMutation)
      .execute({ id: "one" }),
  ).toBe("one");
  expect(execute).toHaveBeenCalledWith(expect.any(Object), { id: "one" });
  expect(queryClient.getQueryState(projectsQuery.queryKey)?.isInvalidated).toBe(
    true,
  );
  expect(queryClient.getQueryState(["currentUser"])?.isInvalidated).toBe(false);
  queryClient.clear();
});

it("failed delete preserves the project list and surfaces the error", async () => {
  const queryClient = client();
  const projects = [
    {
      id: "one",
      name: "Example",
      archived: false,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  queryClient.setQueryData(projectsQuery.queryKey, projects);
  const error = new Error("Forbidden");
  execute.mockRejectedValue(error);
  await expect(
    queryClient
      .getMutationCache()
      .build(queryClient, deleteProjectMutation)
      .execute({ id: "one" }),
  ).rejects.toBe(error);
  expect(queryClient.getQueryData(projectsQuery.queryKey)).toEqual(projects);
  expect(queryClient.getQueryState(projectsQuery.queryKey)?.isInvalidated).toBe(
    false,
  );
  queryClient.clear();
});
