# framework-config & framework.config.ts: Structure Report

Oct 21, 2026 · @Matthew

## Summary

`framework.config.ts` is a 64-line composition root. It declares no workload itself. It imports named exports from `framework-config/` and passes them to `defineFrameworkConfig`: one array per invocation kind (`http`, `webSocket`, `events`, `services`, `tasks`, `workflows`, `tools`, `agents`), plus five singletons (`resources`, `defaults`, `networks`, `database`, `userPool`).

`framework-config/` holds the declarations: 23 files and about 860 lines. Each workload module is a plain object literal keyed by target id and checked with `satisfies <Kind>Section`. The supporting modules are the resource catalog, defaults, network and database declarations, shared fragments, and two data files that Framework Studio edits.

The shape has four jobs:

- Let tooling find every workload by reading source, without running application code.
- Let several authors, human or agent, add surfaces in parallel without touching the same lines.
- Keep the CDK's construct identities stable.
- Keep secrets and network placement explicit. The sections below show where each job lands in the code and which parts a refactor can safely change.

## Layout

The files fall into four groups. Workload sections are named by invocation kind. Infrastructure singletons are named by what they declare. Shared fragments are spread into sections. Studio data files are never passed to `defineFrameworkConfig`.

| Path | Group | Holds | Read by |
| --- | --- | --- | --- |
| `framework.config.ts` | Root | `defineFrameworkConfig({...})`; re-exports `resources` | CDK app, tests, generators, Studio |
| `http/auth.ts` | Workload section | 6 Cognito session routes (`/sign-in`, `/mfa`, ...) | root |
| `http/graphql.ts` | Workload section | `/graphql` | root |
| `http/examples.ts` | Workload section | `/examples/python` (container packaging) | root |
| `http/tasks.ts`, `http/workflows.ts` | Workload section | Starters bound with `runsTask` / `startsWorkflow` | root |
| `websocket/routes.ts` | Workload section | `$connect` (+ authorizer), `$default`, `$disconnect`, `customAction` | root |
| `events/cognito.ts` | Workload section | 3 Cognito triggers | root |
| `events/invocation-tests.ts` | Workload section | `invocation-test-step` (a Step Functions step) | root |
| `services/example.ts` | Workload section | `/example-service/*` ECS service | root |
| `tasks/database.ts`, `tasks/invocation-tests.ts` | Workload section | `db-migrate`, `invocation-test-task` | root |
| `workflows/invocation-tests.ts` | Workload section | `invocation-test-workflow` graph | root |
| `tools/example.ts`, `agents/example.ts` | Workload section | 2 Gateway tools, `example-agent` | root |
| `resources.ts` | Singleton | Resource catalog: 3 stacks, 2 secrets, 4 env inputs | root, sections, CDK stacks |
| `defaults.ts` | Singleton | Lambda, container, database-pool and WebSocket defaults | root |
| `networks/application/index.ts` | Singleton | `applicationVpc` (`NetworkStack`) | root, sections, database |
| `networks/test/index.ts` | Singleton | `studioTestVpc`, written by Studio | root |
| `databases/application/index.ts` | Singleton | `applicationDatabase` on `applicationVpc` | root, `rds-stack.ts` |
| `contracts.ts` | Shared fragment | `HttpSection`, `EventsSection`, ... bound to `typeof resources` | every section |
| `models.ts` | Shared fragment | Model env vars, Bedrock IAM, OpenAI key requirement | `agents/example.ts` |
| `descriptions.ts` | Studio data | Inspector text keyed by map entity id | Studio only |
| `client-environment.ts` | Studio data | `VITE_*` bindings per mode | Studio, client env export |

The groups are not visible in the tree. Workload folders, singletons, fragments and Studio data all sit side by side at the top of `framework-config/`.

## framework.config.ts

The root file only composes. Its own doc comment says so: *"This file composes rather than declares."* All of its logic sits in `defineFrameworkConfig` (packages/framework/src/config/index.ts line 2427).

What the call receives and does:

