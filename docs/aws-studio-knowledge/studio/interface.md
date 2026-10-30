---
id: studio.interface
summary: Current Studio workspaces, their state ownership, user journeys and action boundaries.
read_when:
  - Learning the Studio interface or tracing a visible action into source
  - Adding a workspace without duplicating configuration or approval state
source:
  - framework-studio/src/main.tsx
  - framework-studio/src/studio.tsx
  - framework-studio/src/views/Shell.tsx
  - framework-studio/src/views/CreationWizard.tsx
  - framework-studio/shared/creation.ts
related:
  - studio.backend
  - studio.editing
  - studio.rendering
  - studio.authentication
---
# Studio interface and action model

This is a source-verified map of the current application. Runtime verification is separate:
being able to render a control does not establish that its AWS or database operation has
completed. Start Studio with `npm run studio`, then open `http://127.0.0.1:4590/`.
`--port <number>` or `STUDIO_PORT` selects another local port.

## Navigation and state

[main.tsx](../../../framework-studio/src/main.tsx) owns the routes. The navbar has seven
workspaces and a shared **Source** Development/Production selector. Source mode selects a
declaration graph; it does not select credentials or a live AWS deployment. Named deployment,
profile, account and region belong to the operational workspace. Domains edits Production
intent even while the global source selector displays Development.

| Workspace | Route | What the interface controls |
| --- | --- | --- |
| Map | `/` | Isometric declaration graph, search, tag emphasis, connection visibility, camera, resource navigation, creation and Inspector |
| Database | `/database` | Authored Prisma contract, diagram, validation, migration history and artifact review; separate explicit database target and application controls |
| Deploy | `/deploy` | Named target discovery, reviewed infrastructure plans and authorized operations, frontend releases, retained resources and local development lifecycle |
| GraphQL | `/graphql` | Placeholder for the GraphQL workspace |
| Authentication | `/cognito` | User pools, identity pools, providers and permissions, each with separate source and deployed evidence |
| DNS / Domains | `/domains` | Production domain input settings, selected-deployment observations and separately approved domain operations |
| WebSockets | `/websockets` | Local and API Gateway connection panels derived from the existing tester; connecting or sending is an explicit runtime action |

Authentication deep links are `/cognito/user-pools`, `/cognito/identity-pools`,
`/cognito/providers` and `/cognito/permissions`. `/identity` and `/identity-pools` redirect
to the identity-pool workspace; `/isometric` redirects to `/`. `Board.tsx` remains as an
unrouted implementation and browser-gallery fixture.

`?select=<canonical-id>` identifies the shared Inspector selection. `StudioProvider`
owns source mode, selection/navigation, the snapshot-derived lookup and one Inspector
draft. The draft retains its baseline if newer source arrives; it becomes conflicted
instead of silently accepting a new baseline. Source-mode changes, selecting another
resource and route navigation use the unsaved-change guard. Database text editing has its
own exact-text session and navigation protection.

## Reading the map

The scene combines both modes to stabilize placement while showing the selected mode's
availability. Islands group entry points, compute, networks, orchestration, resources,
inputs and environment projections. Real VPC declarations own their subnet placement;
moving the camera never moves resources between networks. Production terrain can depict
an unused declared VPC without asserting that it has been provisioned.

Use **Resources** for a keyboard-accessible list of canonical entities and connections.
Selection opens the same Inspector used by canvas hits. Contextual Back retraces accepted
Inspector visits; Resources restores the list context. Search and tags change emphasis,
not source, graph identity or deployment intent. In the focused entity navigator, arrows
and Home/End browse, Enter inspects and Escape returns to the canvas. See
[rendering](rendering.md) for picking, narrow-screen placement and focus restoration.

Connections retain individual members even when visually bundled. Declared references,
derived framework relationships and inferred native CDK wiring have distinct provenance.
A native wire is source evidence; synthesized inventory and observed deployment state are
different evidence. An omitted inferred wire is not proof that no connection exists.

## Changing the application

1. Select an entity and inspect its source location, availability, settings and connections.
   Read-only computed settings link to their source; Studio does not rewrite arbitrary code.
2. Stage supported settings in the shared Inspector draft. **Add to Application** opens
   a typed creation form. The current creation registry supports functions, API routes,
   stack starters, VPCs, workflows, services, tasks, agents, tools, inputs, secrets and
   OIDC/SAML authentication providers. A stack starter offers queue, bucket and identity-pool
   templates; this is not an unrestricted visual editor for every CDK construct.
3. Review the combined source diff and Development/Production validation. Some operations
   include generated contracts, starter implementations or narrowly authorized native CDK
   changes. Creation reviews one complete operation at a time.
4. Apply the reviewed source. File hashes, source revision and capability evidence must
   still match. The server reevaluates from disk and verifies expected semantics.
5. Run the relevant local/build checks and use Deploy separately if infrastructure must
   change. Saving source never authorizes a cloud mutation.

Saved source history belongs to Git. There is no global source Undo/Redo API. An interrupted
multi-file write can expose **Source recovery**, which offers guarded restoration or
keeping validated current source. Editor-local text undo and reverting an unsaved field
are separate behaviors. See [editing](editing.md) for transaction guarantees and limits.

## Inputs and configuration

The Inspector distinguishes a public **Source parameter** (`resource.value`) from an
**Environment parameter** (`resource.fromEnv`). **Link to .env file** switches the source
through ordinary reviewed source editing. Public source values/defaults may be displayed
in the graph. Environment-file contents are loaded through a separate guarded, no-store
service and excluded from snapshots and source diffs. Authored `resource.secret("NAME")`
inputs remain linked to their selected CDK input file and start masked. Native stack-owned
`ISecret` fields are separate catalog references; this editor does not turn them into
authored dotenv values or reveal their AWS contents.

The CDK-file editor writes only `cdk-app/.env.dev` or `.env.prod`, preserving untouched
assignments and comments. Client environment mapping edits symbolic recipes in
`framework-config/client-environment.ts`; export later resolves these into ignored Vite
environment files. One **Environment files** island groups CDK files labeled
**Framework managed** and client mappings labeled **Application**. The labels describe
purpose; framework input values remain editable. Every island ends with one
**Island entries** disclosure; there is no separate Files list. Select
`client-app/.env` from its island entries for both export destinations and
the file's mappings; file details remain collapsed. These are symbolic sources, not the
contents of the base `.env` file. Editing a recipe does not export values or deploy resources.
The combined island retains `island:environment`; old `island:client-environment`
inspector links resolve to it. Individual file IDs and connections stay unchanged.

## Health and verification boundaries

**Configuration health** reports source loading, framework validation and source-index
problems. Its Additional checks action runs the fixed `framework:check` command. This is
distinct from a synthesized resource inventory, AWS credentials, deployed infrastructure,
Docker health and application health. The Stacks island and scoped stack inspectors own
explicit synthesis; changing the view or source mode does not synthesize.

Initial loading, failed initial connection, cached-snapshot refresh errors and stale
source models have separate UI states. A background fetch failure preserves the mounted
editor and its draft. Synthesis errors preserve labeled last-good inventory. Operational
pages report unverified/stale evidence until the relevant explicit inspection succeeds.

For extension work, start with the matching shared contract and server authority in
[backend boundaries](backend.md), then the existing view and design system. Adding a
button alone cannot extend the source write allowlist or authorize a deployment.
