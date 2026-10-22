import { defineResources } from "@repo/framework/config";
import { cognito, rds, referenceExamples } from "./resources/stacks";
import { googleClientSecret, langgraph, openaiApiKey } from "./resources/inputs";

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
 * for one whose value `npm run deploy:resources` uploads to Secrets Manager — a line you
 * author in cdk-app/.env.<mode>, named where it is declared. That file is the only
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
  // Names here are the public catalog contract. Module paths are organization.
  referenceExamples,
  cognito,
  rds,
  openaiApiKey,
  googleClientSecret,
  langgraph,
});
