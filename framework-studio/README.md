# Framework Studio

A local view of `framework.config.ts` with reviewed resource creation and targeted
source editing. It shows:

- what each declaration is;
- where it runs: Development and Production, with execution location shown inside each;
- what it reads, grants and invokes;
- where it was written.

Declarations use the same [code-first layout and tags](../docs/framework-studio/declarations-and-tags.md)
when authored by hand or created in Studio. Tag edits use source review. Isometric always keeps topology; its tag filter fades
nonmatches without changing placement, identity or source.

The **Database** tab (`/database`) is a source-first Prisma 8 workbench with three
workspaces: **Schema**, **History & migrations**, and **Database status**. Edit the
authored `packages/database/prisma/contract.prisma` beside its diagram, navigate between
fields and source, format and validate with the installed Prisma interpreter, then
review the complete source change before saving. Invalid drafts preserve text and undo
history; the retained diagram is explicitly marked as the last valid schema. CodeMirror
supplies search/replace, completion suggestions, folding and familiar keyboard shortcuts.
Suggestions are static and local; semantic completion and safe rename are unavailable.

History reads the actual migration graph, operations, SQL and semantic snapshots without
executing migration code. Compare historical, saved and valid draft contracts, choose an
explicit baseline, then plan with pinned Prisma in a disposable workspace. Review the
actual migration files before saving new artifacts. Database status requires a selected
target and read-only inspection; a matching marker alone never establishes physical
schema compatibility. Local Compose PostgreSQL is supported through its existing literal
loopback binding. Production IAM/TLS access remains outside this workbench. Database
application is a separate target-bound review and typed approval; opening the page and
inspection never start Compose. See the [Database workbench guide](../docs/framework-studio/database-workbench.md)
for exact effects, evidence, keyboard behavior and limitations.

The **Deploy** tab (`/deploy`) provides deployment discovery, reviewed operations and
local development controls. See [Deploy & Run](../docs/framework-studio/deploy-and-run.md).

Local PostgreSQL appears in Board and Isometric as the Compose `postgres`
service. In Isometric it stands in the VPC's isolated subnet right beside RDS, solid in
Development and faded in Production (it runs on your machine, not in AWS). Database edges from local execution
reach PostgreSQL, while AWS bindings retain their catalog destination. Both databases
offer **View schema** in the inspector. Image, named volumes and source come from
the authored `docker-compose.yml`. These architecture nodes contain no credentials or
runtime health. Database status performs a separate selected-target observation;
arbitrary Compose runtime overrides remain unsupported.

```powershell
npm run studio            # http://127.0.0.1:4590/  (--port <n>, or STUDIO_PORT)
npm run studio -- --print # the whole model as JSON, then exit
```

It runs on your machine beside your editor, not in Compose. When it writes a file,
Compose Watch carries the change into the running dev servers, just as a save in your
editor would.

After changing Studio's server code or edit-field registry, restart `npm run studio`.
Application declarations refresh automatically; Vite refreshes the browser UI, but it
does not reload the server's edit registry.

## Add to application

Use **Add to application** in Board or Isometric, choose a resource, and configure
its form. Advanced settings contain runtime sizing, placement and catalog bindings.
**Review generated changes** checks both deployment graphs and TypeScript, then
shows the complete patch grouped by file, including new files and generator output.
**Back to Editing** and **Back to resource types** retain the current form.
**Apply All** is the approval to write that exact patch. A successful write rebuilds
the source index and graph, selects the canonical resource and opens its Inspector.
Global undo/redo includes its scaffolding and generated artifacts.
Descriptions use `framework-config/descriptions.ts`, the same metadata source
the existing Inspector edits, for every resource family.

