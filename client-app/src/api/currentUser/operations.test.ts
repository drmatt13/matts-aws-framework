import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { parse } from "graphql";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AuthServiceUnavailableError, SessionExpiredError } from "#/lib/auth";
import { executeGraphQL } from "../graphql/client";
import {
  currentUserKeys,
  currentUserQuery,
  updateCurrentUserMutation,
} from "./operations";

vi.mock("../graphql/client", () => ({ executeGraphQL: vi.fn() }));
const execute = vi.mocked(executeGraphQL);
const clients: QueryClient[] = [];
const user = {
  id: "user",
  email: "user@example.com",
  firstName: "Matt",
  lastName: "Example",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  execute.mockReset();
});

afterEach(() => {
  for (const instance of clients) instance.clear();
  clients.length = 0;
});

function client() {
  const instance = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryDelay: 0 },
      mutations: { retry: false },
    },
  });
  clients.push(instance);
  return instance;
}

it("query options select the profile and request its public fields", async () => {
  const queryClient = client();
  execute.mockResolvedValue({ currentUser: user });
  expect(await queryClient.fetchQuery(currentUserQuery)).toEqual(user);
  expect(queryClient.getQueryData(["currentUser"])).toEqual(user);

  const document = parse(String(execute.mock.calls[0][0]));
  const operation = document.definitions.find(
    (node) => node.kind === "OperationDefinition",
  );
  const field = operation?.selectionSet.selections.find(
    (node) => node.kind === "Field" && node.name.value === "currentUser",
  );
  expect(
    field?.kind === "Field"
      ? field.selectionSet?.selections.map((node) =>
          node.kind === "Field" ? node.name.value : node.kind,
        )
      : undefined,
  ).toEqual(["id", "email", "firstName", "lastName", "updatedAt"]);
});

it("does not retry an expired session", async () => {
  const error = new SessionExpiredError();
  execute.mockRejectedValue(error);
  await expect(client().fetchQuery(currentUserQuery)).rejects.toBe(error);
  expect(execute).toHaveBeenCalledTimes(1);
});

it("retries transient auth failures at most twice and preserves the error", async () => {
  const error = new AuthServiceUnavailableError();
  execute.mockRejectedValue(error);
  await expect(client().fetchQuery(currentUserQuery)).rejects.toBe(error);
  expect(execute).toHaveBeenCalledTimes(3);
});

it("can recover from a transient failure", async () => {
  execute.mockRejectedValueOnce(new Error("Network unavailable"));
  execute.mockResolvedValueOnce({ currentUser: user });
  expect(await client().fetchQuery(currentUserQuery)).toEqual(user);
  expect(execute).toHaveBeenCalledTimes(2);
});

it("allows a consumer to disable the query until it is ready", async () => {
  const queryClient = client();
  execute.mockResolvedValue({ currentUser: user });
  const observer = new QueryObserver(queryClient, {
    ...currentUserQuery,
    enabled: false,
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    expect(observer.getCurrentResult().fetchStatus).toBe("idle");
    expect(execute).not.toHaveBeenCalled();
    observer.setOptions({ ...currentUserQuery, enabled: true });
    await vi.waitFor(() => {
      expect(observer.getCurrentResult().data).toEqual(user);
    });
    expect(execute).toHaveBeenCalledTimes(1);
  } finally {
    unsubscribe();
  }
});

it("successful update sends variables and invalidates only currentUser queries", async () => {
  const queryClient = client();
  const relatedKey = [...currentUserKeys.all, "related"];
  queryClient.setQueryData(currentUserKeys.all, user);
  queryClient.setQueryData(relatedKey, user);
  queryClient.setQueryData(["projects", "list"], []);
  const updated = { ...user, firstName: "Updated" };
  const variables = { data: { firstName: "Updated", lastName: "Example" } };
  execute.mockResolvedValue({ updateCurrentUser: { user: updated } });

  expect(
    await queryClient
      .getMutationCache()
      .build(queryClient, updateCurrentUserMutation)
      .execute(variables),
  ).toEqual(updated);
  expect(execute).toHaveBeenCalledWith(expect.any(Object), variables);
  expect(queryClient.getQueryState(currentUserKeys.all)?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(relatedKey)?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(["projects", "list"])?.isInvalidated).toBe(false);
});

it("failed update preserves cached data and surfaces the error", async () => {
  const queryClient = client();
  queryClient.setQueryData(currentUserKeys.all, user);
  const error = new Error("Profile update failed");
  execute.mockRejectedValue(error);

  await expect(
    queryClient
      .getMutationCache()
      .build(queryClient, updateCurrentUserMutation)
      .execute({ data: { firstName: "Updated", lastName: "Example" } }),
  ).rejects.toBe(error);
  expect(queryClient.getQueryData(currentUserKeys.all)).toEqual(user);
  expect(queryClient.getQueryState(currentUserKeys.all)?.isInvalidated).toBe(false);
});
