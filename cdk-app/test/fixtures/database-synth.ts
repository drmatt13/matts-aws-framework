import { writeFileSync } from "node:fs";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { defineFrameworkConfig } from "@repo/framework/config";
import { resources } from "../../../framework-config/resources";
import { defaults } from "../../../framework-config/defaults";
import { resolveDatabaseSettings } from "../../database-settings";
import { RdsStack } from "../../lib/app/rds-stack";
import { SynchronousLambdaFunctionsStack } from "../../lib/framework/synchronous-lambda-functions-stack";
import { initializeFrameworkResources, finalizeFrameworkResources } from "../../lib/framework/framework-resources";

const env = { account: "111122223333", region: "us-east-1" };
const config = defineFrameworkConfig({
  resources, database: resources.rds.database, defaults,
  http: [{
    "/verify-session": { directory: "/lambda_functions/http_functions/verify-session", methods: ["GET"], database: { readers: true } },
    "/sign-out": { directory: "/lambda_functions/http_functions/sign-out", methods: ["POST"], database: { connection: "direct" } },
  }],
  webSocket: [], events: [], services: [], tasks: [], workflows: [],
});
const app = new cdk.App({ context: { "@aws-cdk/aws-rds:setCorrectValueForDatabaseInstanceReadReplicaInstanceResourceId": true } });
initializeFrameworkResources(app, { config, mode: "prod", deployment: "example", readers: { env: {} } });
new RdsStack(app, "example-RdsStack", {
  env, retainStatefulResources: process.env.RETAIN_STATEFUL_RESOURCES === "true",
  databaseSettings: resolveDatabaseSettings({ env: process.env, getContext: () => undefined }),
});
new SynchronousLambdaFunctionsStack(app, "Lambdas", { env, config, cloud: { mode: "prod" } });
finalizeFrameworkResources(app);
app.synth(); // Includes cross-stack dependency cycle validation.
writeFileSync(process.argv[2]!, JSON.stringify(Object.fromEntries(
  app.node.children.filter(cdk.Stack.isStack).map(stack => [stack.stackName, Template.fromStack(stack).toJSON()]),
)));
