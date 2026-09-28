import type { Feature } from "./scaffold.js";

/** Plain source templates: after writing, these files belong to the application. */
export function renderFeature(f: Feature) {
  const { model: m, singular: s, repository: r } = f;
  const queryDocument = f.query[0].toUpperCase() + f.query.slice(1);
  const mutationDocument = f.mutation[0].toUpperCase() + f.mutation.slice(1);
  const payload = `${mutationDocument}Payload`;
  const publicFields = f.fields.filter((field) =>
    f.publicFields.includes(field.name),
  );
  const inputs = f.fields.filter((field) =>
    f.createFields.includes(field.name),
  );
  const sample = Object.fromEntries(
    f.fields.map((field) => [field.name, field.sample]),
  );
  const inputSample = Object.fromEntries(
    inputs.map((field) => [field.name, field.sample]),
  );
  const q = (value: string) => JSON.stringify(value);
  const contracts = `export type ${m}Record = ContractRow<"${m}">;
export type Create${m}Input = Pick<${m}Record, ${[f.owner, ...f.createFields].map(q).join(" | ")}>;

export interface ${m}Repository {
  listByOwner(ownerId: string): Promise<${m}Record[]>;
  create(input: Create${m}Input): Promise<${m}Record>;
}
`;
  const repository = `import type { DatabaseClient } from "./client.js";
import type { ${m}Repository } from "./contracts.js";

export function create${m}Repository(client: DatabaseClient): ${m}Repository {
  const records = client.orm.public.${m};
  return {
    listByOwner: async (ownerId) => records.where({ ${f.owner}: ownerId }).all(),
    create: async (input) => records.create(input),
  };
}
`;
  const schema = `import type { ${m}Record } from "@repo/database";
import { z } from "zod";
import { requireCurrentUserId } from "../graphql-context";
import { builder } from "./builder";
import { invalidPayload } from "./errors";

// Add application-specific bounds and normalization here.
const Create${m}Schema = z.object({
${inputs.map((field) => `  ${field.name}: ${field.validation},`).join("\n")}
}).strict();

// Only the explicitly selected fields are public. ${f.owner} stays internal.
const ${m} = builder.objectRef<${m}Record>("${m}").implement({
  fields: (t) => ({
${publicFields.map((field) => `    ${field.name}: t.expose${field.scalar}("${field.name}"),`).join("\n")}
  }),
});
const Create${m}Input = builder.inputType("Create${m}Input", {
  fields: (t) => ({
${inputs.map((field) => `    ${field.name}: t.${field.input}({ required: true }),`).join("\n")}
  }),
});
const ${payload} = builder.objectRef<{ ${s}: ${m}Record }>("${payload}").implement({
  fields: (t) => ({ ${s}: t.field({ type: ${m}, resolve: (payload) => payload.${s} }) }),
});

builder.queryField("${f.query}", (t) => t.field({
  type: [${m}],
  resolve: async (_parent, _args, context) =>
    context.database.${r}.listByOwner(await requireCurrentUserId(context)),
}));

builder.mutationField("${f.mutation}", (t) => t.field({
  type: ${payload},
  args: { data: t.arg({ type: Create${m}Input, required: true }) },
  resolve: async (_parent, args, context) => {
    const parsed = Create${m}Schema.safeParse(args.data);
    if (!parsed.success) throw invalidPayload("Invalid ${s} payload", parsed.error);
    const ownerId = await requireCurrentUserId(context);
    const ${s} = await context.database.${r}.create({ ...parsed.data, ${f.owner}: ownerId });
    return { ${s} };
  },
}));
`;
  const operations = `import { mutationOptions, queryOptions } from "@tanstack/react-query";
import type { VariablesOf } from "@graphql-typed-document-node/core";
import { graphql } from "#/api/generated";
import { executeGraphQL } from "#/api/graphql/client";

graphql(\`
  fragment ${m}Summary on ${m} {
${f.selection.map((name) => `    ${name}`).join("\n")}
  }
\`);
const ${queryDocument}Document = graphql(\`
  query ${queryDocument} {
    ${f.query} { ...${m}Summary }
  }
\`);
const ${mutationDocument}Document = graphql(\`
  mutation ${mutationDocument}($data: Create${m}Input!) {
    ${f.mutation}(data: $data) { ${s} { ...${m}Summary } }
  }
\`);

/** Every query this feature caches, under one prefix a mutation can invalidate. */
export const ${s}Keys = {
  all: ["${f.query}"] as const,
  list: () => [...${s}Keys.all, "list"] as const,
};

export const ${f.query}Query = queryOptions({
  queryKey: ${s}Keys.list(),
  queryFn: async () => (await executeGraphQL(${queryDocument}Document)).${f.query},
});
export const ${f.mutation}Mutation = mutationOptions({
  mutationFn: async (variables: VariablesOf<typeof ${mutationDocument}Document>) =>
    (await executeGraphQL(${mutationDocument}Document, variables)).${f.mutation}.${s},
  onSuccess: (_data, _variables, _result, { client }) =>
    client.invalidateQueries({ queryKey: ${s}Keys.all }),
});
`;
  const tests = `import assert from "node:assert/strict";
import { test } from "node:test";
import { graphql } from "graphql";
import type { ${m}Record, ${m}Repository } from "@repo/database";
import type { GraphQLContext } from "../graphql-context";
import { schema } from "./index";

const record: ${m}Record = ${JSON.stringify(sample, null, 2)};
const input = ${JSON.stringify(inputSample, null, 2)};
function fixture(missingUser = false) {
  const calls: Array<{ method: string; value: unknown }> = [];
  const repository: ${m}Repository = {
    listByOwner: async (owner) => { calls.push({ method: "list", value: owner }); return [record]; },
    create: async (data) => { calls.push({ method: "create", value: data }); return { ...record, ...data }; },
  };
  const contextValue = {
    session: { payload: { sub: "subject" } },
    database: {
      users: { findByCognitoSub: async (sub: string) => {
        assert.equal(sub, "subject");
        return missingUser ? null : { id: record.${f.owner} };
      } },
      ${r}: repository,
    },
  } as unknown as GraphQLContext;
  return { calls, run: (source: string, variableValues?: Record<string, unknown>) =>
    graphql({ schema, source, variableValues, contextValue }) };
}
const mutation = "mutation($data: Create${m}Input!) { ${f.mutation}(data: $data) { ${s} { id } } }";

test("${f.query} scopes reads to the session and withholds ownership", async () => {
  const { run, calls } = fixture();
  assert.equal((await run("{ ${f.query} { id } }")).errors, undefined);
  assert.deepEqual(calls, [{ method: "list", value: record.${f.owner} }]);
  assert.ok((await run("{ ${f.query} { ${f.owner} } }")).errors);
});
test("${f.mutation} assigns ownership on the server", async () => {
  const { run, calls } = fixture();
  assert.equal((await run(mutation, { data: input })).errors, undefined);
  assert.deepEqual(calls, [{ method: "create", value: { ...input, ${f.owner}: record.${f.owner} } }]);
  assert.ok((await run(mutation, { data: { ...input, ${f.owner}: "other" } })).errors);
  assert.equal(calls.length, 1);
});
test("${f.mutation} rejects missing users and invalid inputs without writing", async () => {
  const { run, calls } = fixture(true);
  assert.equal((await run(mutation, { data: input })).errors![0].extensions.code, "NOT_FOUND");
  assert.deepEqual(calls, []);
  const validUser = fixture();
  assert.ok((await validUser.run(mutation, { data: {} })).errors);
  assert.deepEqual(validUser.calls, []);
});
`;
  return {
    contracts,
    files: {
      [`packages/database/src/${r}.ts`]: repository,
      [`cdk-app/lambda_functions/http_functions/graphql-api/schema/${s}.ts`]:
        schema,
      [`cdk-app/lambda_functions/http_functions/graphql-api/schema/${s}.test.ts`]:
        tests,
      [`client-app/src/api/${f.query}/operations.ts`]: operations,
    },
  };
}
