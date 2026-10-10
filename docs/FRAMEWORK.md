# Framework

`framework.config.ts` is the composition root. It imports defaults, the resource catalog,
and literal section modules under `framework-config/`. Those declarations drive CDK,
local execution, and generated browser route/payload contracts.

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
| HTTP Lambda | Public path in http | Explicit directory under cdk-app | [graphql](../framework-config/http/graphql.ts) |
| WebSocket Lambda | API Gateway route key in webSocket | Explicit directory; authorizer belongs to connect | [routes](../framework-config/websocket/routes.ts) |
| Event Lambda | Stable target id in events | Defaults to /lambda_functions/event_functions/id | [Cognito](../framework-config/events/cognito.ts) |
| Service | Public mount in services | /ecs_containers/services/id plus a Compose service | [example-service](../framework-config/services/example.ts) |
| Task | Stable target id in tasks | Defaults to /ecs_containers/tasks/id | [task](../framework-config/tasks/invocation-tests.ts) |
| Workflow | Stable target id in workflows | Graph declaration; no implementation directory | [workflow](../framework-config/workflows/invocation-tests.ts) |
| AgentCore tool | Stable target id in tools | Explicit directory under cdk-app, with contract.ts | [add-numbers](../framework-config/tools/example.ts) |
| AgentCore agent | Stable target id in agents | Explicit directory under agentcore at the repository root, with contract.ts | [example-agent](../framework-config/agents/example.ts) |

1. Add the implementation and its npm workspace manifest if appropriate.
2. Declare a literal entry in a section, using `satisfies HttpSection` (or the matching
   section type) imported type-only from `framework-config/contracts.ts` (for example,
   `import type { HttpSection } from "../contracts"` in framework-config/http/).
3. Add a new section module to the relevant array in root framework.config.ts.
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
Deployment mode separately says what the AWS graph constructs:

| Surface | Dev AWS graph | Prod AWS graph |
| --- | --- | --- |
| Cognito and declared AWS-invoked event Lambdas | Yes | Yes |
| Replay infrastructure | Yes | No |
| Website, RDS, HTTP gateway | No | Yes |
| Routed Lambdas, services, tasks, workflows | No; execute locally | If cloud-enabled |
| WebSocket API and its handlers | No | When DEPLOY_WEBSOCKET_API is on |
| Network (VPC) and database | No | Once a Lambda has `vpc: true` or `database: true`, or a container is built |

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

cdk-app/.env.dev.example and cdk-app/.env.prod.example are hand-authored templates:
`framework:generate` never writes them and `framework:check` never compares them. When
you declare a new `fromEnv` or `secret` line, add it to both templates yourself.

cdk-app/.env is the file itself, not process.env: a variable exported in the shell, or
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
imported from `@repo/framework/config/source`, which reads the same cdk-app/.env, so
synthesis, the local runner and the generator all read one answer. `bin/cdk-app.ts`
refuses a `-c` override that disagrees with it, because a catalog built from the file
cannot be re-decided after it was imported.

### Secrets

A secret has two sources and three deliveries. The sources:

- `resource.secret("NAME")` — a value authored only in cdk-app/.env, which
  `npm run deploy` uploads to Secrets Manager and supplies the ARN for.
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
npm run deploy -- --all -c useLocalDevStack=true --profile <PROFILE>
```

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
authored cdk-app/.env inputs and deployed resource attributes under each workload's chosen
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

Compose mounts .framework/local and cdk-app/.env read-only into the launchers. They stay
outside images and Watch synchronization. Workload configuration changes restart the
launchers. Recreate affected containers after changing authored inputs; restart after an
export to refresh long-running services/workflow integration bindings. Local secrets from
resource.secret() are read from authored inputs only. Linked development Secrets Manager secrets
are fetched at startup only when secrets requests a value; .arn stays an identifier.
The existing local PostgreSQL replacement remains explicit. Local AWS calls use the chosen
development credentials: a cloud grant does not grant permissions to that profile.

Successful development deployment refreshes the manifest and Compose .env automatically.
`npm run export:cdk-outputs -- --profile <PROFILE>` remains a standalone refresh. Production
deployment neither writes nor depends on either development file. Existing
cdk-app/.secret-bindings.json files are ignored and may be removed locally.

## Network and database

[framework-config/network.ts](../framework-config/network.ts) declares the application's VPC.
Only a production deployment builds it, and only once something needs it: a Lambda with
`vpc: true` or `database: true`, or a container.

```ts
export const network = defineNetwork({ cidr: "10.0.0.0/16", zones: 2, nat: false });
```

The layout is fixed: a public, a private and an isolated subnet in each zone. Private subnets
are dual-stack; IPv6 leaves through an egress-only internet gateway, which AWS does not charge
for. S3 and DynamoDB gateway endpoints sit on every route table. `cidr` and `zones` are set
once: changing either renumbers every subnet.

`nat` is the network's only cost, and nothing turns it on but this line. Off (the default),
the private subnets have no IPv4 route out. On, one NAT gateway (about $33 a month plus
$0.045 per GB) gives them IPv4: a container needs it to run in a private subnet, and a Lambda
in the VPC can then reach IPv4-only hosts too.

### Lambdas in the VPC

A Lambda runs outside the VPC, with the whole internet, unless it has `vpc: true`. Set it on
one Lambda, on a section (`defaults.http`), or on every Lambda (`defaults.lambda.vpc`), and
turn it off on any one with `vpc: false`. `database: true` implies it.

```ts
"/reports": { directory: "...", methods: ["GET"], vpc: true },
```

A Lambda in the VPC always runs in the private subnets, never the public ones: AWS gives a
VPC Lambda no public IPv4 address, so a public subnet would only lose the NAT gateway's IPv4.
It leaves over IPv6 (IPv4 too with `nat`), with `AWS_USE_DUALSTACK_ENDPOINT=true`, in one
security group every such Lambda shares; one that declares `database: true` joins the
database's group instead. Only TypeScript Lambdas run in the VPC, and an event that does
needs `localReplay: true`, because a dev deployment builds no network.

### The database

framework.config.ts names the database once, and a workload that uses it says so with one
flag. There is no secret to declare and no password anywhere in a workload:

```ts
// framework.config.ts
database: resources.rds.database,

