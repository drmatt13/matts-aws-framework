# AWS Studio

AWS Studio is the visual editing and operations interface for Matt's AWS Framework.
It lives in the `framework-studio` workspace. For a shorter introduction to the six
workspaces and their action boundaries, read the
[interface guide](../docs/aws-studio-knowledge/studio/interface.md); for service ownership,
read [backend boundaries](../docs/aws-studio-knowledge/studio/backend.md).

A local view of `framework.config.ts` with reviewed resource creation and targeted
source editing. It shows:

- what each declaration is;
- where it runs: Development and Production, with execution location shown inside each;
- what it reads, grants and invokes;
- where it was written.

Declarations use the same [code-first layout and tags](../docs/framework-studio/declarations-and-tags.md)
when authored by hand or created in Studio. Tag edits use source review. Isometric always keeps topology; its tag filter fades
nonmatches without changing placement, identity or source.

The shared navigation stays stable across all six views. The shared top-right navbar
exposes the **Source** Development/Production selector on every route. Switching source
mode retains the unsaved-draft guard. When the configuration does not load, the canvas
banner's **Show why** opens Configuration health; AWS credentials, deployments and
runtime health are inspected separately. Domains edits Production domain intent;
named deployments keep their own target/profile/account context. See the
[UI design system](../docs/framework-studio/ui-design-system.md).

The **Database** tab (`/database`) is a source-first Prisma 8 workbench with five
workspaces: **Schema**, **History & migrations**, **Database status**, **Saved SQL**,
and **Data retention**. Edit the
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
loopback binding. Production inspection/application uses the deployed migration task
with IAM/TLS access to the private database. Inspecting production launches a billed
VPC task and requires its own target-bound approval; applying migrations is a separate
task and typed approval. Opening the page and local inspection never start Compose.
See the [Database workbench guide](../docs/framework-studio/database-workbench.md)
for exact effects, evidence, keyboard behavior and limitations.

**Data retention** and the Cognito User Pools/Deploy lifecycle panels review
independent Database/Cognito policies and explicit references to compatible retained
resources. Source authority, legacy compatibility, durable inventory, dependency
guards and CLI parity are documented in the [stateful lifecycle guide](../docs/framework-studio/stateful-resources.md).

The **Deploy** tab (`/deploy`) provides deployment discovery, reviewed operations and
local development controls. See the current [operational lifecycle](../docs/aws-studio-knowledge/deployment/lifecycle.md)
and the historical [Deploy & Run design](../docs/framework-studio/deploy-and-run.md).
Its deployment detail also offers reviewed **Development & production deployment
names** and **Client environment & frontend release** controls: public env generation
without Docker, configurable static frontend builds, exact S3 publication review and
separate CloudFront invalidation. See the [frontend release guide](../docs/framework-studio/frontend-release.md).

The **Cognito** tab (`/cognito`) is one authentication workspace with directly
linked User Pools, Identity Pools, Providers and Permissions & RBAC subsections.
One profile/deployment/region context follows Studio's environment selection;
subsection navigation preserves inspection and source proposals. Old
`/identity-pools` bookmarks remain compatible. Source intent, deployed metadata,
simulation and actual sign-in/access have separate evidence. See the
[authentication guide](../docs/framework-studio/identity-and-domains.md) and
[component ownership](../docs/aws-studio-knowledge/studio/authentication.md).

Local PostgreSQL appears in Isometric as the Compose `postgres`
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

Use **Add to application** in Isometric, choose a resource, and configure
its form. Advanced settings contain runtime sizing, placement and catalog bindings.
**Review generated changes** checks both deployment graphs and TypeScript, then
shows the complete patch grouped by file, including new files and generator output.
**Back to Editing** and **Back to resource types** retain the current form.
**Apply All** is the approval to write that exact patch. A successful write rebuilds
the source index and graph, selects the canonical resource and opens its Inspector.
Use Git to manage saved source changes, including scaffolding and generated artifacts.
Descriptions use `framework-config/descriptions.ts`, the same metadata source
the existing Inspector edits, for every resource family.