| Entry | Authored source | Supported creation choices |
| --- | --- | --- |
| Function | Existing `framework-config/workloads/events.ts`, `http.ts` or `websocket.ts` map; registration only if absent; `cdk-app/lambda_functions/<category>/<id>/index.ts` | Event, HTTP and WebSocket; Node 22/24 zip; memory, timeout, architecture, subnet; authenticated HTTP wrapper and pool binding; optional input/secret binding |
| Stack | `cdk-app/lib/app/<class-name>.ts`, typed catalog entry, import and instantiation in `cdk-app/bin/cdk-app.ts` | Actual SQS queue exposed as a typed public field, `linkResources`, deployment-prefixed stack/output identity; both/dev/prod scope |
| VPC | New `framework-config/networks/<id>/index.ts` and a literal registry reference | Independent VPCs with private /16, two/three zones, NAT, IPv6 egress and endpoints; unused VPCs appear as blueprints |
| Workflow | Existing workflows.ts map; registration only if absent | Executable pass-through workflow, or a sequence of existing event Lambdas/tasks; deployment lanes and execution timeout; native workflow DSL and IR |
| Container service | Existing services.ts section, `cdk-app/ecs_containers/services/<id>/{index.mjs,Dockerfile,package.json}` | Node HTTP server and health endpoint; mount, port, gateway auth, CPU/memory, architecture, subnet, input/secret binding; local-only default |
| Container task | Existing tasks.ts section, `cdk-app/ecs_containers/tasks/<id>/{index.mjs,Dockerfile}` | Run-to-completion Node container reading `FRAMEWORK_TASK_INPUT`; sizing, architecture, subnet, deployment lanes, input/secret binding; timeout belongs to its invocation |
| API route | Existing HTTP/WebSocket section; optional new handler | New Lambda or an existing routed Lambda of the same category. Reused functions retain their authentication, bindings, handler and construct identity. HTTP methods and literal route paths use normal conflict validation |
| Agent | Existing agents.ts section, `agents/<id>/{index,contract}.ts`, workspace manifest and tsconfig | AgentCore JSON responder; validated Zod contract; bounded model/tool loop using `@repo/models`; existing tools; authenticated browser route or IAM service agent; input/secret reference |
| Input parameter | Resource catalog; commented keys in both input templates; optional consumer section/import | String or enumerated string, declaration default, required flag, description, group, existing consumer mapping |
| Secret | Resource catalog; commented keys in both input templates; optional consumer section/import | Declaration only, required flag, description, group, existing consumer mapping; automatic ARN/read permissions for Lambdas/agents and startup-value delivery for containers |

The framework's real generator runs in a disposable source copy before review.
Changes to framework IDs, browser contracts, agent contracts, service environment
examples and Compose are included when needed. Service and agent workspace metadata also
uses npm 11's offline lockfile generator; it never installs dependencies into the
application. Start Studio with npm 11. New workspaces require rebuilding local
development images with `dev:containers`; creation does not start containers.

Source creation never synthesizes, deploys, provisions secret values or writes
authored environment files. Inputs and secrets share declarations across graphs;
their authored values remain independent in `cdk-app/.env.dev` and `.env.prod`.
Use the protected environment-file Inspector for values as a separate operation.
Network and container forms expose cost-relevant settings before approval.

Creation uses the existing `DraftEdit` union, `InspectorDraft`, `BatchEditor`,
`EditService` history, source splices and evaluator processes. New modules are
resolved from an in-memory overlay during preflight. The API accepts typed resource
requests, not source text, shell commands or destination paths. Every destination
has a fixed allowlist and rejects traversal and symlink components. Reviews retain
source hashes, generator-input hashes and absence checks. New files are installed
exclusively through temporary files; undo removes them only while their bytes still
match. Both modes must match the reviewed resource identities and semantics after
writing. Failed writes or verification restore unchanged files and remove generated
files; concurrent edits are preserved and reported as unconfirmed. As with existing
batch edits, this is compensating restoration, not a durable crash-recovery journal.

The initial creators deliberately support the repository's conventional literal
section layout and TypeScript zip handlers. Python/image Lambda scaffolding,
arbitrary existing Docker build contexts, custom CDK construct templates and stack
dependencies, agent streaming/history implementations, multi-binding editors and
arbitrary workflow graph construction remain source-authored. Event triggers and
failure destinations use the existing Inspector after creation. Adding a route to
an existing function preserves that function's settings rather than generating a
second implementation. The framework has one VPC and string-valued inputs; the
creator does not introduce additional VPCs, numeric inputs or a second configuration
model. Computed declarations that cannot be safely spliced are refused before any
application file is written.

The design, history and roadmap are in [docs/framework-studio](../docs/framework-studio/README.md).

The isometric map arranges islands using weighted dependencies and projected crossing,
length, obstacle and viewport costs. Small edits retain nearby positions; major workspace
aspect changes reflow automatically. Pan, zoom, search, selection and the mode switch keep
the current arrangement. See [graph-aware layout and measurements](../docs/framework-studio/graph-layout.md).

## What it shows, and where that comes from

Framework behavior comes from the framework's own answers. CDK links are separately marked source inferences:

- **Targets, routes and relationships.** These come from `getFrameworkTargets` and
  normalization. Env references, grants, `database: true`, invocations, workflow steps and
  integrations, and agent tools are all shown.
