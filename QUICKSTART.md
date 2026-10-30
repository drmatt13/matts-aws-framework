# Quick Start

Start with Studio's source model, then run the application against your own development
AWS deployment. The [Development guide](docs/DEV-DEPLOYMENT.md) owns the complete setup
and troubleshooting procedure; this page is the shortest guided path.

## What you need

- Node 24+ and npm 11
- Docker Desktop with Linux containers and Compose Watch, for local application compute
- The AWS CLI with a configured profile, shown below as `<profile>`

Run every command from the **repository root**.

## 1. Get it running

**1. Install and open Studio.** Viewing the source graph does not require deploying AWS
or starting Docker. Studio is the visual interface to the same TypeScript declarations
you edit in your editor.

```bash
npm ci
npm run studio
```

Open the loopback URL printed by Studio. Explore the architecture and inspectors before
starting deployment operations. Keep this terminal running while using Studio.

**2. Prepare development inputs.** Generate a missing `cdk-app/.env.dev` from Studio's
**CDK environment files** island, or copy `cdk-app/.env.dev.template` only if the private
file does not exist. Set a distinct `CDK_APP_NAME`, your local origin/ports and any required
workload inputs. Preserve existing values. Development reads `.env.dev`; explicit
production commands read the selected production target's inputs, conventionally
`.env.prod`. There is no mode-less `cdk-app/.env`.

**3. Select and verify the development account.** Deployment creates real AWS resources
and is a separate authorized action. Use the same intended profile for deploy and local
execution:

```bash
aws sts get-caller-identity --profile <profile>
```

If this account/region has not been bootstrapped for CDK, follow the development setup
before deployment. Bootstrapping also changes AWS infrastructure.

**4. Review and deploy development.** In Studio **Deploy**, select the profile and
development target, prepare the plan and review its effects before applying. The CLI
equivalent is:

```bash
npm run deploy:resources -- --all --profile <profile> --plan .cache/dev-review --review template
npm run deploy:resources -- --apply .cache/dev-review --profile <profile>
```

Use a fresh plan directory for a new review. A failed or interrupted apply requires
inspecting recorded progress and AWS before replanning. Review may require additional
confirmation for consequential transitions; follow the exact requirement it reports.

Successful dev deployment exports root `.env` for Compose controls,
`.framework/local/resources.json` for identifiers and
`client-app/.env.development.local` for public browser settings. Do not copy client
settings or resource ARNs by hand. Keep any application-specific public overrides in
`client-app/.env`; never put a backend secret in a `VITE_` variable.

**5. Start local compute.** Studio's **Start development** coordinates containers,
source watch and the client. From the CLI, leave these commands in separate terminals:

```bash
npm run dev:containers -- --profile=<profile>
```

In the second terminal:

```bash
npm run dev:client
```

