# AGENTS.md

## Read the relevant guide

This is a TypeScript npm-workspace monorepo for AWS-backed applications. Start with
[README.md](README.md). Before changing an area, read its current source and guide:

| Area | Required guidance |
| --- | --- |
| Database -> GraphQL -> React Query | [Data features](docs/DATA-FEATURES.md) and the [automation contract](agents/typed-contract-propagation-agent.md) |
| Workload declarations, resources, CDK, local execution | [Framework](docs/FRAMEWORK.md) |
| Features spanning workloads: routes, events, tasks, workflows, resources | [Feature build procedure](agents/feature-build-agent.md) and [Framework](docs/FRAMEWORK.md) |
| Authentication or authorization | [Auth checklist](agents/auth.md) and its linked auth model |
| AgentCore agents and tools | [AgentCore](docs/AGENTCORE.md) and [Framework](docs/FRAMEWORK.md) |
| Development environment | [Development](docs/DEV-DEPLOYMENT.md) |
| Production release | [Production](docs/PROD-DEPLOYMENT.md) and [deployment procedure](agents/prod-deployment-agent.md) |

## Working rules

- Preserve unrelated working-tree changes. Use npm workspaces from the root and keep
  package-lock.json synchronized with manifest/dependency changes.
- Never hand-edit client-app/src/api/generated/, packages/database/src/generated/,
  packages/api-contract/src/generated/, packages/framework/src/generated/, or
  client-app/src/routeTree.gen.ts. Change source and run its generator.
- Treat auth, database access, uploads, secrets, and deployment as security-sensitive.
  Never commit env files, credentials, tokens, or CDK outputs. Avoid broad dependency
  upgrades or npm audit fix --force without the user's accepted scope.
- Every secret is one entry in framework-config/resources.ts: resource.secret("NAME") for
  a raw value authored only in cdk-app/.env, or a public ISecret field on a
  resource.stack<T>() entry for one a stack created, generated or imported. A container
  takes the contents with secrets: { NAME: resources.x.value } or .field("key"); a Lambda
  takes the ARN with environment: { NAME: resources.x.arn }, which also grants the read.
  npm run deploy uploads the authored values and supplies their ARNs; there is no separate
  sync step. Never put a secret value, or a hand-pasted ARN, in a config file, a generated
  file, or a template — and never expose a stack string built from a secret, because a
  public string field is a resource.
- Data-feature automation must follow the precise contract linked above. Every feature
  schema requires an explicit index import and a neighboring executable-schema test.
  Typechecking does not prove exposure, registration completeness, or authorization.
- Migration planning is offline. Database application, deployment, publication, and
  teardown are separate actions requiring authorization for the intended environment.
  Continue authorized source work after presenting planned SQL.
- Declare workloads only through literal framework-config section modules composed as
  arrays. Never add application routing/import tables to generic CDK or dev servers.
- Keep public paths, target ids, and deployed construct identities distinct. Preserve
  cloud.constructId, stack scopes, historical AsynchronousLambdaFunctionsStack identity,
  and stack-prefixed output names; compare logical ids when moving infrastructure.
- Call runTask/startWorkflow through declared bindings, and push to WebSocket clients
  with webSocketConnections(event) from @repo/framework/runtime/websocket. Do not
  hand-author descriptor variables or branch on environment to select local versus AWS
  transport.
- An HTTP handler that needs a user is `authenticated(async (event, session) => ...)`; an
  event declared `localReplay: true` exports `withLocalReplay(handler)`. framework:check
  enforces the second.
- A workflow value is a reference, not a value. Branch with when/choose and compute with
  expr; never use a JavaScript condition, coercion, template literal, spread or await on a
  step's output. Bind integration references beside their construct in application CDK,
  before workflows are constructed.
- Keep same-origin /api, Vite base=/, the Rust-free Prisma runtime, and the root esbuild
  pin. Auth and deployment invariants are detailed in Framework.
- Docker images own dependencies/generated database artifacts. Watch excludes host
  node_modules, env files, and generated database files. Never mount the whole checkout
  over image dependencies. Preserve postgres_data. Keep the lockfile's native bindings for macOS arm64, Linux arm64
  and x64 (glibc), and Windows x64; `npm run verify` checks them. Change the lockfile only
  with npm 11, because npm 10 strips its `libc` fields.

## Verification and handoff

Run `npm run verify` after changes. It checks generated framework/GraphQL artifacts,
regenerates ignored database artifacts, typechecks workspaces, and runs schema/workspace
suites without AWS or a database. Build client-app before typechecking after route changes.
For data changes, follow the automation contract's regeneration/build sequence.

For infrastructure changes, synth both explicit local and prod modes as documented in
Framework. Offline verify does not substitute for synth, browser, Docker, or live database
checks. Report changes, checks actually run, remaining unverified behavior, and any
migration/deployment action left to the user. Do not restore deleted user files to pass checks.
