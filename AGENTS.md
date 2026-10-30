# AGENTS.md

## Read the relevant guide

This is a TypeScript npm-workspace monorepo for AWS-backed applications. Start with
[README.md](README.md). For product orientation read [AWS Studio](docs/AWS-STUDIO.md);
[the documentation index](docs/README.md) separates current guides from historical plans.
Before changing an area, read its current source and guide:

| Area | Required guidance |
| --- | --- |
| Studio interface, graph, source editing or operations | [Knowledge router](docs/aws-studio-knowledge/README.md), then the relevant source-linked subsystem page |
| Database -> GraphQL -> React Query | [Data features](docs/DATA-FEATURES.md) and the [automation contract](docs/playbooks/typed-contract-propagation.md) |
| Workload declarations, resources, CDK, local execution | [Framework](docs/FRAMEWORK.md) |
| Features spanning workloads: routes, events, tasks, workflows, resources | [Feature build procedure](docs/playbooks/feature-build.md) and [Framework](docs/FRAMEWORK.md) |
| Authentication or authorization | [Auth checklist](docs/playbooks/auth.md) and its linked auth model |
| AgentCore agents and tools | [AgentCore](docs/AGENTCORE.md) and [Framework](docs/FRAMEWORK.md) |
| Development environment | [Development](docs/DEV-DEPLOYMENT.md) |
| Repository cleanup, generated output or artifact retention | [Repository hygiene](docs/REPOSITORY-HYGIENE.md) |
| Production release | [Production](docs/PROD-DEPLOYMENT.md) and [deployment procedure](docs/playbooks/prod-deployment.md) |

For architecture-sensitive changes, use the [AWS Studio knowledge router](docs/aws-studio-knowledge/README.md)
to load the smallest relevant context, verify critical contracts against source, and
update affected knowledge pages when those contracts change.

## Working rules

- Preserve unrelated working-tree changes. Use npm workspaces from the root and keep
  package-lock.json synchronized with manifest/dependency changes.
- Put disposable browser evidence in ignored `output/playwright/<task>/`; keep tests,
  fixtures and golden screenshots in their existing source locations. Before cleanup,
  follow the hygiene guide: `.cache/` and `.framework/` also hold private inputs,
  recovery journals and deployment state, so never treat either as a blanket purge.
- Never hand-edit client-app/src/api/generated/, packages/database/src/generated/,
  packages/api-contract/src/generated/, packages/framework/src/generated/,
  docker-compose.services.yml, or client-app/src/routeTree.gen.ts. Change source and run
  its generator. A service's local container comes from its declaration and
  `x-framework-service` in docker-compose.yml; customize one in docker-compose.override.yml
  or by declaring it in docker-compose.yml.
- Treat auth, database access, uploads, secrets, and deployment as security-sensitive.
  Never commit env files, credentials, tokens, or CDK outputs. Avoid broad dependency
  upgrades or npm audit fix --force without the user's accepted scope.
- Every secret is one entry in framework-config/resources.ts: resource.secret("NAME") for
  a raw value authored only in cdk-app/.env.<mode>, or a public ISecret field on a
  resource.stack<T>() entry for one a stack created, generated or imported. A container
  takes the contents with secrets: { NAME: resources.x.value } or .field("key"); a Lambda
  takes the ARN with environment: { NAME: resources.x.arn }, which also grants the read.
  npm run deploy:resources uploads the authored values and supplies their ARNs; there is no separate
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
- A workload reaches the database only by declaring `database: true`; framework.config.ts
  names the imported `defineDatabase` declaration in framework-config/databases/<id>/index.ts,
  which owns its native resource, VPC, subnet and PostgreSQL policy. It logs in with IAM,
  never a database password or secret. Every networked Lambda declares an imported `vpc`
  beside `subnet` (private/isolated); every container declares `cloud.vpc` beside
  `cloud.subnet` (public/private). VPC references are never inherited. Register literal
  `networks: [applicationVpc, ...]` from framework-config/networks/<id>/index.ts; each
  declaration owns its NAT, egress-only gateway and endpoints. Keep network IDs and
  cloud.constructId stable. Never set CDK vpc, subnets or security groups on framework
  workloads by hand. Native application resources use `frameworkVpc(this, importedVpc)`;
  only production builds VPCs, lazily when used. Cross-VPC database access is rejected;
  no automatic peering exists. Compose networking remains shared; existing local Lambda
  egress rules use the selected VPC. A custom SDK endpoint in a VPC Lambda passes
  `useDualstackEndpoint: false`.
- Call runTask/startWorkflow through declared bindings, and push to WebSocket clients
  with webSocketConnections(event) from @repo/framework/runtime/websocket. Do not
  hand-author descriptor variables or branch on environment to select local versus AWS
  transport.
- An HTTP handler that needs a user is `authenticated(async (event, session) => ...)`, and
  its declaration says `userPool: true` (an `auth: true` tool or agent needs neither); an
  event declared `localReplay: true` exports `withLocalReplay(handler)`. framework:check
  enforces both. Never hand-write USER_POOL_ID or USER_POOL_CLIENT_ID for the
  application's own pool.
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
- Local images are reclaimed by reconciliation (Development, Local images): the runner keeps
  each declared target's current image and anything in use, and dev:containers prunes its
  Compose project's superseded images. Runner images are named `matts-framework-*`, its
  containers `matts-task-*`/`matts-lambda-*`; both carry com.matts-aws-framework labels
  (images: kind/project/target), and a new build or run path must too. Cleanup
  stays scoped to labels and unforced. Never add `docker system prune`, an unfiltered
  `image prune -a`, `--force` on image removal, or `builder prune` to automation.

## Verification and handoff

Run `npm run verify` after changes. It checks generated framework/GraphQL artifacts,
regenerates ignored database artifacts, typechecks workspaces, and runs schema/workspace
suites without AWS or a database. Build client-app before typechecking after route changes.
For data changes, follow the automation contract's regeneration/build sequence.

For infrastructure changes, synth both explicit local and prod modes as documented in
Framework. Offline verify does not substitute for synth, browser, Docker, or live database
checks. Report changes, checks actually run, remaining unverified behavior, and any
migration/deployment action left to the user. Do not restore deleted user files to pass checks.