| Entry | Authored source | Supported creation choices |
| --- | --- | --- |
| Function | Existing `framework-config/workloads/events.ts`, `http.ts` or `websocket.ts` map; registration only if absent; `cdk-app/lambda_functions/<category>/<id>/index.ts` | Event, HTTP and WebSocket; Node 22/24 zip; memory, timeout, architecture, subnet; authenticated HTTP wrapper and pool binding; optional input/secret binding |
| Stack | `cdk-app/lib/app/<class-name>.ts`, typed catalog entry, import and instantiation in `cdk-app/bin/cdk-app.ts` | SQS queue, encrypted/private/retained S3 bucket or Cognito identity pool exposed as a typed public field, `linkResources`, deployment-prefixed stack/output identity; both/dev/prod scope |
| VPC | New `framework-config/networks/<id>/index.ts` and a literal registry reference | Independent VPCs with private /16, two/three zones, NAT, IPv6 egress and endpoints; unused VPCs appear as blueprints |
| Workflow | Existing workflows.ts map; registration only if absent | Executable pass-through workflow, or a sequence of existing event Lambdas/tasks; deployment lanes and execution timeout; native workflow DSL and IR |
| Container service | Existing services.ts section, `cdk-app/ecs_containers/services/<id>/{index.mjs,Dockerfile,package.json}` | Node HTTP server and health endpoint; mount, port, gateway auth, CPU/memory, architecture, subnet, input/secret binding; local-only default |
| Container task | Existing tasks.ts section, `cdk-app/ecs_containers/tasks/<id>/{index.mjs,Dockerfile}` | Run-to-completion Node container reading `FRAMEWORK_TASK_INPUT`; sizing, architecture, subnet, deployment lanes, input/secret binding; timeout belongs to its invocation |
| API route | Existing HTTP/WebSocket section; optional new handler | New Lambda or an existing routed Lambda of the same category. Reused functions retain their authentication, bindings, handler and construct identity. HTTP methods and literal route paths use normal conflict validation |
| Agent | Existing agents.ts section, configured agent directory with `{index,contract}.ts`, workspace manifest and tsconfig | Deterministic echo by default (no provider/model prerequisite), or an explicit model/tool loop using `@repo/models`; validated Zod contract; existing tools; authenticated browser route or IAM service agent; input/secret reference |
| Agent tool | Existing tools.ts section, configured Lambda directory with `{index,contract}.ts` | Validated Zod request/response, authenticated tool wrapper by default; delivered to agents through declared tools |
| Input parameter | Resource catalog; optional consumer section/import; commented template keys only when linked to an environment file | Standalone public value or environment-linked string/enum with default and required policy, description, group, existing consumer mapping |
| Secret | Resource catalog; commented keys in both input templates; optional consumer section/import | Declaration only, required flag, description, group, existing consumer mapping; automatic ARN/read permissions for Lambdas/agents and startup-value delivery for containers |
| Authentication provider | Literal `framework-config/auth-providers.ts`; OIDC secret declaration when required | OIDC/SAML source proposal with explicit graph scope and attribute mappings; provider-side setup and sign-in remain separate |

The framework's real generator runs in a disposable source copy before review.
Changes to framework IDs, browser contracts, agent contracts, service environment
examples and Compose are included when needed. Service and agent workspace metadata also
uses npm 11's offline lockfile generator; it never installs dependencies into the
application. Start Studio with npm 11. New workspaces require rebuilding local
development images with `dev:containers`; creation does not start containers.

Workload forms offer **Create starter files** or **Use existing code** at the configured
implementation directory. The preview lists new files as well as declarations. Existing
code is never overwritten; selecting existing code validates the framework's actual
entry point and packaging artifacts. New service/agent manifests must fit the root's
registered workspace patterns. Directory traversal, symlinks and unsafe paths are refused.
The Implementation section shows missing artifacts at the selected node and offers
**Create missing starter files** at that same configured path. A partial folder receives
only absent files; incompatible existing contracts fail TypeScript validation without
writes. Node ZIP functions, agent tools, echo agents and ECS services/tasks have bounded
starters. Unauthenticated Python ZIP repair supports the conventional entry point;
authenticated Python and image Lambda repair require the linked source editor.

Source creation never synthesizes, deploys, provisions secret values or writes
authored environment files. Environment parameters and secrets share declarations
across graphs; their file values remain independent in `cdk-app/.env.dev` and `.env.prod`.
Source parameters store their public values directly in the reviewed declaration.
Use the protected environment-file Inspector for values as a separate operation.
Network and container forms expose cost-relevant settings before approval.

