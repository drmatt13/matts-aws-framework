# matt's-aws-framework

A TypeScript npm-workspace framework for AWS applications: React, Cognito,
GraphQL, PostgreSQL, Lambda, container services, tasks, workflows, and AgentCore
agents and tools. The same
workload declarations drive AWS infrastructure and the local development servers.

## Start here

Use Node 24+, npm, an AWS CLI profile, and Docker Desktop with Linux containers.
The CDK CLI is installed in the workspace; a global installation is unnecessary.

| I want to… | Read |
| --- | --- |
| Set up and run development | [Development](docs/DEV-DEPLOYMENT.md) |
| Deploy or update production | [Production](docs/PROD-DEPLOYMENT.md) |
| Understand persistence and migrations | [Database](docs/DATABASE.md) |
| Find shared application and declaration helpers | [Shared functions](docs/SHARED-FUNCTIONS.md) |
| See which AWS services development still uses | [Shared AWS dependencies](docs/SHARED-AWS-DEPENDENCIES.md) |
| Have an agent wire a data change through the application | [Data features](docs/DATA-FEATURES.md) |
| Add an endpoint, service, task, workflow, or resource | [Framework](docs/FRAMEWORK.md) |
| Add an AgentCore agent or the tools it calls | [AgentCore](docs/AGENTCORE.md) |

## The two declarations you normally edit

- `framework.config.ts` composes the workload sections under `framework-config/`.
  Add workloads there and implement their handlers; routing and infrastructure
  wiring are derived from those declarations.
- `packages/database/prisma/contract.prisma` declares storage. An agent can
  propagate an approved change through repositories, GraphQL, generated documents,
  and TanStack Query options. See the data-feature guide for the required intent
  and the exact [automation contract](agents/typed-contract-propagation-agent.md).

Resources live in `framework-config/resources.ts`. Declare a stack there with
`resource.stack<MyStack>()`, end the stack's constructor with `linkResources(this, resources.myStack)`,
then reference its fields, attributes and grants in workloads.
`npm run deploy -- --all -c useLocalDevStack=true --profile <PROFILE>` handles secret
synchronization, deployment, and development export. Root `.env` contains Compose controls;
workload identifiers use the ignored `.framework/local/resources.json` manifest.

Application authorization, validation, public fields, and screen selections remain
explicit source. Generators and agents handle the surrounding mechanics.

## Repository map

| Location | Responsibility |
| --- | --- |
| `client-app/` | React application and typed API operations |
| `framework-config/` | Workloads, resources, application resource types, defaults, and invocation graphs |
| `cdk-app/lib/app/` | Application infrastructure such as Cognito and RDS |
| `cdk-app/lib/framework/` | Infrastructure constructed from workload declarations |
| `cdk-app/lambda_functions/` | HTTP, WebSocket, and event handlers |
| `cdk-app/ecs_containers/` | Services and run-to-completion tasks |
| `agentcore/` | AgentCore agents, one directory each; tools live in `cdk-app/lambda_functions/tool_functions/` |
| `packages/database/` | Prisma contract, migrations, and repositories |
| `packages/framework/` | Framework implementation partitioned into config, runtime, and local execution; generation/check scripts |
| `packages/api-contract/` | Browser-safe public routes and payload contracts |
| `local-api-dev-server/`, `local-ws-dev-server/`, `local-invocation-runner/` | Local execution |
| `agents/`, `.claude/skills/` | Agent procedures that reference the human guides |

## Local checks

Run commands from the repository root unless a guide says otherwise:

```powershell
npm ci
npm --workspace client-app run build
npm run verify
```

`verify` checks framework projections, regenerates ignored database artifacts,
checks committed GraphQL output without rewriting it, typechecks workspaces, and
runs schema and workspace tests. It needs no AWS credentials or running database.
Build the client before typechecking after a route change so its route tree exists.

After changing an authored contract, `npm run contract` regenerates the framework,
database, and GraphQL artifacts and typechecks consumers. Review generated changes,
then run `verify`. Neither command applies database migrations or deploys AWS.

`npm run workflows:inspect` prints each declared workflow: its steps, the workloads and
resources it uses, where each runs during development, and the bindings it needs before it
can be built. It is read-only and needs no AWS credentials.

AWS synth, deployment, live database checks, and browser smoke tests are separate
steps documented in the relevant deployment guide.

`npm run agents:inspect` prints each declared agent: where it runs, who may call it, and
the Gateway derived from its tools. It is read-only and needs no AWS credentials.