// any Lambda, event, tool, service or task
"/graphql": { directory: "...", methods: ["GET", "POST"], auth: true, database: true },

// its handler
const database = getDatabase(databaseConnection());
```

In a production deployment, `database: true` on a Lambda:

- places it in the private subnets, in the one security group the database admits;
- grants it `rds-db:connect` for the database's IAM login, `app_user`, and nothing else;
- sets `PRIMARY_DATABASE_URL` (no password) and `PRIMARY_DATABASE_AUTH=iam`, from which
  `databaseConnection()` signs a 15-minute IAM token for every new connection, locally, with
  the workload's own role, over TLS verified against the RDS certificate authorities;
- sets `AWS_USE_DUALSTACK_ENDPOINT=true`, so its AWS SDK calls use endpoints reachable over
  IPv6.

`vpc: true` alone grants none of this: it places a Lambda, and only `database: true` reaches
the database. Only TypeScript Lambdas use the database: cross-language Lambdas and AgentCore
agents always run outside the VPC, and their database work belongs in a TypeScript Lambda or a
tool.

The database is ordinary CDK, built into the network with `frameworkVpc(this)`, with no
security groups or ingress rules of its own:

```ts
new rds.DatabaseInstance(this, "PostgresDatabase", {
  vpc: frameworkVpc(this),
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
  credentials: rds.Credentials.fromGeneratedSecret("postgres"),
  iamAuthentication: true,
  databaseName: "app_db",
  publiclyAccessible: false,
  storageEncrypted: true,
});
```

RDS insists on a master user with a password. The framework reads that password exactly
once, on deploy: a custom resource in the database's stack logs in as the master and creates
`app_user`, with `rds_iam`, no password, and the right to create tables in `public`. It is
not a superuser. Migrations run as `app_user` too, so it owns every table. A release
therefore deploys first and then migrates: `npm run db:migrate:cloud -- --profile <PROFILE>`
runs the `db-migrate` task inside the network.

### Containers

A container always runs in the network, in the subnet `cloud.subnet` names, inherited from
`defaults.container.subnet` (default `"public"`). A public one gets a public IPv4 address and
no inbound rules. A private one needs `nat: true`: Fargate pulls its image over IPv4, so
configuration refuses a deployed private container without it, in every mode. Synthesis
prints what the network holds, what it costs, and who uses the database.

### In development

**A dev deployment builds no network and no database.** The database is absent from the dev
graph and runs under Compose, so asking for the network there is an error. The local lane
holds the network's rules instead, which is what keeps "works locally" meaning "works in AWS":

- `PRIMARY_DATABASE_URL` (the Compose Postgres) reaches only a workload that declares
  `database: true`.
- A Lambda in the VPC (`vpc: true` or `database: true`) runs with
  `AWS_USE_DUALSTACK_ENDPOINT=true`. Without `nat`, it also runs under an egress guard that refuses, at once and with the reason, any host that publishes no
  IPv6 address, as the private subnets would by timing out.
- Configuration refuses `database: true` on an agent, a workflow or a cross-language Lambda,
  on an event without `localReplay: true`, and a workload that reads anything else from the
  database's stack without declaring it. It refuses `vpc: true` on a cross-language Lambda
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
Use application storage for task results. Long-running services have individual Compose
entries; tasks/workflows are launched dynamically by the invocation runner.

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
`exists`, `isNull`. Follow the [working graph](../framework-config/workflows/invocation-tests.ts)
and the typed API in [workflow definitions](../packages/framework/src/config/workflows.ts).

An `invokeLambda` target is declared under `events`: a workflow is one more native invoker
of an event Lambda, like the step in
[events/invocation-tests.ts](../framework-config/events/invocation-tests.ts).

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

The [capability fixture](../framework-config/workflows/capabilities.ts) exercises
DynamoDB reads/writes, SQS, SNS, EventBridge, an AWS-operation bridge, nested
workflows, map/wait, and a container callback. Its resources are created only in
development. `http.request` needs an external endpoint and Connection and is not
covered by this fixture.

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

### Invocation smoke checks

After the authorized dev deployment and Compose rebuild, run
`npm run workflows:smoke`. Both fixture workflows must reach `succeeded`; the
command fails on a refused submission, failed execution, or polling timeout.

After development setup, use the authenticated UI or POST JSON `{ "message": "hello" }`
to /test/run-task and /test/start-workflow with a valid Cognito ID token. Through the
frontend origin use /api/test/...; against the API directly omit /api.

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
| cdk-app/.env | Authored deployment settings and local inputs. Deployment flags may be overridden by the shell or `-c`; PROD_DEPLOYMENT and resource inputs are read from the file itself |
| Root .env | Fixed development Compose/auth/replay/port controls |
| .framework/local/resources.json | Discovered development resource and workflow identifiers; never raw secrets |
| client-app/.env | Browser-public VITE_ values from the deployment |
| Service .env.example | Generated input documentation; no authored per-service env files |
| docker-compose.yml | Local containers, launchers, read-only mounts, ports, readiness, and Watch |
| cdk-app/deployment.ts | Application deployment input validation, precedence, and compatibility aliases |

The graph a synth builds is PROD_DEPLOYMENT in cdk-app/.env: the resource catalog reads it
when it is imported. `-c useLocalDevStack` or `-c prodDeployment` may state the same answer,
and the CDK app refuses one that disagrees with the file. Ordinary settings use context,
environment, then fallback. New deployment-wide flags belong in deployment.ts plus tests;
workload inputs belong in the resource catalog instead.

The principal deployment settings are CDK_APP_NAME, PROD_DEPLOYMENT,
RETAIN_STATEFUL_RESOURCES, DATABASE_BACKUP_RETENTION_DAYS, DEPLOY_WEBSOCKET_API,
COGNITO_SES_FROM_EMAIL (with optional COGNITO_SES_FROM_NAME and COGNITO_SES_REGION),
SKIP_EMAIL_VERIFICATION (development only), frontend/Cognito custom-domain toggles and
certificate pairs, and optional Google credentials. USE_CUSTOM_WS_AUTHORIZER is retired: the
declared authorizer is always attached, a leftover `true` is ignored with a warning, and
`false` is refused. Environment examples list authored settings; deployment.ts is the exact
reference for accepted context keys and legacy aliases. Avoid adding new aliases or copying
legacy precedence exceptions.

The website's API origin depends on the HTTP gateway, while Cognito needs frontend URLs.
With a configured frontend origin, resolution excludes the website token from auth/CORS
inputs to prevent a cycle. **Current limitation:** the generated CloudFront-domain-only
path has no /api behavior. A complete deployed browser/auth flow needs the configured
frontend-domain path described in Production. Do not hide that limitation by switching
the browser to cross-origin requests.

## Authentication

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
  form for a handler that decides for itself.
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

When changing auth, read [the agent checklist](../agents/auth.md) and test all coupled
paths. Do not log tokens, secrets, or cookies. Local browser checks and deployed sign-in,
refresh, and sign-out checks are separate from unit tests.

## Generated contracts and verification

`framework:generate` validates inventory, emits route/target/payload projections, and
writes each service's documentation-only .env.example; it leaves the authored
cdk-app/.env*.example templates alone. Adjacent contract.ts or contract.schema.json files
provide optional workload payload contracts; TypeScript contracts must be self-contained
apart from Zod imports. No custom handler-import arrays are needed.

`framework:check` also refuses workflow declarations that use a symbolic value where
JavaScript cannot honour it — a condition, a coercion, a template literal, a spread.

`contract` also emits Prisma and GraphQL artifacts and typechecks. `verify` checks framework
projections and GraphQL drift, restores database artifacts, and runs workspace and schema
tests. It does not run CDK synth or prove deployed behavior. After infrastructure/config
changes, synth both graphs using a configured AWS account. The graph follows
PROD_DEPLOYMENT in cdk-app/.env; for the other one, point FRAMEWORK_INPUTS_FILE at a copy of
the file with the other value, and state the same mode with `-c`:

```powershell
npm --workspace cdk-app exec -- cdk synth -c useLocalDevStack=true --quiet
$env:FRAMEWORK_INPUTS_FILE = "<PROD_COPY_OF_CDK_APP_ENV>"
npm --workspace cdk-app exec -- cdk synth -c useLocalDevStack=false -c deployWebSocketApi=true --quiet
Remove-Item Env:FRAMEWORK_INPUTS_FILE
```

On macOS or Linux, an inline assignment scopes the variable to the one command:

```sh
npm --workspace cdk-app exec -- cdk synth -c useLocalDevStack=true --quiet
FRAMEWORK_INPUTS_FILE="<PROD_COPY_OF_CDK_APP_ENV>" npm --workspace cdk-app exec -- cdk synth -c useLocalDevStack=false -c deployWebSocketApi=true --quiet
```

Review logical ids when moving constructs. The prod graph exposes cycles and resources
absent from dev.