Creation uses the existing `DraftEdit` union, `InspectorDraft`, `BatchEditor`,
`EditService`, source splices and evaluator processes. New modules are
resolved from an in-memory overlay during preflight. The API accepts typed resource
requests, not source text, shell commands or destination paths. Every destination
has a fixed allowlist and rejects traversal and symlink components. Reviews retain
source hashes, generator-input hashes and absence checks. New files are installed
exclusively through temporary files. Both modes must match the reviewed resource identities and semantics after
writing. Failed writes or verification restore unchanged files and remove generated
files; concurrent edits are preserved and reported as unconfirmed. A durable source
journal records batch/resource multi-file writes before applying. After interruption,
Source recovery offers reviewed restoration of matching bytes or explicit completion
with the revalidated current source. Later user edits are preserved. In-flight applies
are excluded from recovery. Drafts still live in memory;
the journal does not record environment values or execute cloud/database operations.

The initial creators deliberately support the repository's conventional literal
section layout and TypeScript zip handlers. Python/image Lambda scaffolding,
arbitrary existing Docker build contexts, custom CDK construct templates and stack
dependencies, agent streaming/history implementations, multi-binding editors and
arbitrary workflow graph construction remain source-authored. Event triggers and
failure destinations use the existing Inspector after creation. Adding a route to
an existing function preserves that function's settings rather than generating a
second implementation. Inputs remain string-valued. Computed declarations that cannot be safely spliced are refused before any
application file is written.

**Connect workload** stages database IAM/VPC access, user-pool identifiers, declared
task/workflow/agent invocation, agent tools, input/secret delivery and literal native
bucket/queue grants. Bucket grants accept an explicit object-key scope. Disconnect
removes the selected exact literal binding, preserving unrelated bindings. Computed
maps, spreads, commented lists, custom grants and ambiguous ownership link back to
source. Providing pool identifiers does not install handler authentication. Workload
removal first checks consumers, then reviews the declaration, generated artifacts and
an exact text source archive under `archived-workloads/`; shared folders, environment files,
linked or binary source folders require manual ownership review. This source action
does not remove deployed infrastructure or data. Use Git to restore saved source.

The design, history and roadmap are in [docs/framework-studio](../docs/framework-studio/README.md).

The isometric map arranges islands using weighted dependencies and projected crossing,
length, obstacle and viewport costs. Small edits retain nearby positions; major workspace
aspect changes reflow automatically. Pan, zoom, search, selection and the mode switch keep
the current arrangement. See [graph-aware layout and measurements](../docs/framework-studio/graph-layout.md).

Following a link inside an inspector keeps its return path. Opening `modelProvider`
from the `langgraph` input group offers **Back to langgraph**; stack fields, routes,
handlers, connection endpoints and island entries use the same navigation. The separate
**Resources** action returns to the original list row, retaining search, type and scroll.
Back and browser Back/Forward restore the visited inspector's scroll, open sections and
keyboard focus. Selecting another map or list resource starts a new path. A direct link
with no earlier inspector falls back to Resources. Unsaved edits keep the existing
**Keep Editing**, **Discard and Continue** and **Review Changes** guard.

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
- **CDK resource links.** The studio parses linked stack constructors for direct public-member references, SNS SQS subscriptions and EventBridge rules. References appear when inspecting their resources; recognized delivery belongs to Calls and events. Source locations and inference details remain in Configuration. No CDK code is executed by this scan.

Each logical graph is evaluated in its own child process, with a synthetic inputs file holding
only `PROD_DEPLOYMENT`. Graph evaluation receives only deployment-mode and WebSocket flags;
the server resolves each mode's WebSocket condition through its declared input source.
The Studio input protocol passes condition outcomes instead of environment-file values;
public source parameter values are part of the evaluated declaration. Evaluators still
inherit the host environment and execute trusted repository code with filesystem access;
they are not a secret-isolation or hostile-code sandbox.

## CDK environment files and input parameters

**Input parameters and secrets** contains only inputs and secrets declared in
`framework-config/resources.ts`. **Environment files** groups `cdk-app/.env.dev`,
`cdk-app/.env.prod`, and `client-app/.env`. CDK files are labeled **Framework managed**,
with their values still editable. File-to-parameter links come from actual assignments, including empty ones;
missing entries stay visible in the inspector without pretending to supply a value.
Catalog identities are reused, preserving their workload and secret-consumer links.