| Key | Value in this repo | What `defineFrameworkConfig` does with it |
| --- | --- | --- |
| `resources` | re-exported from `resources.ts` | Passed through. Section types are derived from it. |
| `defaults` | `defaults.ts` | Passed through. Applied before section and entry overrides. |
| `networks` | `[applicationVpc, studioTestVpc]` | Builds a registry (`networkRegistry`). Any `vpc` a workload names must be registered here. |
| `database` | `applicationDatabase` | Checks the reference and that its `vpc` is registered. |
| `userPool` | ids read off `resources.cognito` | Checks the shape. It is handed to `userPool: true` workloads and `auth: true` tools and agents. |
| `http`, `webSocket`, `events`, `services`, `tasks`, `workflows`, `tools`, `agents` | arrays of section modules | `mergeSection`: flattens each array into one map, throwing if two modules declare the same key. |

After merging, `normalizeFrameworkConfig` runs eagerly. It validates target identities and checks that no two entries share a source directory.

Three details in the file matter for a refactor:

- **Re-exporting `resources`.** Section modules import `resources.ts` directly. Importing it through the root would create a cycle: root → section → root.
- **Removed keys throw.** `network` (singular) and `gateways` raise migration errors. Old shapes fail loudly instead of being silently ignored.
- **Generic over the input.** `defineFrameworkConfig<const Input>` keeps route keys, methods and directories as literal types. `@repo/api-contract` projects them into `HttpRoutePaths`, `AuthenticatedHttpPath` and similar types. Widening the input type, or building sections dynamically, would break those generated contracts.

## Workload sections

Every workload module has the same shape:

```ts
export const authRoutes = {
  "/sign-in": { directory: "...", methods: "*", userPool: true, ... },
} satisfies HttpSection;
```

### What a key means depends on the section

The three identities AGENTS.md keeps apart are a public path, a target id and a construct id. Which of them a key holds depends on the section:

| Section | Key is | Source directory | Example key → target id |
| --- | --- | --- | --- |
| `http` | Public path under `/api` | Declared explicitly | `/oauth/callback` → `oauth-callback` (last segment of `directory`) |
| `services` | Public mount, `/*` catch-all | Declared explicitly | `/example-service/*` → `example-service` |
| `webSocket` | API Gateway route key | Declared explicitly | `$connect` → `ws-connect-route` |
| `events` | Target id | Defaults to `/lambda_functions/event_functions/<id>` | `cognito-custom-message` |
| `tasks` | Target id | Defaults to `/ecs_containers/tasks/<id>` | `db-migrate` |
| `tools` | Target id | Declared here; default is `/lambda_functions/tool_functions/<id>` | `add-numbers` |
| `agents` | Target id | Declared here; default is `/agents/<id>` | `example-agent` |
| `workflows` | Target id | None: the graph is the declaration | `invocation-test-workflow` |

The construct id is a third identity. It is derived from the target id unless `cloud.constructId` pins it. Pinned ids (`OAuthCallback`, `GraphQLApi`, `ConnectRouteFunction`, `CognitoPreSignUpTrigger`, ...) are CloudFormation logical ids of resources that already exist. Changing one replaces the function. The defaults live in conventions.ts.

### Why `satisfies` and not a type annotation

`satisfies HttpSection` checks the entry against the framework's schema and keeps its literal type. `const x: HttpSection = ...` would widen keys to `string` and erase what the generated route contracts read. `contracts.ts` binds each section type to `typeof resources`, so `resources.cognito.trustedOriginsCsv` type-checks inside an entry. The binding lives in its own file because every section imports it and it must not import a section back.

### What the static reader refuses

config-source.ts parses the root and follows each section one import away. It fails `framework:check` when:

- A section array element is not imported by a relative path.
- A module does not export a `const` object literal. `satisfies`, `as` and parentheses are unwrapped.
- A key is computed, or an entry comes in through a spread (`{ ...a, ...b }`). A spread can silently drop a key before any runtime check sees it.
- Two modules declare the same key. The error names both files.
- `defineFrameworkConfig` receives a spread, or `networks` is not a literal array of exported `defineNetwork({ id: "..." })` consts.

Spreads *inside* an entry's value are fine. `environment: { ...authEndpointEnvironment }` and `...models.environment` both pass.

### Per-entry controls

An entry overrides `defaults.ts` field by field: `memorySize`, `timeoutSeconds`, `bundling`, `subnet`/`vpc`, `packaging`. AWS-only settings go under `cloud`: `constructId`, `outputs`, `bindings`, `access`, `cpu`, `memoryMiB`. Cross-target permissions come from typed helpers rather than IAM strings: `runsTask("invocation-test-task")`, `startsWorkflow(...)`, `resources.cognito.userPool.grant(...)`. `deploy` (`"both"`, `"local-only"`, `"cloud-only"`) controls where a target exists. `events` has no `deploy` key, because the trigger's owner wires it.