- **Deployment availability.** This comes from `isTargetEnabled` and `isTargetDeployed`, for both graphs,
  including the special rules: a tool follows its agents, an event has no toggle, and a
  development deployment builds only what AWS invokes.
- **Production placement.** This comes from `resolveLambdaTarget` and the network helpers.
- **Source locations.** These come from `locateConfigSource` in
  `packages/framework/scripts/config-source.ts`, the same reader `framework:check` uses.
- **Stack members.** These are read from each `resource.stack<T>()` class.
- **Link sites.** These are `linkResources` calls found in `cdk-app/lib`.
- **CDK resource links.** The studio parses linked stack constructors for direct public-member references, SNS SQS subscriptions and EventBridge rules. These edges have their own category, source locations and inference label. No CDK code is executed by this scan.

Each logical graph is evaluated in its own child process, with a synthetic inputs file holding
only `PROD_DEPLOYMENT`. Graph evaluation receives only deployment-mode and WebSocket flags;
the server reads each mode's WebSocket flag from its selected inputs file. Authored values
never enter evaluator processes.

## CDK environment files and input parameters

**Input parameters and secrets** contains only inputs and secrets declared in
`framework-config/resources.ts`. **CDK environment files** is a separate island with `cdk-app/.env.dev` and
`cdk-app/.env.prod`, using the same full-path labels as `client-app/.env`. File-to-parameter links come from actual assignments, including empty ones;
missing entries stay visible in the inspector without pretending to supply a value.
Catalog identities are reused, preserving their workload and secret-consumer links.

**Required input** in a parameter or secret inspector stages a catalog `.required()`
flag through the normal review/apply flow. Existing conditional and per-workload
requirements are also evaluated. Missing or whitespace-only effective values create a
red connection with an X, including when the variable has no assignment yet. Select the
connection to see the environment, why it is required, and actions to edit the environment
file or parameter default. Parameters can use non-blank declaration defaults; secrets
must be supplied in the local environment file and never get source-code defaults.
File inspectors summarize required inputs and offer **Set NAME** actions. Requirements
are checked against each mode's own file (`cdk-app/.env.dev` or `cdk-app/.env.prod`);
template values are references only. Unknown reads are reported separately from missing
values. The graph carries presence and requirement metadata, never authored values.

Selecting a file opens an editor for all of that file's variables, including settings
such as `PGADMIN_HOST_PORT` that have no catalog declaration. Edit multiple values or
add variables, then **Review Changes** and **Apply All**, or discard the draft. Navigation
and browser exit use the same unsaved-change guards as other inspectors. Existing secrets
are masked with an explicit reveal control; new values are masked initially. The review
lists changed keys with values redacted. File revisions are checked before review and
again before applying, so another editor's save is preserved. Only the selected mode's
file is written; saving does not synthesize or deploy. Dotenv syntax and value round trips
are checked; infrastructure validation remains a separate synthesis action.

File-to-resource links use catalog declarations only. Other variables stay inside the
file inspector. Names, configured/empty/missing status and declaration-default use remain
available without values in the map. Values load only into the selected inspector and its
in-memory draft, outside graph/search data and query caches. Missing example/catalog keys
can be added from **Not set in this file**. `PROD_DEPLOYMENT` follows the file's mode.

There is no `cdk-app/.env`: the mode (`-c prodDeployment`) picks `.env.dev` or `.env.prod`.
A file that has not been generated wears a red cross on its node in the isometric view.
Select the **CDK environment files** island to see which files exist and **Generate** the
missing ones, or select a file and use **Generate .env.<mode> from template**. Generation
copies `cdk-app/.env.dev.template` or `cdk-app/.env.prod.template` without overwriting an
existing file; production is never seeded from development. Both files are ignored by Git.

Studio synthesis reads `cdk-app/.env.dev` or `cdk-app/.env.prod` for its selected mode. File
changes refresh the map and stale the matching inventory; generating a file does not deploy.

## Client-app environment mappings

The **Client-app environment file** island contains `client-app/.env`. Its inspector is
a searchable source overview. Expand a field to choose its source type, then its CDK input,
stack/output or region; URL sources expose protocol, hostname, port and an optional override.
The environment buttons follow the graph and its unsaved-change guard. Each field shows a
symbolic preview and source status that update with its draft, plus an individual reset.
Each variable's Dev/Prod pills independently include or omit it from that environment's
generated file; **Empty value** keeps an empty value. Rename a field inline while retaining
both source recipes, add new `VITE_` fields, or remove a field from both environments.
Renames reject duplicate names and require updating application reads of the old name.
Stack outputs can permit an empty value when
their stack is off. Choosing a new stack requires explicitly choosing its output; existing
fallback output lists are retained until that selection changes.