An input has an explicit source in its creation form and Inspector. With **Link to .env file**
off, a **Source parameter** stores a non-secret **Value** in its declaration through
`resource.value(...)`. It has no environment variable, fallback default, local-file editor
or file-to-parameter link. `enableWebSocketApi`, for example, is a source parameter whose
value is `true`. Environment files cannot override that value.

With the link on, an **Environment parameter** reads its named variable from each
environment's file and may declare an optional **Default value**. Switching the link carries
the entered text between Value and Default; source review shows the change before saving.
Creation or changing the link never overwrites existing `.env` contents. Secrets always use
the protected environment-file source and have neither public source values nor defaults.

**Input behavior** is a Dev | Prod grid. Both sources expose **Present**; source parameters
expose **Value**, while environment parameters expose **Required** and optional **Default**.
The normal review/apply flow writes `resource.value(...)`, `.only()`,
`.required()`/`.required(mode)` and `.default()`/`.default({ dev, prod })` as appropriate. An input
can be edited from the graph that does not hold it. Existing conditional and per-workload
requirements are also evaluated. Missing or whitespace-only effective values create a
red connection with an X, including when the variable has no assignment yet. Select the
connection to see the environment, why it is required, and actions to edit the environment
file or parameter default. Parameters can use non-blank declaration defaults; secrets
must be supplied in the local environment file and never get source-code defaults.
File inspectors flag each required row and summarize missing ones above the list. Requirements
are checked against each mode's own file (`cdk-app/.env.dev` or `cdk-app/.env.prod`);
template values are references only. Unknown reads are reported separately from missing
values. The graph carries public source values and declared defaults; values read from
environment files stay outside it.

Selecting a file opens an editor for all of that file's variables, including settings
such as `PGADMIN_HOST_PORT` that have no catalog declaration. Edit multiple values or
add variables, then **Review Changes** and **Apply All**, or discard the draft. Navigation
and browser exit use the same unsaved-change guards as other inspectors. Existing secrets
are withheld until revealed one at a time; new values are masked initially. The review
lists changed keys with values redacted. File revisions are checked before review and
again before applying, so another editor's save is preserved. Only the selected mode's
file is written; saving does not synthesize or deploy. Dotenv syntax and value round trips
are checked; infrastructure validation remains a separate synthesis action.

Both file inspectors list the same variables: the file's own lines, the other file's lines,
and every environment-linked catalog input its graph holds, catalog inputs first. A blank catalog row shows its
declared default; a row the other file alone writes says so. An input declared `.only()` the
other graph is left out, and flagged **Not read** if a line for it is written anyway. Showing a
row never writes one: typing a value adds the line, and clearing it again drops the edit.
Variables the catalog does not declare but the application reads are grouped with their owner:
**Deployment settings** (cdk-app/deployment-inputs.ts) and **Database** overrides, each with its
default, choices and note; a database override in the development file is flagged **Not read**.
Anything else is listed under **Other variables**.
File-to-resource links use catalog declarations only. Names, line presence and declared
defaults remain available without values in the map. Values load only into the selected
inspector and its in-memory draft, outside graph/search data and query caches. A sensitive
line's value is withheld from the file inspector: it shows as set, typing replaces it, and
**Reveal** fetches that one value. Clearing a secret that was never revealed keeps it.
`PROD_DEPLOYMENT` follows the file's mode.

There is no `cdk-app/.env`: the mode (`-c prodDeployment`) picks `.env.dev` or `.env.prod`.
A file that has not been generated wears a red cross on its node in the isometric view.
Expand **Island entries** at the bottom of the **Environment files** island inspector
to select a file. Missing files show **Not generated**; open one and use
**Generate .env.<mode> from template**. Generation
copies `cdk-app/.env.dev.template` or `cdk-app/.env.prod.template` without overwriting an
existing file; production is never seeded from development. Both files are ignored by Git.

Studio synthesis reads `cdk-app/.env.dev` or `cdk-app/.env.prod` for its selected mode. File
changes refresh the map and stale the matching inventory; generating a file does not deploy.

## Client-app environment mappings