## Resources and secrets

`resources.ts` is the one place a workload's external values are named. Every value has exactly two possible origins. The framework deliberately refuses a third: "declare here, supply somewhere else".

| Origin | Written as | Value comes from | Entries in this repo |
| --- | --- | --- | --- |
| A CDK stack | `resource.stack<CognitoStack>()` | The stack's public fields, under their own names. The stack's constructor ends with `linkResources(this, resources.cognito)`. | `referenceExamples`, `cognito`, `rds` (prod only) |
| Authored env line | `resource.fromEnv("NAME")`, with optional `.enum()` and `.default()` | `cdk-app/.env.<mode>`, the only input file a deployment reads | `langgraph.*` (4 model settings) |
| Authored secret | `resource.secret("NAME")` | `cdk-app/.env.<mode>`, uploaded by `npm run deploy:resources` | `openaiApiKey`, `googleClientSecret` |

The design choices behind it:

- **The stack class is the declaration.** Renaming `CognitoStack.userPoolDomainUrl` breaks the build here, not at deploy time. The CDK types are imported with `import type`, because a value import would pull all of `aws-cdk-lib` into the dev servers and the invocation runner.
- **References are data.** `defineResources` turns each entry into a branded `ResourceReference` holding its catalog path. Importing the config resolves no infrastructure and reads no `process.env`. That is what lets the browser bundle, Studio and tests import it.
- **Absent, not conditional.** `rds: PROD_DEPLOYMENT ? resource.stack<RdsStack>() : undefined` keeps the key in both graphs. Consumers still compile, and a dev workload simply gets no variable. Resources never carry a deployment mode.
- **Secrets are projected, never read bare.** A Lambda takes `.arn` in `environment`, which also grants the read. A container takes `.value` or `.field("key")` in `secrets`. `models.ts` uses `OPENAI_API_KEY_SECRET_ARN: resources.openaiApiKey.arn`.
- **Re-exported from the root.** Sections import `resources.ts` directly. CDK stacks import it to call `linkResources`. Neither can go through `framework.config.ts` without a cycle.

`models.ts` is a fragment built on the catalog: environment variables, Bedrock and Mantle IAM, and a `requirements` rule (provider `openai` needs `openaiApiKey`). It exists because forgetting it fails late, on the deployed Runtime's first turn. `cdk-app/test/langgraph-model-providers.test.ts` guards it.

## Networks and databases

Networks and the database are imported values, not section entries. Each lives in its own folder, `networks/<id>/index.ts` or `databases/<id>/index.ts`, as an exported `defineNetwork(...)` or `defineDatabase(...)` const. Studio refuses to edit a database declared anywhere else.

### Networks

- **An explicit registry, no default VPC.** `networks: [applicationVpc, studioTestVpc]` is the registry. `resolveNetwork` rejects any `vpc` that is not the registered object with the same `constructId`.
- **Placement is never inherited.** Every networked Lambda says `vpc: applicationVpc` beside its `subnet` or `database: true`. Every container says `cloud.vpc`. Seven entries import `applicationVpc` today: `/oauth/callback`, `/graphql`, `cognito-post-confirmation-trigger`, `example-service`, `db-migrate`, `invocation-test-task`, and the database.
- **Two spellings of one idea.** A Lambda's `vpc` sits at the top level and a container's sits under `cloud`. This is probably because local Lambda egress rules follow the selected VPC, while containers share Compose networking locally. That reason is inferred from AGENTS.md, not from a code comment.
- **Stable identity.** `application` pins `cloud.constructId: "NetworkStack"`, the legacy stack, and `networkConstructId` keeps its old construct scopes. A new network derives `<Id>NetworkStack`. Changing `cidr` or `zones` renumbers every subnet.
- **Cost lives in comments.** `natGateway`, `interfaceEndpoints` and `defaults.container.subnet` carry dollar figures in their comments. The cost of each choice is explained where the choice is made.
- **Built lazily.** Only a production deployment builds a VPC, and only once a workload is placed in it.

`networks/test/index.ts` stands apart from the rest. It was written by Studio (quoted JSON keys, all on one line, no doc comment) and was committed in `b135e2e` today. Its import is line 1 of the root, above `defineFrameworkConfig`'s own import. It is registered, but no workload or database references it, so nothing builds it.

