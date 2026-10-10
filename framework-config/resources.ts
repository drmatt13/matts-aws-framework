// Type-only on purpose: a value import would carry the whole of aws-cdk-lib
// into the dev servers and the invocation runner, which load this catalog.
import type { WorkflowFixturesStack } from "../cdk-app/lib/app/workflow-fixtures-stack";
import type { CognitoStack } from "../cdk-app/lib/app/cognito-stack";
import type { RdsStack } from "../cdk-app/lib/app/rds-stack";
import type { ReferenceExampleStack } from "../cdk-app/lib/app/reference-example-stack";
import { defineResources, resource } from "@repo/framework/config";
import { PROD_DEPLOYMENT } from "@repo/framework/config/source";

/**
 * The application's resource catalog: what this application's workloads need
 * supplied, and where each value comes from.
 *
 * There are two answers, and only two.
 *
 * A `resource.stack<T>()` entry is the stack itself: every public field it has
 * is a resource under the name the field already carries, whether the field
 * holds a construct (`resources.cognito.userPool.userPoolId`), a string the
 * stack computed (`resources.cognito.userPoolDomainUrl`) or a secret the stack
 * built or imported. Renaming the field
 * fails to compile here. The stack answers with one `linkResources(this, ...)`.
 *
 * Everything else is `resource.fromEnv("NAME")`, or `resource.secret("NAME")`
 * for one whose value `npm run deploy` uploads to Secrets Manager — a line you
 * author in cdk-app/.env, named where it is declared. That file is the only
 * place a deployment reads an input from, so a model id is the same string in
 * AWS and under `docker compose up`. The repository-root .env is generated
 * output and is never read back as an input.
 *
 * An entry declared `undefined` keeps its place in the catalog and resolves to
 * nothing: every config that reads it still compiles, and the workload that
 * names it simply never sees the variable. That is how a database this
 * deployment does not build disappears, without any resource having to know
 * what a deployment mode is.
 *
 * See docs/FRAMEWORK.md#resources-inputs-and-permissions.
 */
export const resources = defineResources({
  // One entry, every construct and computed value the stack exposes. The stack
  // class is the declaration; `linkResources(this, ...)` beside it is the whole
  // binding.
  referenceExamples: resource.stack<ReferenceExampleStack>(),
  workflowFixtures: PROD_DEPLOYMENT ? undefined : resource.stack<WorkflowFixturesStack>(),

  // Constructs, plus this deployment's resolved frontend settings:
  // `userPoolDomainUrl`, `trustedOriginsCsv`, `frontendUrl` and
  // `skipEmailVerification` are all fields on CognitoStack.
  cognito: resource.stack<CognitoStack>(),

  // Only a full deployment builds a database, and `bin/cdk-app.ts` branches on
  // the same value. Without it, `resources.rds.database` still compiles where
  // framework.config.ts names it, and a workload's `database: true` places
  // nothing in AWS: the local Postgres container stands in for it.
  rds: PROD_DEPLOYMENT ? resource.stack<RdsStack>() : undefined,

  openaiApiKey: resource.secret("OPENAI_API_KEY"),
  googleClientSecret: resource.secret("GOOGLE_CLIENT_SECRET"),

  langgraph: {
    modelProvider: resource
      .fromEnv("LANGGRAPH_MODEL_PROVIDER")
      .enum("bedrock-mantle", "bedrock", "openai")
      .default("bedrock-mantle"),
    bedrockModelId: resource.fromEnv("LANGGRAPH_BEDROCK_MODEL_ID").default("global.amazon.nova-2-lite-v1:0"),
    bedrockMantleModelId: resource.fromEnv("LANGGRAPH_BEDROCK_MANTLE_MODEL_ID").default("openai.gpt-oss-20b"),
    openaiModelId: resource.fromEnv("LANGGRAPH_OPENAI_MODEL_ID").default("gpt-4.1-mini"),
  },
});