The **Environment files** island groups the CDK input files and **Client environment**.
CDK files carry **Framework managed** labels; `client-app/.env` carries **Application**.
These labels describe purpose; CDK values remain editable. The client export writes
`client-app/.env.development.local` and `client-app/.env.production.local`, shown as
generated outputs in the client inspector. **Island entries**, the final section in
every island inspector, links to each file. Select `client-app/.env` for its export
paths and searchable mapping overview. Mappings belong to the file, not the island. File details
stay collapsed. The displayed mappings are source recipes, not a
read of values saved in `client-app/.env`. Expand a field to choose its source type, then its
CDK input, stack/output or region; URL sources expose protocol, hostname, port and an optional
override. A field is one recipe for both environments; **Different source in each environment**
splits it into `{ dev, prod }` when the sources differ. Each field shows a symbolic preview
that updates with its draft, plus an individual reset.
Each field's Dev/Prod pills report where it gets a value, inferred rather than toggled: an
input not declared in an environment, or one with no value and no default there, leaves the
field blank; a required input with neither needs attention. **Empty value** writes a blank
value on purpose. Rename a field inline while retaining its recipe, add new `VITE_` fields,
or remove a field from both environments.
Renames reject duplicate names and require updating application reads of the old name.
Stack outputs can permit an empty value when
their stack is off. Choosing a new stack requires explicitly choosing its output; existing
fallback output lists are retained until that selection changes.

Edits stage in the existing **Review Changes → Apply All** flow, with discard, navigation
guards, source conflict detection, and guarded source writes. References are saved as literal
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
| `VITE_LOCAL_WS_URL` | `ws://localhost:${LOCAL_WS_DEV_SERVER_HOST_PORT}` when `enableWebSocketApi` matches `"true"`, otherwise empty | Same recipe; blank, because its port is development-only |
| `VITE_API_GATEWAY_WS_URL` | WebSocket stack `WebSocketAPIEndpoint` when enabled, otherwise empty | Same rule |
| `VITE_WS_TESTER_URL` | `http://localhost:${WS_TESTER_HOST_PORT}` | Same recipe; blank, because its port is development-only |
| `VITE_AWS_REGION` | Cognito stack's deployment region | Cognito stack's deployment region |
| `VITE_USER_POOL_ID` | Cognito `UserPoolId` output | Same output in the selected deployment |
| `VITE_USER_POOL_CLIENT_ID` | Cognito `UserPoolClientId` output | Same output in the selected deployment |
| `VITE_COGNITO_DOMAIN` | Cognito `UserPoolDomainUrl` output | Same output in the selected deployment |

Client mappings read declared input parameters on the Input parameters and secrets island.
Environment parameters read CDK `.env.dev` and `.env.prod`; source parameters read their
declarations. The CDK files have no direct mapping connection to `client-app/.env`.
Parameters carry their selected-mode presence, source values or defaults,
and exports evaluate the catalog for the selected deployment. Local URL inputs under
`resources.client` are declared `.only("dev")`. A mapping's optional `when: { input, equals }`
uses a public input parameter to control whether its value is populated or empty.
Region comes from Cognito's deployment rather than
`LOCAL_AWS_REGION`, which can name a different region for local SDK calls. An absent
WebSocket stack permits an empty URL; an enabled stack missing its output is reported as
unavailable. New recipes identify inputs by catalog ID so changing their source preserves
the mapping; existing environment-variable aliases remain readable. Snapshots and search
never contain resolved environment-file or stack-output values.

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

`/` draws the model as a landscape of floating islands, on a 2D canvas; `/isometric`
redirects there. The earlier Board view (`src/views/Board.tsx`) is set aside and not routed.

Relationships between the same visible source and destination share one connection.
Connection hover popups, inspectors and relationship rows show Dev and Prod pills, with
unavailable environments dimmed based on the relationships and both endpoints.
Grouped inspectors show shared endpoints once and list each relationship in a compact expandable row.
Click a grouped line to inspect a connection map with every field mapping,
relationship, environment and expandable source evidence or required-input guidance.
Grouped titles name their purpose, such as **Reads 3 environment values**; hover previews
show at most four members and a remaining count. Missing required values remain visible.
Single connections use concise purpose titles and relevant details: database bindings explain
the framework's connection settings, networking and IAM login; native triggers name their
CDK constructor; replay reads **Local replay: AWS invocations**. A compact IAM note supplements
the hover. Full source diagnostics and authorization facts expand under **Configuration**
and **Permissions** in the inspector.

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
TypeScript handler's `withLocalReplay` wrapper. Apply keeps the files
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
  draft and review flow. Islands without shared framework defaults link to their entries.

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
WebSocket options also account for each environment's resolved deployment condition, so the labels do not
claim a production deployment where no API exists, or hide its AWS-backed Development execution.