### Database

`database: applicationDatabase` is a singleton: one database per config. The declaration names:

- the stack field it is built from (`resources.rds.database`, which is `undefined` outside prod),
- its own `vpc` and `subnet` (`"isolated"`; `"public"` is refused),
- `engine: "postgres"`, `databaseName`, and literal RDS `settings`.

A workload reaches it only by `database: true`, or `database: { connection: "direct" }` for `db-migrate`. It logs in with IAM; there is no password anywhere in config. Its VPC must be the database's VPC, because cross-VPC access is rejected and there is no peering. `DATABASE_*` inputs and CDK context still override `settings`, as the declaration's comment explains.

Locally none of this is built. Compose Postgres stands in, which is why the comments keep saying "production only".

## Why it is structured this way

Most of the shape follows from one fact. The config is **read as source before it is run**, by tools that need its keys before they can type it. Each choice below traces back to a specific consumer.

| Choice | The constraint behind it | What breaks if you drop it |
| --- | --- | --- |
| Root composes; modules declare | A new API surface is a new file. Two authors, or two agents in one checkout, never edit the same lines. | Merge conflicts in one large file. Studio's per-file splices collide. |
| Sections as arrays, never `{ ...a, ...b }` | A spread silently keeps one of two equal keys. Arrays let `mergeSection` (by position) and `config-source.ts` (by file) both report the collision. | A duplicate route quietly wins by import order. |
| Exported `const` object literal, one relative import away | `framework:generate` reads workflow ids and section keys statically, *before* importing the config. The config is typed against the `target-ids` union that run is about to write. | Chicken-and-egg: a new target is missing until a second run, or the generator can't run at all. |
| Literal keys, no computed keys | Keys are identities (path, route key, target id). Static collision checks and Studio's span-precise edits need to see them. | `framework:check` fails. Studio refuses to edit. |
| `satisfies <Kind>Section` | Validates against the schema while keeping literal types for `@repo/api-contract` (`API_ROUTE`, authenticated-path unions). | Route types widen to `string`. Client routing loses type safety. |
| `contracts.ts` binds section types to `typeof resources` | Resource references are typed by catalog path, so a misspelt `resources.cognito.x` fails to compile. | Untyped references, or a cycle if sections typed themselves off the root. |
| `resources.ts` separate, re-exported by root | Sections and CDK stacks both import it. Neither may import the root. | Import cycle root → section → root. |
| `import type` for CDK stacks in `resources.ts` | Dev servers, the invocation runner, Studio's evaluator and the browser load the catalog. | Each of them pulls in all of `aws-cdk-lib`. |
| Folders named by section (`http/`, `events/`, ...) | Mirrors `cdk-app/lambda_functions/*_functions`. Studio creates new modules at `framework-config/<section>/<id>.ts`. | Nothing enforced. Discoverability and Studio's default placement drift apart. |
| `networks/<id>/`, `databases/<id>/` folders of explicit imports | No implicit VPC. Every placement is a reference you can follow. Studio locates the database by that path. | Studio refuses database edits. Placement becomes ambient. |
| Pinned `constructId`, `outputs` ids, `NetworkStack` | These are CloudFormation logical ids and export names of deployed resources. | Replacement or deletion of live infrastructure on the next deploy. |
| Mode as `undefined` entries, not per-resource flags | One config compiles for both graphs. The dev graph is a subset of the prod graph. | Mode checks leak into every consumer. |
| Long comments with costs and traps | The config is the human-facing control surface. Traps are explained where the choice is made. | Expensive or broken choices (NAT, private Fargate, a renamed construct) look harmless. |

## Consumers

&#91;embedded content: config consumers · static pass, then runtime pass\]

Two passes read the same files. The static pass (config-source.ts) parses source and never executes it. It feeds the generator, `framework:check` and Studio's edit index. Its output, the `target-ids` union, is what `framework.config.ts` is typed against: the dashed loop. The runtime pass imports the config and is what CDK, the local lane and the scripts run on.

Studio sits on both sides. Its source index cross-checks every literal it would edit against the value its evaluator computed. If the two disagree, it refuses to edit. A refactor that makes a value non-literal, such as a computed setting or a helper call, turns that field read-only in Studio without failing any check.

## Refactor guide

File layout is mostly free to change. Module *shape*, a few hard-coded paths and every deployed identity are not.

### Invariants and what enforces them

