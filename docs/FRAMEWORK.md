# Framework

`framework.config.ts` is the composition root. It imports defaults, the resource catalog,
and literal section modules under `framework-config/`. Those declarations drive CDK,
local execution, and generated browser route/payload contracts.

Start with the [declaration directory guide](../framework-config/README.md) for file
ownership and [declarations and tags](framework-studio/declarations-and-tags.md) for
tag validation, inheritance, AWS propagation and Studio authoring.

Use [Development](DEV-DEPLOYMENT.md) or [Production](PROD-DEPLOYMENT.md) to run the system.
Use [Data features](DATA-FEATURES.md) for changes inside the existing GraphQL endpoint.
Use [AgentCore](AGENTCORE.md) for the `agents` and `tools` sections: agents, the tools they
call through their derived Gateways, and the browser and local lanes for both.

## Package boundaries

There are three shared packages:

| Package | Responsibility |
| --- | --- |
| `@repo/framework` | Configuration machinery, backend runtime, local execution, and generation |
| `@repo/api-contract` | Browser-safe public routes and payload contracts |
| `@repo/database` | Storage contract, migrations, records, and repositories |

The framework is one workspace with explicit partitions:

```text
packages/framework/
  src/config/     Definitions, validation, normalization, projections
  src/runtime/    Backend invocation, auth, HTTP, connections, replay
  src/local/      Development execution, discovery, workflow interpreter
  src/generated/ Generated target ids and replay manifest
  scripts/       Generation and local checks
  test/          Import and bundle boundary tests
```

Use `@repo/framework/config` to author declarations and `@repo/framework/local` for
local execution. `@repo/framework/config/source` provides Node-only source discovery
for tooling/CDK. The config entry point itself remains browser-safe. These modules
share one dependency manifest; their explicit exports and bundle tests keep their
execution boundaries separate. There is no package-root barrel.

Browser forms that only validate metadata use `@repo/framework/config/tags` or
`@repo/framework/config/database`. These expose the same canonical validators without
loading unrelated declaration machinery.

Application section types derive from the complete resource catalog in
[framework-config/contracts.ts](../framework-config/contracts.ts), beside the resource
catalog. Import these with `import type`. Keep every export in that file type-only;
it must never execute the workload configuration or import CDK values.

Backend code imports the module it uses:

| Entry point | Use |
| --- | --- |
| `@repo/framework/runtime/invocation` | runTask/startWorkflow and invocation descriptors/context |
| `@repo/framework/runtime/agentcore` | `agent()` for an agent's entry point, and `invokeAgent` for a workload calling one |
| `@repo/framework/runtime/tools` | `tool()` and `authenticatedTool()` for an AgentCore tool's handler |
| `@repo/framework/runtime/auth` | Cognito ID-token verification and authenticated sessions |
| `@repo/framework/runtime/http` | HTTP responses, cookies, and trusted browser origin checks |
| `@repo/framework/runtime/database` | Database connection URL/Secrets Manager resolution |
| `@repo/framework/runtime/callbacks` | Completing, failing and heart-beating a workflow callback |
| `@repo/framework/runtime/event-replay` | Event capture and replay queue handling |
| `@repo/framework/local/origins` | Shared local browser origin validation |

For example:

```ts
import { defineFrameworkConfig } from "@repo/framework/config";
import { runTask } from "@repo/framework/runtime/invocation";
import { jsonResponse } from "@repo/framework/runtime/http";
```

Keep runtime entry points independent so an HTTP helper does not load invocation,
replay, or configuration machinery. Client code uses api-contract; runtime and local
execution modules are server-only. Normal data-feature work uses database, the GraphQL
feature directory, and frontend operations without changing these package boundaries.

## Adding a workload

