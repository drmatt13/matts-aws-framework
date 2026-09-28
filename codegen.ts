import type { CodegenConfig } from "@graphql-codegen/cli";
import { schema } from "./cdk-app/lambda_functions/http_functions/graphql-api/schema/index";

const config: CodegenConfig = {
  schema,
  documents: ["client-app/src/api/**/*.ts", "!client-app/src/api/generated/**"],
  generates: {
    "client-app/src/api/generated/": {
      preset: "client",
      config: {
        useTypeImports: true,
        // Documents are typed strings: the browser sends them as written and
        // never ships graphql-js to print an AST on every request.
        documentMode: "string",
      },
      presetConfig: {
        fragmentMasking: false,
        // persisted-documents.json lists every operation the client can send.
        // The GraphQL Lambda can accept only those (GRAPHQL_PERSISTED_DOCUMENTS_ONLY).
        persistedDocuments: { hashAlgorithm: "sha256" },
      },
    },
    "client-app/src/api/generated/schema.graphql": {
      plugins: ["schema-ast"],
      config: {
        includeDirectives: true,
      },
    },
  },
};

export default config;