Edits stage in the existing **Review Changes → Apply All** flow, with discard, navigation
guards, source conflict detection, and global undo/redo. References are saved as literal
mapping declarations in `framework-config/client-environment.ts`, reread on every refresh.
Descriptions and file/export guidance are collapsed. This editor does not generate
environment files or load their values. The next `export:cdk-outputs` reads the saved literal
mappings, resolves public references against that deployment and its mode's CDK inputs,
and validates everything before writing files. Vite's `.env.*.local` files remain the export
destinations, taking precedence over `client-app/.env`. Missing required sources and secret
references fail without changing existing files; optional outputs are empty only when
their stack is absent. Opening, editing and applying the inspector never runs export.

The initial mappings are:

| Variable | Development source | Production source |
| --- | --- | --- |
| `VITE_API_GATEWAY_URL` | CDK `VITE_API_GATEWAY_URL` override, otherwise `http://localhost:${LOCAL_API_DEV_SERVER_HOST_PORT}` | Frontend stack `CloudFrontUrl` output |
| `VITE_LOCAL_WS_URL` | `ws://localhost:${LOCAL_WS_DEV_SERVER_HOST_PORT}` | Empty |
| `VITE_API_GATEWAY_WS_URL` | WebSocket stack `WebSocketAPIEndpoint` when enabled, otherwise empty | Same rule |
| `VITE_WS_TESTER_URL` | `http://localhost:${WS_TESTER_HOST_PORT}` | Empty |
| `VITE_AWS_REGION` | Cognito stack's deployment region | Cognito stack's deployment region |
| `VITE_USER_POOL_ID` | Cognito `UserPoolId` output | Same output in the selected deployment |
| `VITE_USER_POOL_CLIENT_ID` | Cognito `UserPoolClientId` output | Same output in the selected deployment |
| `VITE_COGNITO_DOMAIN` | Cognito `UserPoolDomainUrl` output | Same output in the selected deployment |

CDK inputs always refer to the selected mode's `.env.dev` or `.env.prod`; there is no
legacy `cdk-app/.env`. Both CDK files connect to `client-app/.env` in the map, each in
its own environment, even when that environment's fields all use stack outputs.
This file relationship describes the input context; it does not generate client files.
Region comes from Cognito's deployment rather than
`LOCAL_AWS_REGION`, which can name a different region for local SDK calls. An absent
WebSocket stack permits an empty URL; an enabled stack missing its output is reported as
unavailable. Snapshots and search carry variable names and recipes, never resolved values.

## Synthesized infrastructure

Select the **Stacks** island to open **CDK infrastructure** in the inspector. Choose
Development or Production in the header, then **Synthesize CDK** to build the inventory,
or **Refresh from CDK** to regenerate it from saved source. A catalog stack's
**CDK infrastructure** disclosure shows scoped resources inline; **Show all infrastructure**
returns to the Stacks inspector. Opening an inspector, switching modes and editing source never synthesize
automatically. Apply or discard a pending inspector draft first; synthesis reads saved source.

This runs the app configured in `cdk-app/cdk.json` (`bin/cdk-app.ts`), so it includes
application stacks and resources that have no `framework-config` declaration. Only
resources that the selected configuration actually constructs appear. A stack inspector
starts with an owner filter; **Show all infrastructure** clears that scope. No existing
CloudFormation deployment is required.

The searchable inventory groups resources by stack, with owner and CloudFormation-type
filters in **Filter resources**. Freshness stays beside the refresh action; synthesis
time, inputs and credential context expand under **Synthesis details**. Stack inspectors include their complete resource collection, including unknown
owners. Resource details show logical IDs, construct paths, explicit ownership evidence,
owner declaration links and separate CloudFormation dependencies. Generated roles,
policies and log groups stay in this panel rather than adding map nodes. Imported references
are listed only where CDK explicitly identifies them; this is not deployed-resource discovery.
The asynchronous Lambda, WebSocket Lambda and WebSocket API stacks are hidden from
this browser because their declarations are managed through framework config. The
database stack is labeled **Framework managed** and remains visible.