| Must stay true | Enforced by | If you break it |
| --- | --- | --- |
| Each section module is an exported `const` object literal with literal keys and no key spreads, one relative import from the root | `config-source.ts` via `framework:check`; Studio's source index | `verify` fails; Studio goes read-only |
| Root passes sections as literal arrays, with no spread into `defineFrameworkConfig` | `config-source.ts`; Studio creation ("Compose workload sections as literal arrays") | Same |
| `framework.config.ts` sits at the repo root and default-exports the result | `findRepositoryRoot`, Studio evaluator, every dev server and script | Nothing can find the config |
| `framework-config/contracts.ts` stays one level above section files | Studio creation writes `import type { ... } from "../contracts"` (`edits/creation.ts` line 127) | Studio-created modules don't compile |
| `framework-config/resources.ts` keeps its path | Studio creation and resource edits read and write it by path | Studio resource edits fail |
| `databases/<id>/index.ts` | `framework-studio/server/source/database.ts` line 40 | Studio refuses database edits |
| Every file Studio edits stays under `framework-config/` | `assertWritable` in `framework-studio/server/files.ts` | Studio refuses the write |
| `cloud.constructId`, `outputs` ids, network `NetworkStack`, network and database `id`s | CloudFormation logical ids | Live resources replaced |
| `resources.ts` imports CDK stacks with `import type` only | Convention, plus dev-server load time | `aws-cdk-lib` loads in browser and dev processes |

Moving `descriptions.ts` or `client-environment.ts` costs one constant each: `DESCRIPTION_FILE` in `framework-studio/shared/descriptions.ts`, and `CLIENT_ENVIRONMENT_FILE` in `scripts/client-environment-mapping`.

### Pain points and options

1. **The top level mixes four kinds of file.** Workload folders, singletons, fragments and Studio data sit side by side. Option: move `models.ts` into a `shared/` folder, and `descriptions.ts` plus `client-environment.ts` into a `studio/` folder (update the two constants). Keep `contracts.ts` and `resources.ts` where they are.
2. **Features are split by invocation kind.** The invocation-test feature spans 5 files: `events/`, `tasks/`, `workflows/`, `http/tasks.ts` and `http/workflows.ts`. The locator allows a feature module that exports several section consts (for example `invocationTestEvents`, `invocationTestTasks`, `invocationTestWorkflows`), each listed in its own root array. Studio-created entries would still land in `<section>/<id>.ts`, so you would end up with two layouts.
3. **`TRUSTED_FRONTEND_ORIGINS: resources.cognito.trustedOriginsCsv` is repeated across 8 entries in 3 files.** `auth.ts` already factors it into a local const. A shared fragment like `models.ts` would centralise it. Leave `userPool: true` on each entry: `framework:check` pairs it with `authenticated()` handlers, and the explicitness is deliberate.
4. **VPC placement has two spellings**: `vpc` for Lambdas and `cloud.vpc` for containers. Unifying them is a framework schema change in `packages/framework/src/config/index.ts`, not a config-only refactor.
5. **`studioTestVpc` is registered but unused.** It is Studio-formatted, and its import sits at line 1 of the root. Remove it through Studio's delete (the creation tests cover removal), or delete the file and its `networks` entry by hand. Studio will put future imports at the top again.
6. **Mode branching outside the catalog.** `graphql.ts` reads `PROD_DEPLOYMENT` for GraphiQL. That is allowed, but it is the only workload entry that does. You could move it to a `resource.fromEnv` with a default to keep mode logic in `resources.ts`.
7. **A small redundancy.** `events/invocation-tests.ts` sets `timeoutSeconds: 10`, which equals `defaults.lambda.timeoutSeconds`.

### Safe sequence

1. Baseline: `npm run verify`, then synth both modes as docs/FRAMEWORK.md describes, and keep the templates' logical ids for comparison.
2. Do pure moves and renames of section *files* and export names first, one group per commit. Run `npm run framework:check` after each. These don't touch identities.
3. Extract shared fragments (points 3 and 6). Check that generated contracts are unchanged (`framework:check` runs `--check`).
4. Make Studio-coupled moves (point 1) together with their constant changes. Run `framework-studio`'s tests.
5. Change schema or identity last, if at all (point 4, or any `constructId`). Compare logical ids against the baseline synth before any deploy.
6. Finish with `npm run verify` and both synths. Restart `npm run studio`. While `dev:containers` is running, config edits restart live containers.
