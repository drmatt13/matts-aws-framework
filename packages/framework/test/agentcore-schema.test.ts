import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { projectGatewaySchema } from "../src/protocol/tool-schema";

const input = (schema: z.ZodType) => z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;

test("a contract projects to Gateway's schema subset, keeping constraints readable to the model", () => {
  const projected = projectGatewaySchema(
    input(
      z.object({
        caseNumber: z.string().describe("The case number").regex(/^\d+$/).min(3),
        status: z.enum(["open", "closed"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
        tags: z.array(z.string()),
        nested: z.object({ flag: z.boolean() }),
      }),
    ),
    "tools.lookup-case.request",
  );

  assert.deepEqual(projected, {
    type: "object",
    properties: {
      caseNumber: { type: "string", description: "The case number. At least 3 characters. Matches ^\\d+$." },
      status: { type: "string", description: 'One of: "open", "closed".' },
      limit: { type: "integer", description: "Minimum 1. Maximum 50. Defaults to 10." },
      tags: { type: "array", items: { type: "string" } },
      nested: { type: "object", properties: { flag: { type: "boolean" } }, required: ["flag"] },
    },
    required: ["caseNumber", "tags", "nested"],
  });
});

test("notes read naturally, and Zod's implicit integer bounds are not written as constraints", () => {
  const projected = projectGatewaySchema(
    input(z.object({ count: z.number().int(), name: z.string().min(1).max(1), tags: z.array(z.string()).min(1) })),
    "tools.x.request",
  );
  assert.deepEqual(projected.properties, {
    count: { type: "integer" },
    name: { type: "string", description: "At least 1 character. At most 1 character." },
    tags: { type: "array", description: "At least 1 item.", items: { type: "string" } },
  });
});

test("closed output objects lose only the closing, which Gateway cannot express", () => {
  const output = z.toJSONSchema(z.object({ title: z.string() }), { io: "output" }) as Record<string, unknown>;
  assert.deepEqual(projectGatewaySchema(output, "tools.x.response"), {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
  });
});

test("shapes Gateway cannot describe are refused at the field that wrote them", () => {
  assert.throws(
    () => projectGatewaySchema(input(z.object({ v: z.union([z.string(), z.number()]) })), "tools.x.request"),
    /tools\.x\.request\.v: Gateway tool schemas cannot express a union or a nullable value/,
  );
  assert.throws(
    () => projectGatewaySchema(input(z.object({ v: z.string().nullable() })), "tools.x.request"),
    /tools\.x\.request\.v: Gateway tool schemas cannot express a union or a nullable value/,
  );
  assert.throws(
    () => projectGatewaySchema(input(z.object({ v: z.record(z.string(), z.number()) })), "tools.x.request"),
    /tools\.x\.request\.v: Gateway tool schemas cannot express a record/,
  );
  assert.throws(
    () => projectGatewaySchema(input(z.string()), "tools.x.request"),
    /tools\.x\.request: a tool's request and response must be objects/,
  );
});
