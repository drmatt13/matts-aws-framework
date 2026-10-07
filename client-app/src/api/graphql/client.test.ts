import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProjectsDocument,
  SetProjectArchivedDocument,
} from "../generated/graphql";
import { executeGraphQL, GraphQLRequestError } from "./client";

const { fetchApi } = vi.hoisted(() => ({ fetchApi: vi.fn() }));
vi.mock("#/lib/auth", () => ({ frameworkHttpApiFetch: fetchApi }));

beforeEach(() => {
  fetchApi.mockReset();
});

describe("GraphQL transport", () => {
  it("sends document variables and returns typed data", async () => {
    const data = {
      setProjectArchived: { project: { id: "one", archived: true } },
    };
    fetchApi.mockResolvedValue(Response.json({ data }));
    expect(
      await executeGraphQL(SetProjectArchivedDocument, {
        id: "one",
        archived: true,
      }),
    ).toEqual(data);
    const [route, request] = fetchApi.mock.calls[0];
    expect(route).toBe("/graphql");
    expect(JSON.parse(request.body).variables).toEqual({
      id: "one",
      archived: true,
    });
  });

  it.each([200, 400, 403])(
    "preserves every error and the first code/path at HTTP %i",
    async (status) => {
      const errors = [
        {
          message: "Not yours",
          extensions: { code: "FORBIDDEN" },
          path: ["projects", 0],
        },
        { message: "Gone", extensions: { code: "NOT_FOUND" } },
      ];
      fetchApi.mockResolvedValue(Response.json({ errors }, { status }));
      await expect(executeGraphQL(ProjectsDocument)).rejects.toMatchObject({
        name: "GraphQLRequestError",
        code: "FORBIDDEN",
        path: ["projects", 0],
        status,
        errors,
      });
    },
  );

  it.each(["NOT_FOUND", "BAD_USER_INPUT"])("preserves %s", async (code) => {
    fetchApi.mockResolvedValue(
      Response.json({
        errors: [{ message: "Rejected", extensions: { code } }],
      }),
    );
    await expect(executeGraphQL(ProjectsDocument)).rejects.toMatchObject({
      code,
    });
  });

  it("rejects partial data when the response includes errors", async () => {
    fetchApi.mockResolvedValue(
      Response.json({
        data: { projects: [] },
        errors: [{ message: "Partial" }],
      }),
    );
    await expect(executeGraphQL(ProjectsDocument)).rejects.toBeInstanceOf(
      GraphQLRequestError,
    );
  });

  it.each([200, 502])(
    "reports non-JSON responses at HTTP %i",
    async (status) => {
      fetchApi.mockResolvedValue(new Response("not JSON", { status }));
      await expect(executeGraphQL(ProjectsDocument)).rejects.toMatchObject({
        name: "GraphQLRequestError",
        status,
      });
    },
  );

  it("preserves authentication/network exceptions", async () => {
    const failure = new Error("Authentication temporarily unavailable");
    fetchApi.mockRejectedValue(failure);
    await expect(executeGraphQL(ProjectsDocument)).rejects.toBe(failure);
  });
});

describe("persisted documents", () => {
  it("sends the document text with its manifest hash", async () => {
    fetchApi.mockResolvedValue(Response.json({ data: { projects: [] } }));
    await executeGraphQL(ProjectsDocument);
    const body = JSON.parse(fetchApi.mock.calls[0][1].body);
    expect(body.query).toContain("query Projects");
    expect(body.extensions.persistedQuery).toEqual({
      version: 1,
      sha256Hash: ProjectsDocument.__meta__!.hash!.replace("sha256:", ""),
    });
  });
});
