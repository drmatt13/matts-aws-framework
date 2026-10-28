import { defineResources } from "@repo/framework/config";
import { FRAMEWORK_MODE } from "@repo/framework/config/source";
import { cognito, rds, referenceExamples } from "./resources/stacks";
import { client, enableWebSocketApi, googleClientSecret, langgraph, openaiApiKey } from "./resources/inputs";

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
 * An input says how development and production differ where it is declared:
 * `.only("dev")`, `.required("prod")`, `.default({ dev, prod })`. The catalog
 * is resolved for the graph being built (`mode` below), so an input outside its
 * graph keeps its place and resolves to nothing: every config that reads it
 * still compiles, and the workload that names it simply never sees the
 * variable. A stack this deployment does not build is declared `undefined` and
 * disappears the same way.
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
  enableWebSocketApi,
  client,
  langgraph,
}, { mode: FRAMEWORK_MODE });
