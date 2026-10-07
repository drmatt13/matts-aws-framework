# Quick Start

Get the framework running locally against your own AWS account, then learn the
handful of files you'll actually touch.

## What you need

- Node 24+
- Docker Desktop (running)
- The AWS CLI with a configured profile, shown below as `<profile>`

Run every command from the **repository root**.

## 1. Get it running

**1. Create the CDK env file.** Copy `cdk-app/.env.dev.example` to `cdk-app/.env`.
You don't need to change anything in it.

```bash
cp cdk-app/.env.dev.example cdk-app/.env
```

**2. Install dependencies.**

```bash
npm ci
```

**3. Deploy the AWS resources.** This creates Cognito (sign-in) and a few dev helpers
in your account, then writes the generated values to a root-level `.env`.

```bash
npm run deploy:resources -- --all --profile=<profile> --yes
```

> First time using CDK in this AWS account and region? Run this once first:
> `npm --workspace cdk-app exec -- cdk bootstrap --profile=<profile>`

**4. Create the client env file.** Copy `client-app/.env.example` to `client-app/.env`,
then fill in the Cognito values from the root `.env` that step 3 generated:

| Put this in `client-app/.env` | Copy it from root `.env` |
| --- | --- |
| `VITE_USER_POOL_ID` | `USER_POOL_ID` |
| `VITE_USER_POOL_CLIENT_ID` | `USER_POOL_CLIENT_ID` |
| `VITE_COGNITO_DOMAIN` | `COGNITO_DOMAIN_URL` |
| `VITE_AWS_REGION` | `LOCAL_AWS_REGION` |

**5. Start the backend** (Docker containers). Leave this terminal running.

```bash
npm run dev:containers -- --profile=<profile>
```

**6. Start the frontend** in a second terminal.

```bash
npm run dev:client
```

**7. Open [http://localhost:3000](http://localhost:3000).** Sign up and you're in.

> In dev mode, only Cognito and its triggers live in AWS. Your HTTP routes,
> WebSocket routes, services, tasks and workflows all run locally in Docker.

**When you're done**, tear down the AWS resources:

```bash
npm run destroy:resources -- --all --profile=<profile>
```

## 2. The files that matter

### `framework.config.ts`: the most important file

It lists every workload in the app. Each workload type is declared in its own module
under `framework-config/`, and this file imports and composes them:

```ts
const framework = defineFrameworkConfig({
  resources,
  defaults,
  http: [authRoutes, graphqlRoutes, exampleRoutes, invocationTestRoutes],
  webSocket: [webSocketRoutes],
  events: [cognitoEvents, invocationTestEvents],
  services: [exampleService],
  tasks: [invocationTestTasks],
  workflows: [invocationTestWorkflows, capabilityWorkflows],
  tools: [exampleTools],
  agents: [exampleAgent],
});
```

To add something new, write a module in `framework-config/<type>/`, then add it to the
matching array. The framework builds the routing, local dev servers and AWS
infrastructure from these declarations.

### `framework-config/resources.ts`: where workloads get their inputs

This file can provide three kinds of input.

**1. Plain env variables.** Set the value in `cdk-app/.env`, then declare it here:

```ts
bedrockModelId: resource.fromEnv("LANGGRAPH_BEDROCK_MODEL_ID").default("global.amazon.nova-2-lite-v1:0"),
```

**2. Secrets.** Set the raw value in `cdk-app/.env`, then declare it here.
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

See `framework-config/agents/example.ts` for a real case.

**3. Linked CDK stacks.** Any public field on one of your stacks becomes a resource.
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
//    framework-config/services/example.ts
environment: { USER_POOL_ID: resources.cognito.userPool.userPoolId },
//    framework-config/events/cognito.ts
environment: { FRONTEND_URL: resources.cognito.frontendUrl },
```

No ARNs to copy and paste. If you rename a field, the code stops compiling until you
update every place that uses it.

### `cdk-app/lib/`: where CDK code goes

- `cdk-app/lib/app/`: **put all of your own constructs and stacks here.**
- `cdk-app/lib/framework/`: framework internals. You shouldn't need to modify these.

## 3. Lambda handler wrappers

Handlers live in `cdk-app/lambda_functions/`. Wrap each handler in the matching helper:

**`authenticated`**: an HTTP route that requires a signed-in user. Pair it with
`auth: true` on the route.

```ts
import { authenticated } from "@repo/framework/runtime/auth";
import { jsonResponse } from "@repo/framework/runtime/http";

export const lambdaHandler = authenticated(async (event, session) => {
  return jsonResponse(200, { sub: session.payload.sub });
});
```

**`withLocalReplay`**: an AWS event (such as a Cognito trigger) that you want to run
**on your machine** during dev. Set `localReplay: true` on the event declaration. AWS
captures the event, and your local dev server replays it through your code, so you can
debug real AWS events locally.

```ts
// framework-config/events/cognito.ts
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