**6. Inspect and initialize storage when needed.** Startup verifies the existing local
database without writing schema or users. On a fresh database, PostgreSQL remains
available while consumers wait. In Studio **Database → Database status → Local
PostgreSQL**, inspect it, review the initialization SQL and separately authorize
initialization. For an existing database, review its pending migrations instead.
Retry local startup after the database action. See [Database](docs/DATABASE.md#local-database).

**7. Open the configured frontend origin** (`http://localhost:3000` by default), sign
up/sign in and verify the application. Cognito identities, replay delivery and
enabled API Gateway WebSocket routes remain in AWS. HTTP, services, tasks, workflows,
agents and locally enabled WebSocket routes run locally. Model providers and declared
AWS resources can still be external dependencies. See
[shared AWS dependencies](docs/SHARED-AWS-DEPENDENCIES.md).

**When finished**, use `docker compose stop` to stop local containers while preserving
`postgres_data`. Closing Studio stops its source watch/client, not its containers.
Cloud teardown is a separate decision: inspect a saved identity-scoped deletion review
and retention consequences using [the teardown procedure](docs/PROD-DEPLOYMENT.md#teardown)
with dev mode. Routine shutdown does not require deleting your AWS deployment.

## 2. The files that matter

### `framework.config.ts`: the most important file

It lists every workload in the app. Each workload type is declared in its own module
under `framework-config/`, and this file imports and composes them:

```ts
const framework = defineFrameworkConfig({
  resources,
  defaults,
  networks: [applicationVpc],        // framework-config/networks/application/index.ts
  database: applicationDatabase,
  userPool: {                       // what a workload's `userPool: true` is handed
    userPoolId: resources.cognito.userPool.userPoolId,
    userPoolClientId: resources.cognito.userPoolClient.userPoolClientId,
  },
  http: [http],
  webSocket: [webSocket],
  events: [events],
  services: [services],
  tasks: [tasks],
  workflows: [workflows],
  tools: [tools],
  agents: [agents],
});
```

The excerpt uses imported section objects from `framework-config/workloads/<kind>.ts`.
Add entries there, or compose an additional imported module through the matching array.
The framework builds the routing, local dev servers and AWS
infrastructure from these declarations.

Declare each VPC with `defineNetwork({ id, ...settings })` in
`framework-config/networks/<id>/index.ts` and register its imported value in `networks`.
A networked Lambda selects it with `vpc: applicationVpc`; a container selects it with
`cloud: { vpc: applicationVpc, subnet: "public" }`. Database consumers must select the
database's VPC. Each declaration appears as its own Studio island; unused VPCs remain
blueprints and create no production infrastructure.

### `framework-config/resources.ts`: where workloads get their inputs

The catalog joins public values, environment-backed inputs, secrets and linked stacks.
These references declare how data is supplied; workload `environment`, `secrets`,
`cloud.bindings` and `cloud.access` declare consumption and access.

**Standalone public values** need no dotenv entry:

```ts
applicationLabel: resource.value("My application"),
```

Use `resource.value({ dev: "My application", prod: "My production application" })`
for mode-specific values.
Do not put credentials in a public value. Environment-backed inputs are the choice when
the operator supplies a setting through the selected private inputs file.

**1. Plain env variables.** Set the value in `cdk-app/.env.dev`, then declare it here:

```ts
bedrockModelId: resource.fromEnv("LANGGRAPH_BEDROCK_MODEL_ID").default("global.amazon.nova-2-lite-v1:0"),
```

**2. Secrets.** Set the raw value in `cdk-app/.env.dev`, then declare it here.
`npm run deploy:resources` uploads the value to Secrets Manager for you.

```ts
openaiApiKey: resource.secret("OPENAI_API_KEY"),
```

Then hand it to a workload:

```ts
// ECS service or task: the value is injected into the container automatically
secrets: { OPENAI_API_KEY: resources.openaiApiKey.value }

// Lambda: pass the ARN; this also grants the Lambda permission to read the secret
environment: { OPENAI_API_KEY_SECRET_ARN: resources.openaiApiKey.arn }
```

See `framework-config/workloads/agents.ts` for a real case.

**3. Linked CDK stacks.** Supported public construct, string and secret fields on
your stack become typed resource references.
Cognito is the real example. It takes three steps:

```ts
// 1. cdk-app/lib/app/cognito-stack.ts: expose public fields, then link at the END of the constructor
export class CognitoStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly frontendUrl: string;
  // ...
  constructor(...) {
    // ...build everything and assign the fields...
    linkResources(this, resources.cognito);
  }
}

// 2. framework-config/resources.ts: register the stack
cognito: resource.stack<CognitoStack>(),

// 3. Any workload can now use its fields
//    framework-config/workloads/http.ts
environment: { COGNITO_DOMAIN_URL: resources.cognito.userPoolDomainUrl },
//    framework-config/workloads/events.ts
environment: { FRONTEND_URL: resources.cognito.frontendUrl },
```

No ARNs to copy and paste. TypeScript checks typed field references. Keep deployed
construct IDs and resource paths stable; a compiling rename can still affect
infrastructure identity, so inspect the source diff and synthesized plan.

### `cdk-app/lib/`: where CDK code goes

- `cdk-app/lib/app/`: **put all of your own constructs and stacks here.**
- `cdk-app/lib/framework/`: framework internals. You shouldn't need to modify these.

## 3. Lambda handler wrappers

Handlers live in `cdk-app/lambda_functions/`. Wrap each handler in the matching helper:

**`authenticated`**: an HTTP route that requires a signed-in user. Pair it with
`auth: true`, which makes the gateway admit only signed-in callers, and `userPool: true`,
which hands the handler the user pool its token verifier reads:

```ts
// framework-config/workloads/http.ts
"/hello": {
  directory: "/lambda_functions/http_functions/hello",
  methods: ["GET"],
  auth: true,
  userPool: true,
},

// cdk-app/lambda_functions/http_functions/hello/index.ts
import { authenticated } from "@repo/framework/runtime/auth";
import { jsonResponse } from "@repo/framework/runtime/http";

export const lambdaHandler = authenticated(async (event, session) => {
  return jsonResponse(200, { sub: session.payload.sub });
});
```

`npm run framework:check` fails if a handler verifies a token without the pool. A tool or
agent with `auth: true` is handed the pool without asking, because its handler is the
verifier.

**`withLocalReplay`**: an AWS event (such as a Cognito trigger) that you want to run
**on your machine** during dev. Set `localReplay: true` on the event declaration. AWS
captures the event, and your local dev server replays it through your code, so you can
debug real AWS events locally.

```ts
// framework-config/workloads/events.ts
"cognito-post-confirmation-trigger": {
  localReplay: true,
  // ...
},

// cdk-app/lambda_functions/event_functions/cognito-post-confirmation-trigger/index.ts
import { withLocalReplay } from "@repo/framework/runtime/event-replay";

export const lambdaHandler = withLocalReplay(async (event) => {
  // ...
  return event;
});
```

`npm run framework:check` fails if one of these is set without the other.

**`tool`** / **`authenticatedTool`**: a Lambda that an AgentCore agent can call.
`contract` is a Zod schema file next to the handler, and inputs are validated against it.

```ts
import { tool } from "@repo/framework/runtime/tools";
import { contract } from "./contract";

export const lambdaHandler = tool(contract, async ({ a, b }) => ({ sum: a + b }));
```

## Going deeper

- [README.md](README.md): overview and repository map
- [docs/FRAMEWORK.md](docs/FRAMEWORK.md): workloads, resources and secrets in detail
- [docs/DEV-DEPLOYMENT.md](docs/DEV-DEPLOYMENT.md): full development guide and troubleshooting
- [docs/AGENTCORE.md](docs/AGENTCORE.md): agents and tools
- [Operational lifecycle](docs/aws-studio-knowledge/deployment/lifecycle.md): source,
  infrastructure, database, identity and frontend reviews and their separate effects

WebSocket API Gateway is framework managed in both AWS modes. The application's
`resources.enableWebSocketApi` public value enables its handlers and authorizer through
their shared Deploy condition. The current catalog authors it with `resource.value("true")`;
edit the value in source or Studio. It does not read an `ENABLE_WEBSOCKET_API` dotenv line
unless you explicitly change it to an environment-linked input. The retired
`DEPLOY_PROD_WEBSOCKET_API` setting is not a supported selector.
Configure individual workloads with `deploy`,
including `deploy: { when: { resource: resources.input, equals: "value" } }`, or use
Studio's Deploy control. Input conditions are evaluated separately per environment.