| Kind | Declaration key | Implementation | Working example |
| --- | --- | --- | --- |
| HTTP Lambda | Public path in http | Explicit directory under cdk-app | [graphql](../framework-config/workloads/http.ts) |
| WebSocket Lambda | API Gateway route key in webSocket | Explicit directory; authorizer belongs to connect | [routes](../framework-config/workloads/websocket.ts) |
| Event Lambda | Stable target id in events | Defaults to /lambda_functions/event_functions/id | [Cognito](../framework-config/workloads/events.ts) |
| Service | Public mount in services | /ecs_containers/services/id; its Compose container is [generated](#local-service-containers) | [example-service](../framework-config/workloads/services.ts) |
| Task | Stable target id in tasks | Defaults to /ecs_containers/tasks/id | [database migration](../framework-config/workloads/tasks.ts) |
| Workflow | Stable target id in workflows | Graph declaration; no implementation directory | [test-only graph](../local-invocation-runner/test/workflow-engine.test.ts) |
| AgentCore tool | Stable target id in tools | Explicit directory under cdk-app, with contract.ts | [add-numbers](../framework-config/workloads/tools.ts) |
| AgentCore agent | Stable target id in agents | Explicit directory under agents at the repository root, with contract.ts | [example-agent](../framework-config/workloads/agents.ts) |

1. Add the implementation. A TypeScript Lambda is its `index.ts`: cdk-app's typecheck
   checks every handler under `lambda_functions` in one pass
   ([its tsconfig](../cdk-app/lambda_functions/tsconfig.json)), and Compose Watch delivers
   the new directory to the running dev servers. Give a handler its own `package.json` only
   when it brings a package the repository does not install, or needs a different version
   of one: npm then nests that version under the handler and esbuild bundles it. That
   manifest needs `npm install` (npm 11) and a restart of `npm run dev:containers`, because
   the image installs it. Either way, each Lambda deploys as its own esbuild bundle of what
   its handler imports, so a manifest changes neither bundle size nor cold start.
2. Declare a literal entry in a section, using `satisfies HttpSection` (or the matching
   section type) imported type-only from `framework-config/contracts.ts` (for example,
   `import type { HttpSection } from "../contracts"` in framework-config/workloads/http.ts).
3. The canonical kind module is already registered in root framework.config.ts. If you
   deliberately split a large section, import the additional module into its literal array.
4. Declare environment, permissions/bindings, and deploy scope with the workload.
5. Run `npm run framework:generate` and `npm run verify`; exercise the local route.
   Infrastructure changes also require both synth paths and deployment review.

Compose sections as arrays, never object spreads. A spread can erase a duplicate key
before validation sees it. Shared objects inside one entry, such as environment mappings,
may be spread. Do not add application handler lists to framework stacks or dev servers.

### Paths and identity

`directory` uses forward slashes relative to cdk-app; its leading slash is a framework
path, not an OS root. A routed target's id defaults to its directory basename; explicit
id can preserve identity through a move. Event/task/workflow keys are target ids. A
public route rename must not rename the target or its deployed constructs.

HTTP routes are literal paths. Services may use a terminal `/*` mount: /example-service/*
includes /example-service and descendants. Path parameters, trailing/duplicate slashes, and
ambiguous path/method overlaps are rejected. Different methods may share a path.
Routes are case-sensitive; unmatched methods/paths return API Gateway-style 404 locally.
The local proxy strips a service's public mount before forwarding to its container.

Agent ids are separate from browser routes. Declare `route: "/chat/support"` on an
`auth: true` agent to expose that exact same-origin path, with no automatic prefix;
omit `route` for workload-only invocation. HTTP/service keys still appear under `/api`.
Shared validation rejects duplicate agent routes and agent overlap with HTTP/service
browser paths, including wildcard mounts and disabled deployment lanes. Agent collisions
are path-based regardless of HTTP method because CloudFront selects an origin by path.

Frontend consumers use `API_ROUTE["/graphql"]` from @repo/api-contract. A service mount's
value is its prefix. The generated route union includes all declared routes regardless
of deploy scope; deploy toggles must not break frontend typechecking.

### Build and deployment scope

Lambda defaults cascade from defaults.lambda, through section defaults, to the entry.
Runtime, packaging, architecture, memory, timeout, and bundling belong in config.
Container Lambdas and tasks use their own Dockerfile; zip handlers are bundled. Source
and pinned architecture are shared by AWS and local execution. Keep the root esbuild
pin so CDK can bundle locally without an unintended Docker fallback.

Task and service architecture inherits `defaults.container.architecture` in
`framework-config/defaults.ts`, with `x86_64` as the framework fallback. A target
can override it with `cloud.architecture` in its workload section. Lambda
architecture inherits `defaults.lambda.architecture` and can be overridden by
the section or target. Both the container image platform and ECS runtime are
always pinned to the resolved architecture, independent of the build host.

`deploy` is one of both, local-only, cloud-only, or none. It says where a target is enabled.
Tools infer these lanes from the agents that list them and do not accept `deploy`:
a shared tool runs in the union of its consuming agents' lanes, and an unused tool
runs in neither.
Deployment mode separately says what the AWS graph constructs:

| Surface | Dev AWS graph | Prod AWS graph |
| --- | --- | --- |
| Cognito and declared AWS-invoked event Lambdas | Yes | Yes |
| Replay infrastructure | Yes | No |
| Website, RDS, HTTP gateway | No | Yes |
| Routed Lambdas, services, tasks, workflows | No; execute locally | If cloud-enabled |
| WebSocket API and its handlers | When DEPLOY_PROD_WEBSOCKET_API is on | When DEPLOY_PROD_WEBSOCKET_API is on |
| Network (VPC) and database | No | Once a Lambda has a `subnet` or `database: true`, or a container is built |

Events are invoked by AWS and do not have a per-target deploy toggle. A dev deployment
publishes no task/service images. Compose independently runs targets enabled in the local
lane. The example service currently opts into local-only; change its declaration to deploy it in AWS.

A deployed service sits behind an internal load balancer that the HTTP API reaches over a
VPC link, so the route's `auth: true` is the only way in, exactly as through the local
proxy. `cloud.publicLoadBalancer: true` puts the load balancer on the internet instead;
configuration refuses it together with `auth: true`, because a public load balancer
answers without the authorizer.

A WebSocket route's `$connect` authorizer is attached wherever it is declared: the local
WebSocket dev server and the deployed API enforce the same declaration, and the
authorizer's `principalId` and `context` reach every event on the connection in both lanes.
A route that pushes to browsers declares `cloud: { manageConnections: true }` and calls:

```ts
import { webSocketConnections } from "@repo/framework/runtime/websocket";

await webSocketConnections(event).send(connectionId, { type: "update" });
```

In AWS that is API Gateway's Management API; locally it is the WebSocket dev server's
management port, which only the Compose network can reach. Either lane raises
ConnectionGoneError for a closed connection.

Every framework Lambda's log group (`/aws/lambda/<function>`, which CDK creates beside it)
keeps logs for `defaults.lambda.logRetentionDays` (30 by default, overridable per target)
rather than CDK's two-year default, and each line is a JSON object carrying the request id.

## Resources, inputs, and permissions

[framework-config/resources.ts](../framework-config/resources.ts) declares typed resource
references. Section modules import it directly, avoiding a cycle through the composition
root. Root framework.config.ts re-exports it for consumers.

Declare each infrastructure resource once, link it beside its native CDK construct, and
reference its native string attributes in any workload section. No output map, provider
bag, or per-section catalog update is needed.

```ts
// framework-config/resources.ts — CDK imports are type-only
import type { IQueue } from "aws-cdk-lib/aws-sqs";
import type { IBucket } from "aws-cdk-lib/aws-s3";
import { defineResources, resource } from "@repo/framework/config";
export const resources = defineResources({
  jobs: resource.cdk<IQueue>(),
  uploads: resource.cdk<IBucket>(),
  apiKey: resource.secret("API_KEY"),
});

// Application CDK, beside the existing native constructs
import { linkResource } from "../framework/framework-resources";
const queue = new sqs.Queue(this, "JobsQueue");
linkResource(this, resources.jobs, queue);
linkResource(this, resources.uploads, new s3.Bucket(this, "UploadsBucket"));

// Inside a workload declaration
// environment: { JOBS_URL: resources.jobs.queueUrl, BUCKET: resources.uploads.bucketName },
// cloud: { bindings: [resources.jobs.grantSendMessages(), resources.uploads.grantRead("incoming/*")] },
```

A stack whose constructs are all resources declares itself with one entry instead of one
per construct. `resource.stack<T>()` reads the stack class for its public construct
fields, and `linkResources` answers with every one of them:

```ts
// framework-config/resources.ts — the stack import is type-only, and stays that way
import type { OrdersStack } from "../cdk-app/lib/app/orders-stack";
export const resources = defineResources({ orders: resource.stack<OrdersStack>() });

// cdk-app/lib/app/orders-stack.ts — last line of the constructor
export class OrdersStack extends cdk.Stack {
  public readonly documentsBucket: s3.Bucket;   // resources.orders.documentsBucket
  private readonly internalQueue: sqs.Queue;    // private: never a resource
  constructor(...) {
    ...
    linkResources(this, resources.orders);
  }
}
```

The stack class is the declaration, so `resources.orders.documentsBucket.bucketName` is
typed by the bucket the stack actually builds, and renaming that field fails to compile
at every config that read it. `keyof` omits private and protected members, so a field
becomes a resource only once the stack offers it to its callers. Call `linkResources`
last: it reads the fields that have been assigned. A stack's group cannot be nested
inside another group, and a member nobody links is reported by name at synthesis.

A stack's `string` fields are members too, read as they stand rather than through an
attribute: `resources.cognito.userPoolDomainUrl` is the value `domain.baseUrl()`
returned, and `resources.cognito.trustedOriginsCsv` is a list the stack joined. `get`
accessors count, which is how a private construct publishes one attribute without
publishing itself. `region`, `account`, `environment`, `templateFile` and `artifactId`
belong to every stack and to no catalog, so they are excluded in the type and in the
link walk alike. This is where a value the deployment computes belongs; there is no
second place to declare one and no third place to supply it.

A public string field *is* a resource, so never expose one built from a secret's value.
A connection URL assembled with `secretValueFromJson("password").unsafeUnwrap()` resolves
to the plaintext password at deploy time, and a workload could put it in an environment
variable. Keep it private and hand out the secret instead.

A stack's secret fields are members as well, and are the third kind — see *Secrets*
below.

`npm run framework:check` refuses a value import of `aws-cdk-lib` or `constructs`
anywhere in framework-config, because the local dev servers, the invocation runner and
CDK synthesis all load that catalog, and a value import would carry the whole of
aws-cdk-lib into each of them.

SQS, SNS, EventBridge, S3, DynamoDB, imported resources, L1 constructs, and custom
constructs use the same API. Public string attributes become symbolic references;
construct objects, SecretValue objects and arbitrary methods do not. Native grant
methods take the same trailing arguments as CDK; the framework supplies the grantee.
Arguments must be serializable JSON. Apply methods requiring another construct directly
in application CDK. Ordinary identifiers grant no access; explicit native grants retain
CDK's encryption permissions. cloud.access remains available for explicit IAM policies.

The application calls initializeFrameworkResources once, constructs its stacks without
moving their scopes or IDs, then calls finalizeFrameworkResources once. Environment,
startup secrets, grants and workflow definitions are attached after registration. Missing
links, duplicate links, unavailable required resources and resource dependency cycles
fail with catalog/workload context. CDK tokens retain native cross-stack behavior and
never pass through an environment file on their way to deployed compute.

`resource` has four entry points and no origin chains: `stack<T>()` and `cdk<T>()` for
what the application's CDK built, `fromEnv(name?)` and `secret(name?)` for a line you
author. An environment variable is always a string, so `fromEnv("NAME")` needs no kind;
chain `.enum(...)` to restrict what it may say, `.default(...)` for the fallback, and
`.note(...)` for one line of prose beside the declaration. Naming the variable is preferred;
omitting the name derives the catalog path in SCREAMING_SNAKE_CASE. `-c` context wins
over the file, and the declared default is last.

cdk-app/.env.dev.template and cdk-app/.env.prod.template are hand-authored templates:
`framework:generate` never writes them. When you declare a new `fromEnv` or `secret` line,
add it to both yourself, set (`NAME=`) or commented (`# NAME=<default>`) as you see fit.
Catalog inputs are optional until a workload requires one, so `framework:check` demands only
an input some workload names in `cloud.requirements`, and only in the template for the graph
that runs that workload; it suggests the line, with the requirement's condition.

Use `resource.fromEnv("NAME").required()` or `resource.secret("NAME").required()`
when every enabled consumer must receive the value. Normalization adds an unconditional
requirement to each consuming workload, using the same synthesis and local-runner checks
as `cloud.requirements`. An unused catalog entry does not block an unrelated workload.
Use workload `cloud.requirements` instead for conditional or per-consumer requirements.
A parameter's non-blank `.default(...)` satisfies presence; secrets never have defaults in
source. AWS Studio also guides missing catalog-wide requirements before any consumer exists.

cdk-app/.env.<mode> is the file itself, not process.env: a variable exported in the shell, or
one the generated repository-root .env carries, cannot stand in for a setting this file
owns, so a deployment and `docker compose up` read the same line.

### Absence

An entry declared `undefined` keeps its place in the catalog and resolves to nothing:

```ts
rds: PROD_DEPLOYMENT ? resource.stack<RdsStack>() : undefined,
```

`resources.rds.database` still compiles everywhere it is named, and anything that reads
the entry simply never sees it — which is what lets the Compose Postgres stand in for the
database rather than a handler branching on a deployment mode it cannot see. No
resource carries a mode; there is no `.prodOnly()` or `.devOnly()`. `PROD_DEPLOYMENT` is
imported from `@repo/framework/config/source`. It is the graph the command stated as CDK
context (`-c prodDeployment=true`): `bin/main.ts` resolves it before the catalog is imported
and hands it over as FRAMEWORK_MODE, and every process not started by a synth (the local
runner, the generator, export) reads development. `bin/cdk-app.ts` refuses to load any other
way, because a catalog built for one graph cannot be re-decided after it was imported.

### Secrets

A secret has two sources and three deliveries. The sources:

- `resource.secret("NAME")` — a value authored only in cdk-app/.env.<mode>, which
  `npm run deploy:resources` uploads to Secrets Manager and supplies the ARN for.
- A public `ISecret` field on a `resource.stack<T>()` entry — one the stack created with
  `new secretsmanager.Secret(...)`, or one imported from another account with
  `Secret.fromSecretCompleteArn(...)`. `linkResources` supplies it with everything else
  the stack holds. The database is not one: workloads log in to it with IAM (see
  [Network and database](#network-and-database)).

The deliveries, identical for either source:

- `environment: { SECRET_ARN: resources.x.arn }` — a Lambda reads the secret itself. The
  ARN is a plain, public string; delivering it is what grants the read. An ARN declared
  as an ordinary string grants nothing.
- `secrets: { API_KEY: resources.x.value }` — a container is handed the whole document at
  startup.
- `secrets: { API_TOKEN: resources.partner.credentials.field("token") }` — one JSON
  key. ECS extracts it at startup; local execution extracts it in memory. ECS startup
  reads and encryption permissions belong to the execution role. Only a stack's secret
  offers `.field()`: an authored secret reaches a local container exactly as written, so
  a key would be extracted in a deployment and not on your machine.

None of the three puts a secret's value in a CloudFormation template.

Use cloud.requirements on the consuming workload for conditional inputs. An unused
optional secret imposes no requirement. The canonical command is:

```powershell
npm run deploy:resources -- --all --profile <PROFILE>
```

That deploys your development deployment; add `-c prodDeployment=true` for production.
It accepts CDK deployment switches, including stack patterns, profile, context, parameters
and output paths. CDK watch remains a separate command; it cannot refresh secret inputs
from a completed assembly. It synthesizes and validates first, collects managed secret requirements for the selected
stacks and dependencies, verifies the selected account, checks every existing secret's
ownership and validates all inputs before uploading changes. Existing managed secrets can
be reused without a local value; unchanged values create no version. Names remain
`${CDK_APP_NAME}/secret/<NAME>`. Removed declarations never delete old secrets.

The command supplies complete secret ARNs as generated CloudFormation parameters and
deploys that assembly. Synth and diff perform no secret upload and need no
.secret-bindings.json. Missing required values fail before deployment. A deployment
failure reports any secret changes already performed. Raw values never enter templates,
outputs, manifests, CLI arguments, or framework diagnostics.

### Local resource delivery

A development synth publishes the identifiers needed by local workloads, including
workloads absent from the AWS development graph. Each output carries a versioned catalog
identity and lives in its owning stack. Export discovers them across stacks and writes
ignored .framework/local/resources.json, with deployment/account/region/mode metadata and
workflow integration/bridge identifiers. Export refuses production data, missing required
attributes, conflicting outputs and unresolved tokens; failed refreshes preserve both
previous files. The fixed Cognito, replay and port exports remain in root .env for Compose.

Services start through packages/framework/scripts/run-service.ts <id> -- <command>.
All local compute lanes share the same environment resolver. It reads literals, defaults,
authored cdk-app/.env.<mode> inputs and deployed resource attributes under each workload's chosen
names. New references need no Compose interpolation entry. Node handlers run in isolated
child processes, with environment installed before handler imports. Tasks and container
Lambdas receive their own environment at launch; secret values never appear in Docker argv.

A Node handler's process is kept warm for that handler's next invocation, as a Lambda
execution environment is: module-level state (a database pool, a JWKS cache, a GraphQL
server) survives between calls, and so does any state that should not, which is the point.
Processes start only when a handler is first invoked, one per handler, at most
LOCAL_LAMBDA_WARM_MAX (default 6) at a time; each stops after
LOCAL_LAMBDA_WARM_IDLE_SECONDS (default 120) without work, and all of them stop with the
dev server, so a code change always starts cold. A call that finds its handler's process
busy runs in a fresh one that exits when it answers. LOCAL_LAMBDA_WARM=false starts every
invocation cold. Handlers receive a real Lambda `context` (request id, function name,
memory, and a counting-down `getRemainingTimeInMillis`), and a handler error keeps its own
stack trace in the dev server's log.

The local API dev server builds the event API Gateway builds: the body arrives as the bytes
the client sent (no parser in between, up to Lambda's 6 MB invocation limit), cookies arrive
one per entry, authorizer claims arrive as strings, and failures answer with API Gateway's
own JSON bodies (`{"message":"Unauthorized"}`, `{"message":"Internal Server Error"}`).

Compose mounts .framework/local and cdk-app/.env.dev read-only into the launchers. They stay
outside images and Watch synchronization. Workload configuration changes restart the
launchers. Recreate affected containers after changing authored inputs; restart after an
export to refresh long-running services/workflow integration bindings. Local secrets from
resource.secret() are read from authored inputs only. Linked development Secrets Manager secrets
are fetched at startup only when secrets requests a value; .arn stays an identifier.
The existing local PostgreSQL replacement remains explicit. Local AWS calls use the chosen
development credentials: a cloud grant does not grant permissions to that profile.

Successful development deployment refreshes the manifest and Compose .env automatically.
`npm run export:cdk-outputs -- --profile <PROFILE>` remains a standalone refresh. Production
deployment neither writes nor depends on either development file. For a production graph,
the standalone export writes root .env and .framework/prod/outputs.json with public
frontend/auth settings and publishing identifiers. Both modes end the block with the same
client-app section of VITE_ settings; copy it into client-app/.env yourself. Root .env's generated block represents the most recently exported
mode; exporting production replaces the generated dev controls. The exporter determines mode
from deployed metadata and never puts production resources in the development manifest. Existing
cdk-app/.secret-bindings.json files are ignored and may be removed locally.

### Local service containers

A service needs nothing in Compose. `npm run framework:generate` (which `npm run
dev:containers` runs before it starts Compose) writes docker-compose.services.yml, which
docker-compose.yml includes: one container for each service that runs locally. The file
names where each value came from. It is built from two sources:

| From | What it decides |
| --- | --- |
| The declaration | Container name (the id, which the local API dev server proxies to); the run-service command for the `dev` script of the workspace in its directory; PORT (`port`, or the Dockerfile's one `EXPOSE`); a probe of `healthCheckPath` |
| `x-framework-service` in docker-compose.yml | Everything else, applied as written: image build, Watch rules, platform environment, the read-only mounts, readiness (`depends_on`), and the timing of that probe |

Generation reads docker-compose.yml and never writes it. Each change has one home:

- **All services:** edit `x-framework-service` (for example a `depends_on` on a local cache).
- **One service:** add to it in docker-compose.override.yml, which Compose merges over the
  whole project, including `!reset` to remove a key.
- **One service, entirely:** declare it under its id in docker-compose.yml; generation then
  leaves it out. Use this for a different image, build or command.

Generation refuses, before any container starts, a locally run service that has no
container, and a generated one docker-compose.yml does not include. It also refuses a
container that does not start through run-service or lacks its two read-only mounts. A
service that cannot be generated is refused with the reason: no package.json, no `dev`
script, or not a root workspace. So is a hand-written container whose PORT differs from the
declaration, unless a container sets that service's `<ID>_SERVICE_URL` to send the dev
server elsewhere. run-service sets PORT from the declaration when the container does not.
The override file is plain Compose and is not checked.

## Network and database

VPCs are independent declarations under `framework-config/networks/<id>/index.ts`.
Import each declaration into `framework.config.ts` and list it in the literal
`networks` array. Every networked workload imports its selected declaration explicitly;
there is no implicit/default VPC or inherited VPC reference. Register and place with the
same imported value. Recreating a declaration with matching IDs is rejected so its
network policy cannot be silently replaced by another declaration's settings.

```ts
export const applicationVpc = defineNetwork({
  id: "application",
  // Preserve the original deployed identity when migrating existing infrastructure.
  cloud: { constructId: "NetworkStack" },
  cidr: "10.0.0.0/16",
  zones: 2,
  egressOnlyInternetGateway: true,
  natGateway: false,
  gatewayEndpoints: { s3: true, dynamodb: true },
  interfaceEndpoints: [],
});

// framework.config.ts
networks: [applicationVpc, analyticsVpc],
database: applicationDatabase,

// A Lambda: VPC identity and subnet tier are separate choices.
"/reports": { directory: "...", methods: ["GET"], vpc: analyticsVpc, subnet: "private" },
// A service/task's placement lives under cloud.
cloud: { vpc: applicationVpc, subnet: "public" },
```

Only production builds VPC infrastructure, when a deployed workload or native application
resource uses it. An unused declaration appears in Studio as a blueprint. Each VPC owns
its gateways, endpoints and security groups; no peering or private routing connects VPCs.
IDs and deployed construct identities must be unique. Independent CIDRs may overlap.
The original `NetworkStack` identity retains its existing scopes; additional VPCs have
stable namespaced stacks, ECS clusters, task security groups and API Gateway VPC links.
Changing registration order does not rename infrastructure.

The layout is fixed: a public, a private and an isolated subnet in each zone, all dual-stack.
`cidr` and `zones` are set once: changing either renumbers every subnet. Everything else says
what leaves the subnets:

| Subnet | IPv6 out | IPv4 out | Endpoints |
| --- | --- | --- | --- |
| public | internet gateway | to whatever has a public IPv4 (a public container) | yes |
| private | with `egressOnlyInternetGateway` | with `natGateway` | yes |
| isolated | never | never | yes |

The S3 and DynamoDB gateway endpoints sit on every route table and cost nothing. An interface
endpoint reaches one AWS service privately from every subnet, over IPv4, with no gateway:
list it by its endpoint name (the last part of `com.amazonaws.<region>.<name>`), and
`interfaceEndpoints` completes every service the deploying CDK knows, refusing a misspelling
with the name it meant. The list is generated from aws-cdk-lib by `npm run framework:generate`.
Endpoints are an alternative to NAT when only AWS services need IPv4, and the only way out of the
isolated subnets. They are not automatically cheaper: three endpoints in two zones cost more than
one NAT gateway. Synthesis prints what the network holds and what it costs.

### Lambdas in the VPC

A Lambda's imported `vpc` selects its network; declare it explicitly on each workload.
The `subnet` selects the tier and may be set on one Lambda, on a section (`defaults.http`), or on every
Lambda (`defaults.lambda.subnet`), and override it on any one:

- `"none"` (the default): outside the VPC, with the whole internet.
- `"private"`: the private subnets, leaving as its selected VPC allows, plus its endpoints.
- `"isolated"`: the isolated subnets, which reach the database and the endpoints, nothing else.

```ts
"/reports": { directory: "...", methods: ["GET"], vpc: applicationVpc, subnet: "private" },
```

There is no `"public"`: AWS gives a Lambda in a VPC no public IPv4 address, so a public subnet
would only lose the NAT gateway. `vpc: applicationVpc` puts a Lambda that would inherit `"none"` in
`"private"`, and refuses an explicit `"none"`. A Lambda in the VPC shares one security group with
the others (one that uses the database joins the database's group instead). Only TypeScript
Lambdas run in the VPC, and an event that does needs `localReplay: true`, because a dev
deployment builds no network.

Where IPv6 leaves its subnet, a Lambda runs with `AWS_USE_DUALSTACK_ENDPOINT=true`, because
several AWS APIs answer IPv6 only on their dual-stack hostnames. Everywhere else it calls the
standard hostnames, which is what an interface endpoint's private DNS answers. Interface
endpoints are IPv4, because IPv6 support on PrivateLink varies by service and region. So a
Lambda whose subnet sends IPv6 out reaches AWS over IPv6 and passes by an interface endpoint;
endpoints serve containers, isolated Lambdas, and private subnets without IPv6.

Where a Lambda's subnet has no way out at all (isolated, or private with both gateways off),
configuration requires an endpoint for every AWS call the framework makes for it: `secretsmanager`
for a secret it reads, `ecs` for `runsTask`, `states` for `startsWorkflow` and callbacks,
`bedrock-agentcore` for an agent. A WebSocket handler that pushes to connections is refused
there outright: no interface endpoint reaches API Gateway's management API.

### The database

The imported `defineDatabase` declaration in
`framework-config/databases/application/index.ts` owns the primary resource, VPC,
private/isolated subnet and PostgreSQL settings. The root selects it once; workloads
keep `database: true`. There is no password in a workload:

```ts
// framework.config.ts
database: applicationDatabase,

// any Lambda, event, tool, service or task
"/graphql": { directory: "...", methods: ["GET", "POST"], auth: true, vpc: applicationVpc, database: true },

// its handler
const database = getDatabase(databaseConnection());
```

Studio's **Application PostgreSQL** inspector joins the RDS building and local Postgres
node: one schema, independent data. Open it directly, through the owning stack, or through
**Database → Configure PostgreSQL**. It shows the required VPC home, declared consumers,
application/direct/reader connection paths, and grouped settings for Multi-AZ, replicas,
Proxy, storage, backups and maintenance. Deployment inputs and CDK context retain precedence.
**Change placement** reviews one coordinated source edit for the database and every
framework database consumer, preserving workload subnet tiers and IAM/connection policy.
It never copies data or relocates a running RDS instance. Existing deployments need a
planned migration/cutover and separate deployment authorization. A VPC that owns the
database cannot be removed; native imports must also be reconciled before removal.
See the [declaration design and identity contract](framework-studio/network-database-declarations.md)
for before/after config, generated files, regional scope and migration impact.

In a production deployment, `database: true` on a Lambda:

- places it in the private subnets (or the isolated ones it declares), in the client group
  for its selected endpoint;
- grants it `rds-db:connect` for the selected writer's IAM login, `app_user`;
- sets `PRIMARY_DATABASE_URL` (no password) and `PRIMARY_DATABASE_AUTH=iam`, from which
  `databaseConnection()` signs a 15-minute IAM token for every new connection, locally, with
  the workload's own role, over TLS verified against the RDS certificate authorities;
- sets framework-owned `PRIMARY_DATABASE_POOL_OPTIONS` from `defaults.database.pool`
  and workload overrides (10 connections, 20000 ms connect timeout, 30000 ms idle timeout);
- sets `AWS_USE_DUALSTACK_ENDPOINT=true` where IPv6 leaves its subnet, so its AWS SDK calls
  use endpoints reachable over IPv6.

A `subnet` alone grants none of this: it places a Lambda, and only `database: true` reaches
the database. Only TypeScript Lambdas use the database: cross-language Lambdas and AgentCore
agents always run outside the VPC, and their database work belongs in a TypeScript Lambda or a
tool.

`database: true` selects the application writer, which uses Proxy when enabled.
`database: { connection: "direct" }` selects the direct writer for migrations.
`database: { readers: true }` retains the writer and adds explicit replica access through
`getDatabase(databaseConnection({ role: "reader" }))`. Combine object options as needed,
including `pool: { maxConnections: 4 }`. No declaration means no reader access. Zero replicas
uses the writer, and local readers use Compose Postgres. Configured replica failures surface;
the helper keeps one randomly selected replica per execution environment and never retries
against the writer. Read-after-write consistency and transactions belong on the writer.
See [Database](DATABASE.md#writer-and-reader-connections) for pooling and consistency details.

The database is ordinary CDK, built into the network with `frameworkVpc(this, applicationVpc)`, with no
security groups or ingress rules of its own. Its declaration must match the VPC named in
the database binding; consumers in another VPC are rejected in both modes:


```ts
new rds.DatabaseInstance(this, "PostgresDatabase", {
  vpc: frameworkVpc(this, applicationVpc),
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
  credentials: rds.Credentials.fromGeneratedSecret("postgres"),
  iamAuthentication: true,
  databaseName: "app_db",
  publiclyAccessible: false,
  storageEncrypted: true,
});
```

Infrastructure settings live in [the production template](../cdk-app/.env.prod.template):
instance/engine, storage, availability, backup/maintenance, replicas, Proxy and log exports.
Their resolver uses camelCase CDK context, then environment, then defaults. Development
builds none of these resources. Database naming and specialized parameter groups remain
ordinary application CDK source.

The CDK connection adapter separates infrastructure from workload endpoints. Beside native
application constructs, before resource finalization, register:

```ts
bindPostgresDatabase(this, resources.rds.database, {
  instance: this.database, proxy, readReplicas,
});
linkResources(this, resources.rds);
```

Import `bindPostgresDatabase` from `cdk-app/lib/framework/framework-database`. Directly linked
PostgreSQL instances receive an equivalent default adapter. The CDK-only
`DatabaseConnectionTarget` exposes direct/application writers, readers, database/login
identity, native network and IAM grant hooks, and bootstrap. Attachments are finalized
after resources are linked. Bootstrap keeps its construct scope in the writer's stack.

Proxy requires TLS and end-to-end IAM: workloads receive only permission for the Proxy
login; Proxy's role receives permission for the writer login. Direct, Proxy and replica
clients use separate security groups. A workload joins only its declared paths. Proxy
target registration waits for successful login bootstrap, and bootstrap always uses the
direct writer. This instance topology proxies writer traffic; replicas are direct.
See [AWS Proxy IAM setup](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-iam-setup.html)
and [Proxy limitations](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html).

RDS insists on a master user with a password. The framework reads that password exactly
once, on deploy: a custom resource in the database's stack logs in as the master and creates
`app_user`, with `rds_iam`, no password, database `CONNECT` and `CREATE`, and the right to
create tables in `public`. Database `CREATE` allows Prisma to create its `prisma_contract`
tracking schema and migrations to create schemas. The login is not a superuser.
Versioned bootstrap permissions are reapplied on redeployment. Migrations run as
`app_user` too, so it owns every table. A release
therefore deploys first and then migrates: `npm run db:migrate:cloud -- --profile <PROFILE>`
runs the `db-migrate` task inside the network with `database: { connection: "direct" }`.

### Containers

Fargate is serverless, and it always runs in the VPC: there is no container outside it. What a
container chooses is the subnet, `cloud.subnet`, inherited from `defaults.container.subnet`
(default `"public"`):

- `"public"`: a public IPv4 address per running task (about $3.65 a month while it runs) and no
  inbound rules. It starts whatever its selected VPC declares.
- `"private"`: no public address. Fargate pulls the image over IPv4, so the network needs its NAT
  gateway, or the `ecr.api`, `ecr.dkr` and `logs` interface endpoints plus the S3 gateway
  endpoint (and `secretsmanager` when it takes secrets).

Configuration refuses a deployed private container that could not start, in every mode, naming
every endpoint it lacks and what each costs, beside the NAT and public alternatives. Without NAT,
the AWS calls the framework makes for it (`ecs`, `states`, `bedrock-agentcore`) need their
endpoints too, since a container's SDK calls go out over IPv4.

### In development

**A dev deployment builds no network and no database.** The database is absent from the dev
graph and runs under Compose, so asking for the network there is an error. The local lane
holds the network's rules instead, which is what keeps "works locally" meaning "works in AWS":

- `PRIMARY_DATABASE_URL` (the Compose Postgres) reaches only a workload that declares
  `database: true`.
- A Lambda in the VPC gets `AWS_USE_DUALSTACK_ENDPOINT=true` exactly where it would in AWS.
  Unless IPv4 leaves its subnet (a private subnet with `natGateway`), it runs under an egress guard
  that refuses at once, with the reason, any host its subnet could not reach. That is a host with
  no IPv6 address where only IPv6 leaves, or anything an endpoint does not answer where nothing
  leaves. A refused AWS hostname names the endpoint that would reach it, such as
  `add "cognito-idp" to interfaceEndpoints`.
- Configuration refuses `database: true` on an agent, a workflow or a cross-language Lambda,
  on an event without `localReplay: true`, and a workload that reads anything else from the
  database's stack without declaring it. It refuses a `subnet` on a cross-language Lambda
  and on an event without `localReplay: true` the same way.

Inside a Lambda in the VPC, an SDK client given its own `endpoint` passes
`useDualstackEndpoint: false`: the SDK refuses the dual-stack setting with a custom endpoint.

## Events and native infrastructure

Application stacks live under cdk-app/lib/app. Generic config projections live under
cdk-app/lib/framework. Add application stacks and link resources beside their constructs; keep workload-specific lists out of generic framework code.

Event Lambda declarations own build settings, environment, and workload permissions.
The stack creating an AWS event source attaches its native trigger to
`eventFunction(scope, id)`. Generic EventLambdaFunctionsStack constructs unowned events;
createEventLambda or registerEventLambda supports a native owning stack. Each declared
event has exactly one registration; duplicate/missing owners fail. Registering an already
built function cannot retroactively apply build settings.

An event can instead declare typed `triggers` from `@repo/framework/config`:

```ts
triggers: [trigger.cognito(resources.identity.userPool, {
  id: "before-signup", operation: "preSignUp", accepts: "cognito",
})],
```

The stable attachment `id` is unique within its source resource and separate from the
event's ID and construct ID. Changing its event destination retains a rule's identity. `accepts`
records a reviewed handler payload/response contract; it does not transform a handler.
Cognito supports standard hooks (excluding custom senders and versioned token hooks).
`trigger.eventbridge(bus, { id, accepts: "eventbridge", eventPattern, ... })` creates a
rule using CDK EventPattern field names; it supports enabled state, target input,
retry attempts, maximum event age and a catalog `deadLetterQueue`. Resources must be
available in both graphs. Imported Cognito pools, duplicate/native-owned hooks, unknown
ownership and incompatible replay are rejected. No native binding is overwritten.

`trigger.sqs(queue, { accepts: "sqs-batch", ... })`, `trigger.dynamodb(table, { accepts:
"dynamodb-stream", startingPosition, ... })`, `trigger.sns(topic, { accepts: "sns", ... })`
and `trigger.s3(bucket, { accepts: "s3", delivery: "eventbridge" | "notification",
eventTypes, acknowledgeRecursionRisk: true, ... })` cover the remaining services, with
batch/filter/failure options where AWS supports them. SQS needs queue visibility at least
the function timeout (more is only recommended) and FIFO batch limits; DynamoDB needs an
existing stream and never enables one; SNS refuses FIFO topics; S3 keeps the bucket's
delivery architecture and refuses overlapping filters. Any existing native mapping on a
queue or stream, a native subscription to the same function, or native bucket notification
configuration is reported for review instead of attached over.

`trigger.schedule({ id, accepts: "schedule", expression, timezone?, enabled?, input? })`
needs no catalog resource: it creates an EventBridge Scheduler schedule in the function's
stack. The expression is `rate(N minutes|hours|days)` (singular for 1) or a six-field
`cron(...)` with `?` in day-of-month or day-of-week. Its attachment key is `schedule/<id>`,
so an id is unique across all events. An adapter declares `resourceless: true` to take no
resource.

An event's `onFailure: { destination, retryAttempts?, maxEventAgeSeconds? }` sends its
failed asynchronous runs (EventBridge, SNS, S3 and schedule triggers: adapters marked
`asyncInvoke`) to a standard catalog SQS queue or SNS topic once Lambda stops retrying;
retries are 0 to 2 and age 60 to 21600 seconds. It configures the function's
EventInvokeConfig, which grants the send, and refuses FIFO destinations and a function
that already configures asynchronous invocation natively. Queue and stream triggers keep
their own dead-letter settings.

Resource finalization validates the entire attachment list before applying adapters,
resolves each function through `eventFunction`. Cognito retains native source ownership;
EventBridge rules belong to the function's existing stack so reading a bus does not add a
reverse dependency. Attachment IDs include a stable source digest and the authored ID,
independent of the destination function. No blanket stack dependency is added. Native CDK remains valid;
the application's three Cognito hooks retain their native ownership.

To add a service, define its pure metadata, canonical CDK types, options and validator
with `defineTriggerAdapter<Native, Options>()`, and register its CDK validation/attachment
with `registerCdkTriggerAdapter` in the CDK entry point before finalization. Import the
pure definition before its event declarations. Studio uses that metadata and semantic
public-field discovery; individual stacks need no registration. Its generic authoring
form is `trigger.adapter(kind, resource, options)`. Include native-inventory fixtures,
option/conflict tests, least-privilege IAM and two-mode synth/dependency tests. Config
modules and the framework's pure config implementation cannot import CDK values;
`framework:check` enforces that boundary.

Construction order is resources/RDS, tasks, event owners, Cognito, workflows, then routed
workloads. Event/task/workflow handles live in app-scoped registries; do not thread them
through every stack constructor. eventFunction does not add a stack dependency: actual
CDK references establish dependencies, avoiding cycles with the native trigger owner.

Preserve deployed stack/construct paths and cloud.constructId pins. The event stack's
historical identity remains AsynchronousLambdaFunctionsStack. Output export names and
HTTP API names include the deployment stack name. Refactoring source must not silently
replace deployed resources.

An event can opt into localReplay. Dev CDK supplies its replay bucket/queue pair and
capture permissions, and the handler wraps itself:

```ts
import { withLocalReplay } from "@repo/framework/runtime/event-replay";

export const lambdaHandler = withLocalReplay(async (event, context) => {
  // runs locally when replayed, and in AWS everywhere but a dev deployment
});
```

The wrapper needs no id: CDK tells the function which declaration it is. In a dev deployment
it captures the invocation and answers AWS itself (a Cognito trigger gets its event back;
every other source gets success), and the local API dev server replays the capture through
the same handler. `framework:check` refuses a `localReplay` handler without the wrapper and
a wrapper without `localReplay`. Captures are kept for 7 days. A capture whose handler fails
on every delivery moves to the replay dead-letter queue; fix the handler, then
`npm run replay:redrive` replays it again (`npm run replay:list` shows what is waiting).
Replay records an invocation for local execution, not AWS delivery guarantees or
infrastructure parity.

## Tasks and workflows

Callers declare `runsTask(id)` or `startsWorkflow(id)` in cloud.bindings. The framework
derives the injected descriptor, exact IAM, and local permission check. Never author
the derived environment name or choose transport by credentials, hostname, or a mode flag.
Runtime code imports runTask/startWorkflow from @repo/framework/runtime/invocation. Their
ids are typed with the generated unions, so a misspelled task or workflow fails to compile.

Both runtime calls acknowledge submission. A runId or executionId is not completion.
Tasks receive JSON input and run to exit; stdout is logging, not a business result channel.
Use application storage for task results. Long-running services each have a Compose
container ([generated](#local-service-containers) from the declaration); tasks/workflows are
launched dynamically by the invocation runner.

A task's input travels in its container overrides together with its callback handle, and
ECS caps the whole override at 8,192 characters. Pass identifiers and let the task read
larger documents from storage.

A task that calls AWS during local development must declare
`local: { resources: ["awsCredentials"] }`. Without it the container receives
`AWS_PROFILE` but not the mounted `~/.aws`, so every AWS SDK call fails to find
credentials, and does so silently if the graph has a fallback.

### The workflow vocabulary

Build graphs with the declarations from @repo/framework/config: `workflow`, `sequence`,
`parallel`, `map`, `when`, `choose`, `retry`, `attempt`, `wait`, `transform`, `succeed`,
`fail`, and the steps `invokeLambda`, `runTask`, `runWorkflow`, `invokeAgent` (see
[AgentCore](AGENTCORE.md#calling-an-agent)). Conditions are `eq`, `ne`,
`gt`, `gte`, `lt`, `lte`, `contains`, `startsWith`, `endsWith`, `and`, `or`, `not`,
`exists`, `isNull`. Follow the [test-only graph](../local-invocation-runner/test/workflow-engine.test.ts)
and the typed API in [workflow definitions](../packages/framework/src/config/workflows.ts).

An `invokeLambda` target is declared under `events`: a workflow is one more native invoker
of an event Lambda. Application event declarations live in `framework-config/workloads/events.ts`;
the workflow engine's isolated test declares its own handler and graph.

Creating a step does not schedule it; the returned graph establishes execution order.
`map(items, ({ item, index }) => flow, { maxConcurrency })` runs a subgraph per element,
bounded in both lanes by AWS's inline ceiling of 40. `parallel({ name: flow })` answers
with the object the author declared. A step's `.output` is a typed reference resolved when
the workflow runs — never a value at declaration time.

**Reshape data with `expr`, not JavaScript.** `expr.add`, `subtract`, `multiply`, `divide`,
`concat`, `coalesce`, `ifElse`, `length`, `at`, `project`, `filter` and `merge` compile to
expressions both lanes evaluate identically. `transform(value)` names an intermediate
result; a payload position already accepts objects, arrays, literals and references in any
arrangement, so a transform is for when a shape needs a *name*. A symbolic value used in a
JavaScript condition, coercion, template literal or spread is refused by name in
`framework:check` — those operate on the reference, not on the value it will hold.

**JSON semantics are the same in both lanes.** An absent invocation payload is `{}`. A
skipped optional branch, a `wait` and a bare `succeed()` produce `null`. Reading a member
that is not present fails the step with `States.QueryEvaluationError`; use
`expr.coalesce(value, fallback)` or a presence test when absence is ordinary. Empty and
single-element arrays are preserved. Equality is structural and does not depend on the
order members were written in.

**Deadlines bound pending work.** The execution deadline and a step's own `timeoutSeconds`
both interrupt an operation in flight and cancel what they were waiting on; an uncaught
execution deadline ends the execution as `timedOut`, while a step timeout fails it. A
`retry` policy attaches to one step — an invocation, an integration, a map or a parallel —
and wrapping a `sequence` is refused where it is written rather than at synthesis.

The graph derives outgoing permissions. Invocation edges must be direct, acyclic, and
resolve to enabled destinations in the execution lane. Parallel/iteration scopes and
reference ordering are checked during normalization. The local interpreter walks the
same graph; AWS compiles it to Step Functions. Local execution does not reproduce managed
service durability. Histories are in memory and are lost on runner restart. Raw AWS states
are refused locally. Activities and arbitrary polling loops are not part of the API.

`npm run workflows:inspect` prints each graph's steps, the workloads and resources it uses,
where each runs during development, and the bindings it needs. It is read-only and offline.

### Managed-service steps

The [managed-service tests](../packages/framework/test/workflow-service-steps.test.ts)
exercise DynamoDB, SQS, SNS, EventBridge, HTTP and AWS-operation adapters without
declaring demo workloads or deploying fixture resources in the application.
An application's `http.request` step needs its own endpoint and Connection.

A workflow talks to a table, queue, topic or bus by naming the **catalog entry** that
already holds it. There is no separate declaration and no separate binding: the construct
is linked once for everything that uses it, and a workflow reaches it through that link.

```ts
// The stack's own constructs, declared once
export const resources = defineResources({ orders: resource.stack<OrdersStack>() });

// In a graph — the operation decides the kind, so a queue here is a type error
dynamodb.update<Order, { orderId: string }>(resources.orders.recordsTable, {
  key: { orderId: input.orderId },
  set: { status: "approved" },
});
sqs.request<ApprovalRequest, ApprovalResult>(resources.orders.approvalQueue, message, {
  timeoutSeconds: 3600,
});
```

Application CDK does nothing extra — `linkResources(this, resources.orders)` beside the
constructs is the whole binding. The document types belong to the call, not to the table:
a construct has no item type, and inventing a place to declare one is what this replaced.

An HTTPS endpoint and an explicit AWS action are not constructs — one is an address plus a
credential, the other an API call with a hand-written grant — so those two are still
declared where the workflow is and bound explicitly:

```ts
bindWorkflowHttpConnection(this, paymentsApi, connection, { endpoint: "https://…" });
bindWorkflowAwsOperation(this, translate, { grant, parameters });
```

Creation, lifecycle, encryption, subscriptions and event source mappings stay in the
application stack with its own native CDK. Resolving a reference applies only the
permissions the graph's operations need and publishes the resource's identifier. A
resource nobody linked fails before deployment, naming what this app did link; a
wrong-kind resource fails to compile at the call site.

| Step | Result |
| --- | --- |
| `dynamodb.get/put/update/delete` | The item, or `null` for a read that found none; `null` for a write; the updated item for an update |
| `sqs.send`, `sns.publish` | `{ messageId }` — acceptance, never a consumer's outcome |
| `eventbridge.put` | `{ eventId }`, failing the step when the *entry* was rejected |
| `http.request` | `{ statusCode, headers, body }` |
| `aws.call` | The action's own response |

DynamoDB carries JSON documents; marshalling rules are shared by the compiler and the SDK
call. Binary values, sets and precision-sensitive numbers are deliberately outside that
API. Conditional writes are declared explicitly and nothing infers one.

### Callbacks

`sqs.request`, `sns.request`, `eventbridge.request` and `runTask(id, { completion:
"callback" })` suspend the step until a worker reports. Each requires `timeoutSeconds`;
`heartbeatSeconds` is opt-in and never extends the absolute deadline.

A messaging worker receives `{ payload, callback }` and answers with the vocabulary from
`@repo/framework/runtime/callbacks`:

```ts
await completeCallback(request.callback, { approved: true });
await failCallback(request.callback, { error: "Rejected" });
await completeCallback(taskCallback(), result); // inside a container
```

The worker declares `completesCallback(reference)` in cloud.bindings, which derives the
Step Functions callback grant. Those actions take `Resource: "*"` because a task token is
not an ARN and AWS supports no resource-level scoping for them.

A handle says *which* callback and by what route; it never carries a URL. Locally, a fresh
token is minted per attempt and a retried step invalidates the previous one, the first
terminal completion wins, and duplicates, expired callbacks and late answers are refused.
The local broker is not durable: a runner restart invalidates every pending callback, and
a stale message is given a terminal answer rather than retried forever. Callbacks do not
promise exactly-once business execution; idempotency stays with the application.

### Local execution of a workflow

Orchestration and compute run on this machine; DynamoDB, SQS, SNS and EventBridge stay in
AWS. `npm run export:cdk-outputs` writes the binding document the runner reads —
deployment name, account, region, mode, and which resource each reference is bound to — so
a local execution reaches the selected development deployment's resources rather than
guessing from a naming convention.

Two integrations cannot follow orchestration home. An HTTPS call is authenticated by an
EventBridge Connection AWS owns, and an explicit AWS operation is defined by the role its
binding grants. A development deployment generates one small Express state machine per such
reference, and the runner starts it synchronously; the call still happens in AWS, under the
role the binding wrote. A production deployment compiles the same operations inline.

A Lambda step runs as a Node child process, or through the container-image lane when the
handler is packaged as a container. A Python zip handler has no local lane and is refused
by name.

### Verifying task and workflow invocation

The frontend's **Start workflow** button calls the authenticated `/test/start-workflow`
route. Its declared workflow validates input in an event Lambda, runs a container task
to completion, and returns the validation result. The **Run test task** button calls the
authenticated `/test/run-task` route, whose Lambda submits the same task directly and
returns its run ID without waiting for completion. Each starter has only its own binding.
Managed-service capability fixtures are not part of the application.

After an authorized development setup, exercise the frontend or its starter route and
check terminal status through the runner controls below. Offline adapter and
process-boundary tests run with `npm run verify`; they do not prove live AWS delivery.

Locally, inspect the runner on the configured LOCAL_INVOCATION_RUNNER_HOST_PORT:

- GET /tasks, /tasks/<runId>, and /tasks/<runId>/logs.

- POST /workflows with `{ "target": "workflow:<id>", "caller": "<kind>:<id>", "input": {…} }`
  starts an execution without a browser session. The runner accepts it only when `caller`
  is a declared target whose bindings include `startsWorkflow(<id>)`, answers 202 with
  `{ executionId, status }`, and refuses other edges with 403. POST /tasks takes
  `task:<id>`, a caller with `runsTask(<id>)` and an optional `clientToken`. The port is
  bound to 127.0.0.1.
- GET /workflows/<executionId>. Callback tokens are redacted from every response.
- Correlate the returned taskId with task output and workflow history. A 202 alone fails
  to establish success: check task exitCode=0 and workflow status=succeeded.

In AWS, runId is an ECS task ARN; inspect it with aws ecs describe-tasks and CloudWatch
logs. `npm run task:cloud -- <task-id> --profile <PROFILE>` launches a cloud-enabled task from
a terminal, through the descriptor the deployment publishes, and exits with its exit code. Inspect executionId with aws stepfunctions describe-execution. Verify the same
payload and terminal success. Local checks do not prove VPC isolation or IAM behavior.

The ECS workflow integration still needs a measured AWS release check for exit 0, exit 1,
image/startup failure, StopExecution, state timeout, and execution timeout. Record errors
and remaining tasks and compare both adapters; do not claim AWS cancellation/error parity
from offline/local tests. Use a disposable fixture for deliberate failures.

## Configuration and environment

| File/source | Owner and purpose |
| --- | --- |
| cdk-app/cdk.json `framework:targets` | Committed deployment targets: name, mode, pinned account and region, inputs file. Production targets must pin their account |
| cdk-app/.env.dev | Your development inputs, and the file Compose reads; CDK_APP_NAME names your own development deployment. Deployment flags may be overridden by the shell or `-c`; resource inputs are read from the file itself |
| cdk-app/.env.prod | Production inputs, read by `-c prodDeployment=true` commands unless the target names another inputs file |
| cdk-app/.env.dev.template, cdk-app/.env.prod.template | Tracked references the two ignored files are generated from. There is no mode-less `cdk-app/.env`: the mode picks the file. Studio's CDK environment files island generates a missing file from its template, and its file inspectors edit/add variables through draft review |
| Root .env | Exported development Compose/auth/replay/port controls. A production export never writes it |
| client-app/.env.development.local, client-app/.env.production.local | Exported client settings that `vite dev` and `vite build` read over the authored client-app/.env |
| .framework/local/resources.json | Discovered development resource and workflow identifiers; never raw secrets |
| client-app/.env | Authored browser-public VITE_ settings |
| .framework/prod/outputs.json | Exported public production outputs, including frontend publishing identifiers |
| Service .env.example | Generated input documentation; no authored per-service env files |
| docker-compose.yml | Local containers, launchers, read-only mounts, ports, readiness, and Watch; `x-framework-service`, the container every generated service starts from |
| docker-compose.services.yml | Generated: one container per service that runs locally, included by docker-compose.yml |
| cdk-app/deployment.ts | Application deployment input validation, precedence, and compatibility aliases |

Each command states the graph it builds as CDK context: development unless it says
`-c prodDeployment=true` (the deprecated `-c useLocalDevStack` is its inverse). The deployment
is a target: `-c deployment=<name>`, the only production target when production is stated,
or your own development deployment (CDK_APP_NAME). A declared target's mode must agree with
the stated one, a production target is never implied, and a pinned account or region is never
synthesized for another. A leftover PROD_DEPLOYMENT line that agrees is a warning; one that
disagrees stops the synth. Ordinary settings use context, environment, then fallback. New deployment-wide flags belong in deployment.ts plus tests;
workload inputs belong in the resource catalog instead.

What a stack belongs to is recorded in AWS, not inferred from its name. Every stack carries
the `framework:deployment:v1` output (deployment, mode, account, region), and
`npm run deploy:resources` checks it before uploading secrets or deploying.
`@repo/framework/deploy` classifies the deployed stacks; `scripts/deployment-guard.ts`
turns that classification into refusals. A stack without the output (a failed first
create, or one from before the output existed) is identified from its deployed template,
or refused.

The principal deployment settings are the target (`-c prodDeployment`, `-c deployment`,
`framework:targets`, CDK_APP_NAME), RETAIN_STATEFUL_RESOURCES, DATABASE_BACKUP_RETENTION_DAYS, DEPLOY_PROD_WEBSOCKET_API,
COGNITO_SES_FROM_EMAIL (with optional COGNITO_SES_FROM_NAME and COGNITO_SES_REGION),
SKIP_EMAIL_VERIFICATION (development only), frontend/Cognito custom-domain toggles and
certificate pairs, and optional Google credentials. USE_CUSTOM_WS_AUTHORIZER is retired: the
declared authorizer is always attached, a leftover `true` is ignored with a warning, and
`false` is refused. Environment examples list authored settings; deployment.ts is the exact
reference for accepted context keys and legacy aliases. Avoid adding new aliases or copying
legacy precedence exceptions.

### Stateful retention and explicit reuse

`framework-config/stateful-resources.ts` is the shared code/Studio source for
resource-specific policy, with separate `dev` and `prod` objects:

```ts
export const statefulResources = {
  dev: { database: { retention: "remove" }, cognito: { retention: "retain" } },
  prod: { database: { retention: "retain" }, cognito: { retention: "retain" } },
} satisfies StatefulResourcesConfiguration;
```

The checked-in empty objects preserve existing behavior. An omitted resource
policy inherits `RETAIN_STATEFUL_RESOURCES` from that target's existing inputs;
the shared context flag, historical misspelling and false fallback keep their
existing precedence. Explicit source retention overrides that fallback for one
resource/environment. Source approval changes configuration only: deploy a saved
review before the new policy protects anything in AWS. Development's database
policy does not create RDS or change Compose volume lifecycle.

RDS retention also protects its original VPC, subnets, route tables, gateways,
endpoints, security groups, subnet/parameter groups and generated secret. NAT and
PrivateLink costs continue when those resources remain. User Pool retention
preserves users plus its native app client, domain and provider declarations;
other stacks' triggers, groups, Identity Pools and IAM roles remain independent.
Teardown reads actual deployed templates and refuses deleted database
dependencies or a retained pool whose declared trigger Lambda would be removed.
Older deployments must first deploy their dependency policies or separately
reconfigure their trigger before teardown. Historical retention did not protect
the underlying generated database secret correctly; a missing original secret
is a recovery prerequisite failure, never replaced or guessed automatically.

Retain keeps a physical resource; reference reconnects to an externally managed
one; CloudFormation import transfers ownership; restore creates a resource from
a snapshot/backup. Only explicit reference reuse is implemented here. Add an
inspected `reference` descriptor to that resource's environment policy to reuse
a released same-account/region resource. Cognito keeps its exact pool/client IDs;
RDS keeps its immutable resource ID and original network, uses the existing IAM
`app_user`, and performs no SQL bootstrap, migration or seed. External resource
configuration remains outside CDK management. Database references currently use
the direct PostgreSQL writer only; clusters, Proxy and replicas are unsupported.

Code-only users obtain nonsecret descriptors through the read-only inspector:

```powershell
node --import tsx scripts/stateful-references.ts list --deployment <NEW> --mode prod --profile <PROFILE> --region <REGION> --json
node --import tsx scripts/stateful-references.ts inspect --kind database --id <DB-IDENTIFIER> --original-deployment <OLD> --deployment <NEW> --mode prod --profile <PROFILE> --region <REGION> --json
node --import tsx scripts/stateful-references.ts inspect --kind cognito --id <POOL-ID> --client-id <CLIENT-ID> --original-deployment <OLD> --deployment <NEW> --mode prod --profile <PROFILE> --region <REGION> --json
```

Review the returned descriptor in source, synthesize and use normal saved
deployment review/apply. Inspection checks ownership, current release/availability
and original dependencies; saved-assembly deploy repeats it before cloud writes,
including intended Cognito redirects/providers and declared database network
routes/endpoints. An actively managed resource, another deployment's reference,
uncertain teardown, or an implicit managed/reference identity transition refuses.
Generated CloudFront callback origins resolve only through stable deployed
exports owned by the selected destination. For a fresh production website,
deploy that supporting stack first, configure the existing external client's
exact callback/logout origins separately, then review the reference deployment.
Reference changes require a separately reviewed lifecycle/replacement operation.
Queries, sign-in, migrations, import, snapshot restore and permanent deletion each
need their own verification/authorization; successful inspection proves none of
those operations happened.

Teardown atomically saves physical identities and dependency relationships to
`.framework/retained-resources/<account>/<region>/<deployment>.json` before its
first destructive request, then records completion or partial failure. This
local evidence survives removed source and stacks; preserve/copy it when moving
checkouts. Physical-resource locks under `.cache/deploy/references` exclude
concurrent recovery deployments in the same checkout even when destination names
differ, and release with the deployment operation. It is not a distributed
ownership registry. Live AWS inspection is required before reuse, and a missing
resource remains missing. Concurrent cloud operations from other machines still
require operational coordination. See the
[Studio lifecycle guide](framework-studio/stateful-resources.md).

Both custom and generated CloudFront hostnames serve same-origin /api and declared agent
paths. With a custom frontend origin, auth/CORS use the configured URL and the website
references the backends directly. With a generated hostname, Cognito and the handlers
depend on the website's URL, so the website cannot depend back on them. In that mode,
CloudFront Functions read destinations from a KeyValueStore: the website owns the store,
and a custom resource in the HTTP API stack fills it after the backends are ready. The
custom resource grants only DescribeKeyValueStore, ListKeys and UpdateKeys on that store and writes
public endpoint names and Runtime ARNs. Requests without a published destination return
503; they never fall through to the SPA. Cognito callbacks/logout and trusted browser
origins still use the exact generated HTTPS hostname. See
[CloudFront origin modification](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/helper-functions-origin-modification.html).

### Deployment region

Choose one AWS account and region for the whole application deployment, including all
its VPCs and the database. Pin a shared deployment's destination in `cdk-app/cdk.json`:

```json
"framework:targets": {
  "application-prod": {
    "mode": "prod", "account": "111122223333", "region": "us-east-1",
    "inputs": "cdk-app/.env.prod"
  }
}
```

This is the existing target vocabulary; VPC declarations have no region property.
The CDK CLI resolves the selected profile/region into `CDK_DEFAULT_ACCOUNT` and
`CDK_DEFAULT_REGION`; `deployment.ts` validates the target pins and passes one
`stackEnv` to application and framework stacks. `deploy:resources -- --region <region>`
also checks that the synthesized assembly has that region. A region pin guards the
deployment; it does not move existing infrastructure to another region.

Every VPC uses that stack environment. Its `zones` setting is CDK's `maxAzs` within
the deployment region; the account's cached availability-zone context determines the
available zones. CDK resolves interface service names such as
`com.amazonaws.us-east-1.secretsmanager` and gateway endpoints from the VPC stack's
region. Studio's VPC settings edit the network, while the deployment target owns its
destination. Native application stacks must use the same `stackEnv`; framework VPC
access fails early for a different account or region.

Per-VPC regions would require regional copies of compute, routing and database
integration. Ordinary CloudFormation cross-stack exports/imports are limited to
one account and region, and a workload cannot use a subnet in another region.
See [CDK environments](https://docs.aws.amazon.com/cdk/v2/guide/environments.html)
and [CloudFormation ImportValue restrictions](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/intrinsic-function-reference-importvalue.html).
Keep the exact target region pin instead of introducing a second `allowedRegions`
policy. Another named target may deploy an independent application into another region;
it adds no database replication, traffic failover, or connectivity between VPCs.

## Authentication

Additional OIDC/SAML federation is declared as a literal, environment-scoped array
in `framework-config/auth-providers.ts`; the native Cognito stack and its existing
app client consume it without changing Google/pool/client construct identities.
OIDC client secrets are catalog `resource.secret` references resolved through managed
ARN parameters, never authored values in TypeScript. Studio's Cognito creator uses
the same declarations and reviewed source journal. The Identity Pools stack template
uses native `identityPoolAccess` with pool-scoped authenticated trust, guest access
off by default, classic flows disabled, deny-on-ambiguous token mapping and no API
permissions by default. Recognized native stacks support reviewed ReaderRole
Allow/Deny statements and an explicit permissionless guest opt-in; IAM simulation
is read-only and separate from deployment and runtime authorization evidence.
See [Cognito, identity pools and domains](framework-studio/identity-and-domains.md)
for source paths, provider verification and retention boundaries.

The shared auth implementation spans client-app/src/lib/auth.ts, the auth and HTTP
entry points in framework/runtime, Cognito infrastructure, and auth Lambdas. Feature
GraphQL resolvers receive an authenticated session and separately enforce record authorization.

- Use Cognito ID-token bearer authentication. Validate signature, issuer, audience, sub,
  and token_use=id. Production HTTP API attaches its authorizer to auth routes, and
  handlers independently verify tokens. The local API also checks auth routes and supplies
  verified claims. Frontend route guards provide UX, not authorization.
- A handler that needs a signed-in user wraps itself:
  `export const lambdaHandler = authenticated(async (event, session) => ...)` from
  @repo/framework/runtime/auth. No session answers 401 `{"message":"Unauthorized"}`;
  unreachable Cognito signing keys answer 503, which the client treats as "try again"
  rather than as a signed-out session. `getAuthenticatedSession(event)` is the nullable
  form for a handler that decides for itself. Either one reads `USER_POOL_ID` and
  `USER_POOL_CLIENT_ID`, which the route is handed by declaring `userPool: true` (see
  [The user pool](#the-user-pool)); `framework:check` refuses a handler that verifies a
  token without them.
- The client keeps the ID token in memory. `frameworkHttpApiFetch` refreshes when needed,
  retries once after 401, and preserves replayable request bodies. Refresh is single-flight
  across tabs; only 401 expires the session. Network/5xx failures retain it and surface an
  unavailable state. Proactive renewal is part of the auth lifecycle.
- refreshToken and sessionMode are HttpOnly cookies scoped to Path=/api, so pages and assets
  never carry them. The browser calls same-origin /api; SameSite=Lax depends on this arrangement. CloudFront strips /api for the HTTP gateway;
  Vite proxies it locally without removing the prefix; the local API server mounts
  HTTP/service routes at /api. Agent routes use their explicitly declared same-origin
  paths and the same bearer/refresh lifecycle. Keep Vite base=/ and SPA fallback separate from API errors.
- Cookie-bearing auth endpoints validate trusted browser origins. Bearer-only GraphQL
  does not use ambient cookie authentication. Sign-out clears cookies and revokes refresh.
- Hosted UI uses authorization code flow with PKCE and state. Frontend /auth/callback and
  Cognito /oauth2/idpresponse have distinct purposes. Provider setup belongs in Production.
- Identity reconciliation never uses a matching email as authority to replace cognitoSub.
  Federated linking requires a provider-verified email *and* a confirmed native account whose
  own email is verified, and never happens while SKIP_EMAIL_VERIFICATION is on. A changed
  email takes effect only once verified (`keepOriginal`). The pre-signup trigger resolves
  provider names from Cognito, preserving configured casing; unproven linking is skipped.
  The provider must map emailVerified along with profile fields.
- Passwords need 12 characters and no particular character classes. Two-step verification
  is optional and uses authenticator apps (TOTP); users turn it on from the Security panel,
  which calls the `/mfa` route, and the login page answers the challenge.
- Dev trusts the configured local origin; production does not inherit localhost/LAN origins.
  HTTP LAN origins may support native login/CORS but not Cognito hosted-UI redirects.

### The user pool

framework.config.ts names the application's user pool once, and a workload that reads it
says so with one flag, as it does for the database:

```ts
// framework.config.ts
userPool: {
  userPoolId: resources.cognito.userPool.userPoolId,
  userPoolClientId: resources.cognito.userPoolClient.userPoolClientId,
},

// any Lambda, WebSocket authorizer, event, service, task or tool
"/reports": { directory: "...", methods: ["GET"], auth: true, userPool: true },
```

`userPool: true` hands the workload `USER_POOL_ID` and `USER_POOL_CLIENT_ID`, ahead of its
own environment, in both lanes: they are written as the two entries the workload would
otherwise declare, so AWS receives the stack's references and the local lane reads the
development manifest, exactly as for any other input. Nothing else changes: no permission
is granted (a Cognito API that needs IAM is still `resources.cognito.userPool.grant(...)`),
the frontend receives nothing, and a workload that does not declare it is handed nothing.

Two meanings of `auth: true` stay separate. On a route or a service it says who the
gateway admits, and says nothing about the handler: declare `userPool: true` as well when
the handler verifies the user itself (`authenticated`) or calls Cognito (`/sign-in`,
`/refresh`), and leave it off a handler that trusts the gateway alone. On a tool or an
agent, `auth: true` means its handler *is* the framework's verifier, so it is handed the
pool without asking.

A workload that names `USER_POOL_ID` and `USER_POOL_CLIENT_ID` in its own `environment`
keeps them and is handed nothing: that is how one workload verifies against another pool.
Naming one of them beside `userPool: true` is refused, as one name with two owners.
`userPool` takes catalog string references only, so an imported pool is
`resource.cdk<IUserPool>()` and another account's is `resource.fromEnv(...)`; a pool id
never appears in source. The HTTP API's and AgentCore's authorizers are built from the
pool bin/cdk-app.ts passes the framework factories (`cognito: cognitoStack`); keep it the
pool `userPool` names.

When changing auth, read [the agent checklist](playbooks/auth.md) and test all coupled
paths. Do not log tokens, secrets, or cookies. Local browser checks and deployed sign-in,
refresh, and sign-out checks are separate from unit tests.

## Generated contracts and verification

`framework:generate` validates inventory, emits route/target/payload projections, and
writes each service's documentation-only .env.example; it leaves the authored
cdk-app/.env.*.template templates alone. Adjacent contract.ts or contract.schema.json files
provide optional workload payload contracts; TypeScript contracts must be self-contained
apart from Zod imports. No custom handler-import arrays are needed.

`framework:check` also refuses workflow declarations that use a symbolic value where
JavaScript cannot honour it — a condition, a coercion, a template literal, a spread.

`contract` also emits Prisma and GraphQL artifacts and typechecks. `verify` checks framework
projections and GraphQL drift, restores database artifacts, and runs workspace and schema
tests. It does not run CDK synth or prove deployed behavior. After infrastructure/config
changes, synth both graphs using a configured AWS account. Each states its mode, and each
reads its own target's inputs file:

```powershell
npm --workspace cdk-app exec -- cdk synth --quiet
npm --workspace cdk-app exec -- cdk synth -c prodDeployment=true -c deployProdWebSocketApi=true --quiet
```

`cdk-app/test/deployment-isolation.test.ts` synthesizes both through the same entry point,
offline, and checks that they share no stack, physical name or export.

Review logical ids when moving constructs. The prod graph exposes cycles and resources
absent from dev.

### Reviewed deployment recovery

Studio development and production deployments require explicit review. Saved plan application and discard consume the reviewed artifact and target rather than importing current declarations, so broken/new source does not block recovery. The saved assembly digest covers manifests, templates and staged asset bytes; changed bytes or external links require a new plan. Review lists deployed stacks absent from the selected assembly as retained, never silently deletes them, and does not equate no template changes with drift-free or healthy operation. Required analysis failures block apply.

Teardown follows deployed identity, not synthesis. Prepare a saved, expiring deletion scope as documented in Production, then apply it with the typed deployment name. StackIds, account/region/mode, imports/data policies and opt-in protection/retain-failed choices are bound and rechecked. Unreadable required consequences block execution; phase/result journals distinguish completed stacks from remaining or unknown work.