Synthesis uses a private disposable copy of the selected mode's input file with matching mode/context,
and an isolated assembly. It can bundle assets and perform normal CDK context lookups
using configured credentials. It never deploys, uploads secrets or changes the active
inputs file. Production validation still applies: development-only inputs must be resolved
before a production synthesis succeeds. Account/region resolution and uncached CDK context lookups
can still need configured AWS credentials; generating templates does not deploy anything.

Each mode retains its last successful inventory in the running Studio server. Source,
input or context changes mark it stale; a failed synthesis retains it with a visible error.
Generation time, input origin and profile are shown. Restarting Studio clears these
in-memory inventories. Raw template properties, outputs and input values are excluded
from the inventory. See [architecture](../docs/framework-studio/architecture.md#infrastructure-inventory)
for the reusable reader, runner and current limits.

## The isometric view

`/isometric` draws the same model as a landscape of floating islands, on a 2D canvas.

Relationships between the same visible source and destination share one connection.
Connection hover popups, inspectors and relationship rows show Dev and Prod pills, with
unavailable environments dimmed based on the relationships and both endpoints.
Grouped inspectors show shared endpoints once and list each relationship in a compact expandable row.
Click a grouped line to inspect a connection map with every field mapping,
relationship, environment and expandable source evidence or required-input guidance.

The backdrop is a thin isometric grid anchored to the terrain's world coordinates.
Entities use locally bundled official AWS SVG service icons on small plinths, with Lucide
SVGs for generic framework concepts. Board and Inspector share the icon mapping.
See [icon sources](public/icons/README.md).

Search at the top of the map highlights matching names, services, paths, input keys,
stack fields and network fixtures, fading nonmatches. Clicking a node or island temporarily
shows its normal selection view; clearing the selection restores the retained search.
Clearing the query restores the overview. The isometric map uses one graphite style.

Catalog stacks without a constructor reference in the CDK app's runtime imports carry
an unplug badge and **Not added to CDK app** in their inspector. This is source evidence:
conditional constructors are references, and deployment status is not queried. Unreadable
entry points or unresolved local imports leave usage unknown instead of marking stacks
unused. The configured database and its stack carry a **Framework managed** lock badge.
The Stacks island also includes the stack classes whose public `CfnOutput` declarations
match the root `.env` export mapping: Cognito, development replay, frontend website,
HTTP API, WebSocket API and RDS. Existing catalog identities are reused. Other managed
stacks are omitted. Each inspector lists only mapped outputs, with a `$` symbolic source
value and its destination environment variable; literals, dotenv values and deployed
output values are never loaded into this projection. Complex expressions use an output-name
token. Environment availability follows the framework lifecycle and WebSocket AWS lanes.
Stacks projected from CDK without a catalog declaration also show **Not defined in
resources**, independently of **Framework managed** and **Not added to CDK app**.
This status appears in stack inspectors, the Stacks island list and map hover guidance.
Adding a matching `resource.stack<T>()` catalog entry reuses its catalog identity and
removes the missing-declaration flag on refresh; Studio does not add entries automatically.
The RDS database also appears on the VPC terrace selected by its literal `vpcSubnets`
configuration (isolated in this app), with database connections reaching that node.

API node inspectors and the APIs island list show **Managed by framework-config/…**
for the HTTP, services, WebSocket or agents section that derives each route. The
existing source link points to its declaration.

Event Lambda inspectors offer **Local replay** through the shared switch and review
flow. Review includes both `localReplay: true` (or its removal) and the selected
TypeScript handler's `withLocalReplay` wrapper. Apply, undo and redo keep the files
together and preserve concurrent handler edits. Unsupported handler patterns require
source edits; framework validation refuses disabling replay while the event requires
local execution. Run `npm run framework:generate` after applying to refresh the replay
manifest. Only replay-enabled events connect to `DevLambdaReplayStack`; production
retains the relationship with the development-only stack faded out.

The view follows the model:

- Every building is an entity the model names, under the model's own id.
- Selecting a building selects that entity everywhere, and opens the same inspector, with
  the same edits.
- Positions, islands and colours are layout, computed from the model on every refresh.
  Nothing about them is written to disk or read back as configuration.
- Nodes share a four-cell lattice within each layer, including across service types,
  with truncated captions anchored above each icon. Hover and selection keep captions in place.
  Dev/Prod tags sit separately on the plinths, leaving the full caption width for names.
  Islands shrink, grow and shift through the same row packer as declarations change.
- Hover empty terrain to highlight an island; click it to open island settings. Shared
  defaults have service-type menus (HTTP, WebSocket, events and tools), boolean switches,
  and counts of inheriting workloads versus overrides. Defaults apply across islands and
  to future declarations; explicit node overrides win. Changes share the inspector's
  draft, review and undo flow. Islands without shared framework defaults link to their entries.

The regions mean something:

| Region | What stands there |
| --- | --- |
| Entry islands | One shared APIs layer for HTTP, WebSocket and agent routes |
| Compute | One shared layer for HTTP, WebSocket and event Lambdas outside the VPC; AgentCore agents and their tools; Step Functions workflows |
| The VPC | Level public, private and isolated subnet terraces. Each workload stands on the terrace its production placement names; Compose PostgreSQL stands on the isolated terrace beside RDS, with the same declared application schema |
| Catalog | One shared Stacks island with a node per stack class and public fields in the inspector; a separate island for individually selectable inputs and secrets |

HTTP, WebSocket and event Lambdas share one layer. HTTP, WebSocket and agent APIs
share another, without group boundaries.
VPC-attached Lambdas retain their subnet placement inside the VPC boundary.

The Development/Production switch changes how each building is drawn, never where it
stands:

| Drawing | Meaning |
| --- | --- |
| Solid | Enabled in the selected environment (Development includes local execution) |
| Dashed ghost | Outside that environment, or disabled |

The VPC is drawn as a blueprint wherever no deployment builds it. Its gateways and
endpoints are translucent with dashed plinths in those environments, including Development. Deployment labels are
quiet by default: no badge means both environments. A teal flask **Dev** badge means
Development only; a violet diamond **Prod** badge means Production only. **Off** marks
disabled workloads. Board and Isometric share these badges, including catalog resource absence
across the two mode models. The Inspector uses two
environment cards. Local and AWS are execution locations within Development, never a
third environment. The framework's underlying deployment settings are unchanged.
Workloads and routes share a **Deployment** section directly below their identity,
with the same cards and **Deploy** selector: Dev + Prod, Dev only, Prod only and Off.
Routes edit their owning workload; staged changes immediately preview in the cards.
Catalog resources and local services reuse the cards and identify what controls their
availability. Catalog availability describes declarations, not deployed health.
Edit intents retain the framework's source tokens.
WebSocket options also account for each environment's own AWS API flag, so the labels do not
claim a production deployment where no API exists, or hide its AWS-backed Development execution.

| Input | Action |
| --- | --- |
| Drag | Pan (a press that moves less than 6 px is a click) |
| Wheel or pinch | Zoom about the pointer |
| Double-click | Fly to a building |
| Arrow keys, `+` / `-`, `0`, `F`, Escape | Pan, zoom, fit, focus the selection, clear it |

Edges are the model's typed relationships, in the Board's six categories. All categories
remain visible in the isometric map. Hovering an edge, a building, a gateway or the ground
explains it. A building's hover card shows its authored description (including an unsaved
draft), always a **Dev** and a **Prod** pill (lit when that environment deploys it, dark
when it does not, so a missing environment is as visible as a present one), and a
**Framework-managed** pill for stacks and resources the framework owns. Both environments
are always read, so the Dev/Prod switch does not change the pills. Packets move only along the selection's edges, and the Pause button or
reduced-motion stops them. A still picture draws no frames.

