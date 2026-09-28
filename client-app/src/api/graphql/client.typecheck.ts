import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import {
  ProjectsDocument,
  SetProjectArchivedDocument,
  type TypedDocumentString,
} from "../generated/graphql";
import { executeGraphQL } from "./client";

// Compiled by the client typecheck; never executed or imported by the app.
export function checkVariables(
  optional: TypedDocumentString<{ ok: boolean }, { id?: string }>,
  ast: TypedDocumentNode<{ ok: boolean }, { id?: string }>,
) {
  // @ts-expect-error An AST document would be sent as "[object Object]".
  executeGraphQL(ast);
  executeGraphQL(ProjectsDocument);
  executeGraphQL(optional);
  executeGraphQL(optional, { id: "project" });
  executeGraphQL(SetProjectArchivedDocument, { id: "project", archived: true });
  // @ts-expect-error Required document variables cannot be omitted.
  executeGraphQL(SetProjectArchivedDocument);
  // @ts-expect-error Every required variable must be supplied.
  executeGraphQL(SetProjectArchivedDocument, { id: "project" });
  executeGraphQL(SetProjectArchivedDocument, {
    id: "project",
    // @ts-expect-error Variables cannot widen the document's inferred types.
    archived: "yes",
  });
}
