# Framework Studio

A local view of `framework.config.ts` that you can also edit, for a few fields. It shows:

- what each declaration is;
- where it runs: Development and Production, with execution location shown inside each;
- what it reads, grants and invokes;
- where it was written.

The **Database** tab (`/database`) visualizes the declared application schema from
`packages/database/prisma/contract.prisma`. Select a table or foreign-key relationship
to inspect mapped column names, types, nullability, defaults, primary/unique keys,
indexes and referential actions, with links to source. Search finds tables and columns;
zoom and fit help with larger diagrams. It reads the authored contract using Prisma's
syntax parser, without running generation or querying a database. Contract edits refresh
the view automatically. This is a read-only declaration view, not live migration status.

Local PostgreSQL appears in Board, Lanes and Isometric as the Compose `postgres`
service. Its own **Local development** island is active in Development and faded in
Production; RDS keeps its production grouping. Database edges from local execution
reach PostgreSQL, while AWS bindings retain their catalog destination. Both databases
offer **View schema** in the inspector. Image, named volumes and source come from
the authored `docker-compose.yml`; connection credentials, container health and Compose
runtime overrides are not inspected.

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

The design, history and roadmap are in [docs/framework-studio](../docs/framework-studio/README.md).

## What it shows, and where that comes from

Framework behavior comes from the framework's own answers. CDK links are separately marked source inferences:

- **Targets, routes and relationships.** These come from `getFrameworkTargets` and
  normalization. Env references, grants, `database: true`, invocations, workflow steps and
  integrations, and agent tools are all shown.
- **Lanes.** These come from `isTargetEnabled` and `isTargetDeployed`, for both graphs,
  including the special rules: a tool follows its agents, an event has no toggle, and a
  development deployment builds only what AWS invokes.
- **Production placement.** This comes from `resolveLambdaTarget` and the network helpers.
- **Source locations.** These come from `locateConfigSource` in
  `packages/framework/scripts/config-source.ts`, the same reader `framework:check` uses.
- **Stack members.** These are read from each `resource.stack<T>()` class.
- **Link sites.** These are `linkResources` calls found in `cdk-app/lib`.
- **CDK resource links.** The studio parses linked stack constructors for direct public-member references, SNS SQS subscriptions and EventBridge rules. These edges have their own filter, source locations and inference label. No CDK code is executed by this scan.

Each graph is evaluated in its own child process, with a synthetic inputs file holding
only `PROD_DEPLOYMENT`. The studio reads exactly two keys from `cdk-app/.env`:
`PROD_DEPLOYMENT` and `DEPLOY_PROD_WEBSOCKET_API`.

## The isometric view

`/isometric` draws the same model as a landscape of floating islands, on a 2D canvas.

The backdrop is a thin isometric grid anchored to the terrain's world coordinates.
Entities use locally bundled official AWS SVG service icons on small plinths, with Lucide
SVGs for generic framework concepts. Board, Lanes and Inspector share the icon mapping.
See [icon sources](public/icons/README.md).

The view follows the model:

- Every building is an entity the model names, under the model's own id.
- Selecting a building selects that entity everywhere, and opens the same inspector, with
  the same edits.
- Positions, islands and colours are layout, computed from the model on every refresh.
  Nothing about them is written to disk or read back as configuration.

The regions mean something:

| Region | What stands there |
| --- | --- |
| Entry islands | One shared APIs layer for HTTP, WebSocket and agent routes |
| Compute | One shared layer for HTTP, WebSocket and event Lambdas outside the VPC; AgentCore agents and their tools; Step Functions workflows |
| The VPC | A terraced mesa, stepping down from the public subnet to the private and isolated ones. Each workload stands on the terrace its production placement names |
| Local development | Compose PostgreSQL, outside the AWS VPC; the same declared application schema as RDS |
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
across the two mode models. Lanes uses exactly two tracks, and the Inspector uses two
environment cards. Local and AWS are execution locations within Development, never a
third environment. The framework's underlying deployment settings are unchanged.
The Inspector's deploy selector labels those settings Dev + Prod, Dev only, Prod only
and Off; edit intents retain the framework's source tokens.
WebSocket options also account for whether its AWS API is enabled, so the labels do not
claim a production deployment where no API exists, or hide its AWS-backed Development execution.