Startup and watched CDK source changes automatically rebuild the ignored internal index
at `.cache/framework-studio/cdk-links.json`; no manual map refresh is needed.
For example, `referenceExamples` shows bucket → topic (EventBridge), topic → queue (SNS),
and queue → dead-letter queue. The index contains only source hashes, entity ids and
relationship evidence. It is disposable; framework configuration and CDK never read it.
The scan handles direct constructor statements and simple `const` aliases. Helpers,
branches, loops, dynamic member names and runtime behavior remain unresolved.

`window.__studioLandscape` exposes read-only camera, picking and frame statistics, for
tests and the browser console.

## What it edits

Event Lambdas and compatible public stack fields have a collapsed **Triggers** section.
**Add trigger** walks three steps. **Source**: every service that can invoke the event, then
that service's stack fields (from a field's inspector, the event Lambda instead). Only
choices that work for this Lambda can be picked; the rest say why beside their source line
(a missing stream, a FIFO topic, a native consumer, a short queue visibility, local replay
that cannot answer a synchronous source). A service with no field shows the code to add
one. **Settings**: defaults are filled in (the first free Cognito hook, the bucket's own
S3 delivery, `LATEST` for streams); EventBridge takes a source and detail type, S3 takes
Object created/removed, a schedule takes an interval or a daily time, and tuning sits under
**Advanced options**. **Confirm**: a checklist of everything still missing, all at once,
plus warnings (a stack not yet in the CDK app) and AWS advice; acknowledge the handler
contract and **Add trigger** stages it. A **Schedule** needs no resource. A Lambda with an
asynchronous trigger also shows **When a run fails**, which stages its `onFailure` queue or
topic. Then use **Review Changes** and **Apply All**. Changes, reassignments and removals
share exact undo/redo and source-conflict checks. Preview checks both graphs and
TypeScript; it never executes CDK or deploys.