| Input | Action |
| --- | --- |
| Drag | Pan (a press that moves less than 6 px is a click) |
| Wheel or pinch | Zoom about the pointer |
| Double-click | Fly to a building |
| Arrow keys, `+` / `-`, `0`, `F`, Escape | Pan, zoom, fit, focus the selection, clear it |

Four purpose filters control background connections: **Routes**, **Environment and secrets**,
**Resource access**, and **Calls and events**. Empty categories are hidden. Ownership and native
reference links appear only when selecting or previewing their resources or inspecting the connection.
Routes and Environment and secrets start off; the others start on. A grouped connection
matches any member's category across both environments. Selecting or previewing a resource
reveals all its connections, and clearing selection restores the filters. Hovering an edge,
a building, a gateway or the ground explains it. A building's hover card shows its authored description (including an unsaved
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

## WebSockets

`/websockets` is ws-tester ported into Studio, on the way to retiring the separate
`ws-tester` workspace and its Compose service. Two panels connect from the browser:
local-ws-dev-server on the left, the deployed API Gateway WebSocket stage on the right.
The connection lifecycle, the `customAction` example payload, the JSON check before
sending and the message log are ws-tester's own (`src/views/websockets/WebSocketTester.tsx`).

The page accepts ws-tester's launch link unchanged (`src/websockets/launch.ts`):
`?localWsUrl=` and `?apiGatewayWsUrl=` name the panels' URLs, and a `#token=` fragment
fills each URL's `token` query. The fragment is cleared from the address bar as the page
loads. Opened without a link, the panels start from the URLs Compose gives ws-tester,
which `GET /api/websockets/defaults` reads from two keys of the exported root `.env`:
`LOCAL_WS_DEV_SERVER_HOST_PORT` and `VITE_API_GATEWAY_WS_URL`.

local-ws-dev-server refuses an upgrade from an origin outside `LOCAL_BROWSER_ORIGINS`,
which the export derives from `LOCAL_DEV_URL` and ws-tester's port. Until Studio's origin
is trusted there, the local panel reports **Failed to connect to WebSocket**. The deployed
stage does not check the origin.

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
share source-conflict checks. Preview checks both graphs and
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
edits use the existing unsaved-change guards, conflict detection and guarded source writes.
HTTP route renames move their descriptions to the new route ID in the same change.
New declarations can add their description from the inspector; existing entries are
authored documentation, never generated or overwritten on refresh. Input-setting and
environment-variable changes are reviewed separately from their description edits.
Saving descriptions does not change deployment behavior or deploy infrastructure.

Connections offer **Add description**, including each relationship inside a grouped
connection. These optional notes use the same review and apply flow and are shared
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
share the draft, validation and write flow; changing packaging does
not create a Dockerfile or rewrite handler source.

Selecting an HTTP route, service mount or its Lambda shows an **API user-pool authorizer**
switch. Enabling writes `auth: true`; disabling removes `auth`, preserving the framework's
`auth?: true` contract. Both are staged with other inspector changes. Handler token verification
and its separate `userPool: true` declaration keep their existing behavior.

Selecting an HTTP Lambda also shows its editable route paths. Previewing a path change
updates the authored HTTP key and validates both graphs while checking that target ids
and deployed construct ids stay unchanged. Applying refreshes the Lambda label and its
API Gateway node together; use Git to manage the saved source.
Duplicate paths, invalid paths and overlapping routes are refused. Run
the application checks and update callers of the old path. Generated browser API
contracts join the rename's review and apply. Studio does not deploy the gateway.

Selecting an environment parameter or secret loads its current value from the selected mode's inputs file.
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
dev/prod evaluators and TypeScript. Group moves keep the environment variable name
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
4. **Saved source history.** Use Git to inspect or restore saved changes. Studio has no
   source-edit undo/redo controls, APIs or history stacks. Failed writes still use
   guarded rollback, and interrupted writes retain reviewed Source recovery.

