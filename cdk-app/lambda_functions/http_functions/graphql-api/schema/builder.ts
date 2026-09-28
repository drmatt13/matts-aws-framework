import SchemaBuilder from "@pothos/core";
import type { GraphQLContext } from "../graphql-context";

/**
 * Fields are non-nullable unless a field opts in with `nullable: true`.
 *
 * Pothos defaults to nullable-by-default, which erases every NOT NULL guarantee
 * the database makes and pushes `| null` all the way into React components. The
 * type parameter drives TypeScript inference; the runtime option drives the
 * emitted SDL. Both are required.
 *
 * Input fields stay optional by default, which is what partial-update inputs want.
 */
export const builder = new SchemaBuilder<{
  Context: GraphQLContext;
  DefaultFieldNullability: false;
}>({
  defaultFieldNullability: false,
});

builder.queryType({});
builder.mutationType({});