| Input | Action |
| --- | --- |
| Drag | Pan (a press that moves less than 6 px is a click) |
| Wheel or pinch | Zoom about the pointer |
| Double-click | Fly to a building |
| Arrow keys, `+` / `-`, `0`, `F`, Escape | Pan, zoom, fit, focus the selection, clear it |

Edges are the model's typed relationships, in the Board's six categories, and can be
filtered. Hovering an edge, a building, a gateway or the ground explains it. Packets move
only along the selection's edges, and the Pause button or reduced-motion stops them. A
still picture draws no frames.

**Refresh CDK links** re-reads the source and updates the ignored internal index at
`.cache/framework-studio/cdk-links.json`. Startup and watched CDK changes also rebuild it.
For example, `referenceExamples` shows bucket → topic (EventBridge), topic → queue (SNS),
and queue → dead-letter queue. The index contains only source hashes, entity ids and
relationship evidence. It is disposable; framework configuration and CDK never read it.
The scan handles direct constructor statements and simple `const` aliases. Helpers,
branches, loops, dynamic member names and runtime behavior remain unresolved.

`window.__studioLandscape` exposes read-only camera, picking and frame statistics, for
tests and the browser console.

## What it edits

It edits `deploy`, a Lambda's `subnet`, `memorySize`, `timeoutSeconds`, `architecture`,
`packaging`, `logRetentionDays`, its managed `runtime`, and Node ZIP bundling's `minify`
and `sourceMap`, plus a container's `cloud.subnet`. Controls appear only where applicable:
container Lambdas get their runtime and handler from their Dockerfile, and Python ZIPs
have no esbuild controls. The inspector also shows implementation type, source directory
and resolved handler. All values use the framework's own resolution and default cascade.

Edits require a source literal, or an absent field whose parent is an object literal.
Anything an expression computes is shown read-only. Architecture and runtime changes
use the existing preview, validation, write, undo and redo flow; changing packaging does
not create a Dockerfile or rewrite handler source.

Selecting an HTTP route, service mount or its Lambda shows an **API user-pool authorizer**
switch. Enabling writes `auth: true`; disabling removes `auth`, preserving the framework's
`auth?: true` contract. Both use preview, validation and Undo/Redo. Handler token verification
and its separate `userPool: true` declaration keep their existing behavior.

Selecting an HTTP Lambda also shows its editable route paths. Previewing a path change
updates the authored HTTP key and validates both graphs while checking that target ids
and deployed construct ids stay unchanged. Applying refreshes the Lambda label and its
API Gateway node together; the normal Undo/Redo controls restore the exact source bytes.
Duplicate paths, invalid paths and overlapping routes are refused. Run
`framework:generate` after applying a rename to update the generated browser API contract,
and update callers of the old path. Studio does not deploy the gateway.

Selecting an authored input or secret loads its current value from `cdk-app/.env`.
Secrets start masked; **Reveal value** displays the selected value. Missing entries and
empty entries are distinguished. Values are loaded separately from the snapshot, without
browser caching; snapshots, printed models, previews and the CDK index remain value-free.
Studio does not change `.env`.

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

Every change goes through these steps:

1. **Plan.** It becomes a one-span text edit, never a re-print of the file. Before it is
   offered, the new text must parse, and the locator must read the same entry back with
   the new value.
2. **Preview.** The framework's own validation runs for both graphs on the changed config.
   You see its verdict, in its own words, beside the exact diff.
3. **Write.** The write is refused if the file changed since the preview. Otherwise the
   file is replaced atomically, re-evaluated from disk, and must resolve as predicted; if
   it does not, the write is undone.
4. **Undo and redo.** These restore exact bytes, and refuse if the file has changed since.

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

## Layout

| Path | What it does |
| --- | --- |
| `server/model/` | Projection, origin parsing, preflight |
| `server/source/` | Source locations, editability, stack members, link sites |
| `server/edits/` | Field registry, text splices, planning, transactions |
| `server/evaluator/` | The per-graph child processes |
| `src/` | The page, with the board, the lanes, the inspector and the preview |
| `src/scene/` | The isometric view: projection, layout, building shapes, the generated block atlas, camera, picking, the canvas renderer |
| `shared/` | The types both halves share |

Tests (`npm --workspace framework-studio test`) run against the real configuration in
memory, and against a disposable copy under `.cache/framework-studio/` when they write.