Every trigger row has a delete button. A removed row stays struck through with **Restore**
until you review. Native wiring Studio recognizes exactly (a `lambdaTriggers` entry, a
constructor `addEventSource`/`addSubscription`/`addEventNotification`/`addTrigger` statement,
or an EventBridge rule target) is deleted from its stack file, and unused imports go with
it. Anything nested or computed says why and links to the line instead.

Every map node, public stack field, island, gateway and endpoint has a **Description**
in its inspector. Descriptions are shared by Development and Production and saved as
literal strings in `framework-config/descriptions.ts`, keyed by canonical entity ID.
Descriptions show a compact preview; choose **Edit** to open the editor, then
**Review Changes** and **Apply All**. Description
edits use the existing unsaved-change guards, conflict detection and undo/redo history.
HTTP route renames move their descriptions to the new route ID in the same change.
New declarations can add their description from the inspector; existing entries are
authored documentation, never generated or overwritten on refresh. Input-setting and
environment-variable changes are reviewed separately from their description edits.
Saving descriptions does not change deployment behavior or deploy infrastructure.

Connections offer **Add description**, including each relationship inside a grouped
connection. These optional notes use the same review, apply and undo flow and are shared
across environments. They follow the relationship's endpoints, type and mapping label,
so reordering declarations does not move notes to another mapping. **Configuration**
separately expands the generated binding details and source evidence. Those facts come
from declarations; edit the linked source or its inspector settings to change behavior.
Connections without details show no placeholder context.

It edits `deploy`, a Lambda's `subnet`, `memorySize`, `timeoutSeconds`, `architecture`,
`packaging`, `logRetentionDays`, its managed `runtime`, and Node ZIP bundling's `minify`
and `sourceMap`, plus a container's `cloud.subnet`. Controls appear only where applicable:
container Lambdas get their runtime and handler from their Dockerfile, and Python ZIPs
have no esbuild controls. The inspector also shows implementation type, source directory
and resolved handler. All values use the framework's own resolution and default cascade.

Edits require a source literal, or an absent field whose parent is an object literal.
Anything an expression computes is shown read-only. Architecture and runtime changes
share the draft, validation, write, undo and redo flow; changing packaging does
not create a Dockerfile or rewrite handler source.

Selecting an HTTP route, service mount or its Lambda shows an **API user-pool authorizer**
switch. Enabling writes `auth: true`; disabling removes `auth`, preserving the framework's
`auth?: true` contract. Both are staged with other inspector changes. Handler token verification
and its separate `userPool: true` declaration keep their existing behavior.

Selecting an HTTP Lambda also shows its editable route paths. Previewing a path change
updates the authored HTTP key and validates both graphs while checking that target ids
and deployed construct ids stay unchanged. Applying refreshes the Lambda label and its
API Gateway node together; the normal Undo/Redo controls restore the exact source bytes.
Duplicate paths, invalid paths and overlapping routes are refused. Run
`framework:generate` after applying a rename to update the generated browser API contract,
and update callers of the old path. Studio does not deploy the gateway.

Selecting an authored input or secret loads its current value from the selected mode's inputs file.
**Local value** edits that variable in place, showing the environment and file destination.
Missing, empty, configured, defaulted and unsaved states stay distinct. Declared choices use
a dropdown; **Use default** clears the local override and **Revert value** restores the saved
value. Secrets start masked; **Reveal** displays only the selected value. Review Changes
redacts values and checks the file revision before saving to `.env.dev` or `.env.prod`.
Input configuration and local values are reviewed separately. Values remain outside
snapshots, browser query caches, printed models, previews and the CDK index. Saving never
deploys or uploads secrets.

The resource inspector edits secret status, a regular input's default, group membership
(including a new group), and deployment requirements on consuming workloads. Existing
conditional requirements remain visible and unchanged unless edited. A workload override
materializes its requirement list, preserving its other rules. Inputs with no workload
consumers have no workload requirement to edit; application CDK may impose its own checks.
Secrets never have source defaults. Unsupported expressions or changes that invalidate
consumers are refused with diagnostics.