Changing node, island, view or graph mode, closing the inspector, and browser back/forward
offer **Keep Editing**, **Discard and Continue** or **Review Changes** when dirty. Browser
refresh and tab closure use the native browser warning. Clean sessions have no warning.
External source changes preserve the draft and block apply. **Review against latest
source** explicitly replans ordinary drafts without losing typed values; protected
input/catalog forms require their own reload. A stale review is refused by server
revision/hash checks, including existing implementation bytes used during validation.
Drafts live only in the current tab and are not saved across a reload.

The checks are config-level. They do not prove a CDK synth or a deployment: run those
separately, as Framework describes.

## Safety

- It binds to 127.0.0.1 only.
- It answers only to `127.0.0.1:<port>` or `localhost:<port>` as the Host.
- The API needs a per-process token that is served in the page.
- Changes must come from the studio's own origin.
- Workload settings write only `framework.config.ts` and `framework-config/**/*.ts`.
  Typed creation, starter repair and removal also use bounded implementation/archive
  paths and generator-owned outputs in their reviewed transaction.
  Resource moves can also update references in authored TypeScript modules. The server
  derives those paths from the catalog imports; requests cannot choose arbitrary files.
- Input values are available through token-guarded selected-resource and fixed CDK-file
  detail endpoints. Resource reads require a defined catalog ID; file reads/edits are
  restricted to `.env.dev` and `.env.prod`, with sensitive values revealed individually.
  Neither is an arbitrary filesystem path API.
  Disposable evaluation inputs and the CDK link index live under `.cache/framework-studio/`.
- Check/generation commands have fixed arguments and no shell. Preview generation runs
  in a disposable copy; only the reviewed Apply action installs its generated files.
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
They import `assert` from `test/support/assert.ts`, never `node:assert` directly:
node:assert diffs a failing comparison's operands without bound, and one failing
`assert.equal(element, null)` committed ~100 GB and took the whole machine down. Small
operands keep node:assert's messages; large ones report their first difference.

The Node suites register `test/support/register-css.mjs` to ignore browser-owned CSS
imports; they verify component behavior, not stylesheet rendering. For a focused run
from the repository root, use `npm --workspace framework-studio exec -- node
--conditions=development --import ./test/support/register-css.mjs --import tsx
--test test/isometric-ui.test.ts`. Browser checks separately exercise the generated CSS.

VPC placement is explicit: Lambdas import `vpc`, services/tasks import `cloud.vpc`,
and native application resources call `frameworkVpc(this, importedVpc)`. Each VPC has
its own Isometric island, subnet bands, gateway/endpoint selection and settings Inspector.
Workload Inspectors review VPC and subnet changes together. Database callers must use
the database's selected VPC. Compose keeps its existing shared network; configuration
checks and local Lambda egress use the selected VPC. Creation and editing never deploy.

Deploy accepts an input condition through **Only when an input matches…**. Choose a
non-secret input from Input parameters and secrets and its matching value; review shows
separate development and production outcomes. Private environment-file values remain in
the server's input reader; standalone public source values are ordinary declaration
metadata. Event Lambdas accept deployment policy subject to their native trigger
constraints; tools inherit their consuming agents' lanes unless explicitly overridden.

The APIs island shows actual HTTP and WebSocket gateways. Routes are listed in their
gateway inspector, and agent browser routes belong to their agent. Both gateways are
framework managed; workload Deploy settings control their routes and handlers.


### Frontend styling and browser checks

Studio's React UI uses Tailwind CSS 4 through `@tailwindcss/vite`, with CSS-first
configuration and no Preflight. Read the [UI design system](../docs/framework-studio/ui-design-system.md)
before changing appearance. `src/styles.css` is the entry, `styles/theme.css` owns
runtime tokens, `styles/base.css` owns document/browser safeguards, and
`styles/codemirror.css` adapts editor-owned DOM. Layout lives in JSX; repeated controls
and surfaces use `src/ui/` and the existing inspector/workbench/document primitives.
Canvas palettes/geometry stay in TypeScript, and runtime positions stay inline.

`npm --workspace framework-studio run test:browser` builds two isolated previews and
runs the permanent Playwright suite, including the otherwise unrouted Board gallery.
The test gallery is excluded from production routes and source scanning. All APIs and
external transports are fixture-backed, including simulated event streams and mocked
WebSocket sessions. Pinned licensed fonts and platform-specific reference PNGs make
visual comparisons reproducible. Review diffs before explicitly updating screenshots;
see the design-system guide for commands and ownership. Real middleware/HMR smoke tests
are separate from these fixture-driven checks and from offline Node verification.