Resource edits show every changed file before applying, validate candidate source in fresh
dev/prod evaluators and TypeScript, and have their own **Undo resource edit** / **Redo
resource edit** controls in the inspector. Group moves keep the environment variable name
and rewrite imported catalog references, including application CDK references when needed.
They never edit generated files. No deployment or secret upload is performed.

Every editable inspector is one draft session:

1. **Edit freely.** Toggles, fields, route paths and resource controls stage changes in
   memory. No preview opens and no source is written. Reverting a value removes that
   pending change. Island service-group menus retain each group's changes.
2. **Review Changes.** The sticky footer shows the pending count, Discard and Review
   Changes. Review opens immediately while source splices are composed and the complete
   candidate configuration is validated in both graphs, then shows one diff per affected
   file. Planning errors remain in the dialog with Retry Review.
   Resource edits also retain their existing TypeScript validation.
3. **Back to Editing, Discard All or Apply All.** Returning keeps every draft value.
   Invalid values are reported inline. Apply writes the whole accepted draft, confirms
   its evaluated result and resets the baseline. A failure preserves the draft.
4. **Undo and redo.** A workload/default/route batch is one entry in the existing global
   history. Resource edits retain their existing resource history. Undo restores exact
   source bytes and refuses concurrent source changes.

Changing node, island, view or graph mode, closing the inspector, and browser back/forward
offer **Keep Editing**, **Discard and Continue** or **Review Changes** when dirty. Browser
refresh and tab closure use the native browser warning. Clean sessions have no warning.
External source changes preserve the draft and block review/apply; discard explicitly
to load the latest source. A stale review is also refused by server revision/hash checks.
Drafts live only in the current tab and are not saved across a reload.

The checks are config-level. They do not prove a CDK synth or a deployment: run those
separately, as Framework describes.

## Safety

- It binds to 127.0.0.1 only.
- It answers only to `127.0.0.1:<port>` or `localhost:<port>` as the Host.
- The API needs a per-process token that is served in the page.
- Changes must come from the studio's own origin.
- Workload edits write only `framework.config.ts` and `framework-config/**/*.ts`.
  Resource moves can also update references in authored TypeScript modules. The server
  derives those paths from the catalog imports; requests cannot choose arbitrary files.
- Input values are available only through the token-guarded selected-resource endpoint.
  It accepts a defined catalog resource id, never an arbitrary environment key or file.
  Disposable evaluation inputs and the CDK link index live under `.cache/framework-studio/`.
- It runs two commands, `framework:check` and `framework:generate`, with fixed arguments
  and no shell. The generator runs only after you confirm it.
- Explicit infrastructure synthesis uses the local CDK CLI through a separate runner,
  without a shell. Requests can select a mode and validated profile name, not arbitrary
  commands, context keys or input paths. Its temporary inputs and assembly are removed
  after inspection; only the values-free inventory is retained in memory.

## Layout

| Path | What it does |
| --- | --- |
| `server/model/` | Projection, origin parsing, preflight |
| `server/source/` | Source locations, editability, stack members, link sites |
| `server/edits/` | Field registry, text splices, planning, transactions |
| `server/evaluator/` | The per-graph child processes |
| `server/infrastructure.ts` | Explicit synthesis, framework mode/input adapter, freshness and last-good inventories |
| `../scripts/cloud-assembly.ts`, `../scripts/infrastructure-inventory.ts`, `../scripts/cdk-synthesis.ts` | Reusable assembly reader, inventory extraction and synthesis-only runner |
| `src/` | The views, shared inspector draft, navigation guards and combined review |
| `src/scene/` | The isometric view: projection, layout, icon shapes, slabs, search/focus, camera, picking, the canvas renderer |
| `shared/` | The types both halves share |

Tests (`npm --workspace framework-studio test`) run against the real configuration in
memory, and against a disposable copy under `.cache/framework-studio/` when they write.

VPC placement is explicit: Lambdas import `vpc`, services/tasks import `cloud.vpc`,
and native application resources call `frameworkVpc(this, importedVpc)`. Each VPC has
its own Isometric island, subnet bands, gateway/endpoint selection and settings Inspector.
Workload Inspectors review VPC and subnet changes together. Database callers must use
the database's selected VPC. Compose keeps its existing shared network; configuration
checks and local Lambda egress use the selected VPC. Creation and editing never deploy.
