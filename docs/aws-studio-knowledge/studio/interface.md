---
id: studio.interface
summary: Current Studio workspaces, their state ownership, user journeys and action boundaries.
read_when:
  - Learning the Studio interface or tracing a visible action into source
  - Adding a workspace without duplicating configuration or approval state
source:
  - framework-studio/src/main.tsx
  - framework-studio/src/studio.tsx
  - framework-studio/src/aws-profile-selection.ts
  - framework-studio/src/views/AwsProfileMenu.tsx
  - framework-studio/src/views/AwsProfileConfiguration.tsx
  - framework-studio/src/snapshot.ts
  - framework-studio/src/connection-generations.ts
  - framework-studio/src/deploy/observations.tsx
  - framework-studio/src/deploy/context.ts
  - framework-studio/src/deploy/queries.ts
  - framework-studio/src/views/DomainsWorkspace.tsx
  - framework-studio/src/views/Shell.tsx
  - framework-studio/src/views/GlobalActivity.tsx
  - framework-studio/src/agent-chat.ts
  - framework-studio/src/views/agent/AgentPanel.tsx
  - framework-studio/src/sightline/AgentViews.tsx
  - framework-studio/src/views/agent/AgentViewTabs.tsx
  - framework-studio/src/sightline/useSightlineInputs.ts
  - framework-studio/src/sightline/bridge.ts
  - framework-studio/src/views/deploy/DockerStatus.tsx
  - framework-studio/src/machine/docker.ts
  - framework-studio/shared/machine.ts
  - framework-studio/src/activity.ts
  - framework-studio/src/operations/live.ts
  - framework-studio/src/operations/api.ts
  - framework-studio/shared/operations.ts
  - framework-studio/src/views/AgentLab.tsx
  - framework-studio/server/agent-lab.ts
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

[main.tsx](../../../framework-studio/src/main.tsx) owns the routes. The navbar has the app's
name, eight navigation destinations (seven core workspaces and the auxiliary **Agent test**
experiment) and a shared **Source** Development/Production selector. The name is
`framework:app` from `cdk-app/cdk.json`; its pencil opens a popover that previews each stage's
`<app>-<stage>` deployment and reviews a rename (AppName.tsx), looking in AWS read-only with
each mode's profile, by app id and stage, so a deployed production stage keeps the name it is
deployed as. An app without `framework:appId` shows the name in the refuse color, and its
unchanged name can be reviewed to add one. Between 761 and 1200px only the pencil shows. Source mode selects a
declaration graph. Its trailing chevron opens an AWS profile popover for the accepted mode.
Opening it leaves focus on the chevron; Tab moves through its controls without automatically
highlighting the profile selector, including when discovery finishes.
`StudioProvider` exposes `awsProfile`, `awsProfiles` and `setAwsProfile(mode, name)` globally.
Only profile names are cached in browser local storage, keyed by repository root and mode;
both modes may use the same profile. Missing profiles remain visible as unavailable until
reselected or cleared. Storage failures retain session choices, and storage events synchronize
tabs. The popover lists local profile metadata through `/api/aws-connections` and checks
STS caller identity through its protected POST `/check`. These endpoints do not themselves
perform deployment discovery; associating a profile separately activates the persistent
deployment observer, including when the menu is opened outside Deploy.
Account/caller observations are query-cached, never persisted in local storage. Escape and
outside click dismiss the popover; keyboard focus returns to its trigger. While open,
the Development/Production buttons keep the popover open and update its mode/profile.
Switching modes while it is closed does not open it.
Profile selection automatically refreshes account details. The cog beside **AWS profile**
opens a foreground **AWS profile configuration** modal with profile discovery, cached
health, explicit connection tests, native sign-in, reviewed non-secret edits, and guided
Console/Identity Center/role creation. Its fixed viewport-bounded height, scrolling panes,
icon-only refresh and reserved feedback space keep profile/association changes stable.
The modal is a profile list beside an inspector panel that follows the inspector grammar: an
eyebrow whose Dev | Prod pills report which declaration modes use the profile, the config
section as the ref line, credential-source lines, then Declaration modes, Identity and
Configuration sections. Declaration modes mirrors the Deployment section: a Development and a
Production card, then a **Use for** select (Dev + Prod, Dev only, Prod only, Not used). A review, deletion, sign-out or sign-in replaces that panel until it finishes or is
canceled; the panel stays mounted so Back restores edited fields.
Each configured profile row offers confirmed deletion with dependency/file checks; successful deletion
clears matching mode associations without selecting a replacement. Cancel/Escape restores
focus to that row's delete button. An absent or deleted `default` remains visible as an
unconfigured setup action; it becomes selectable for operations only after configuration.
Closing the modal returns focus to the navbar chevron.

Operational workspaces consume the active declaration mode's profile association and retain
explicit deployment/region controls and approvals. In Deploy, the global Source selector
chooses a matching Development/Production target through the unsaved-source guard. Entry honors the current mode and only reuses a saved
target from that mode; the page has no deployment rail. Profile names and legacy per-target
profile preferences never choose a mode or override its association. Deploy shows machine
checks and their remedies on the right of the deployment heading, with issues and remedies
before passed checks. The heading uses a plain document header and 18px sans title;
its findings and operational evidence share the document column, type roles and spacing. Narrow layouts wrap the group below the name and keep it aligned right;
there is no separate subnav bar. **Synthesize** prepares and saves the selected mode's
complete deployment assembly and template review without applying it. The newest pending
plan for the exact deployment, mode, profile, account and region is the current plan;
older artifacts remain available under **Earlier plans** for explicit review and recovery.
Each plan card owns **Review plan** and **Discard**. Deployment is confirmed inside its
review; the header has only **Synthesize**, with no promoted review or deployment action.
Preparation and deployment progress belong to Activity. Source, input, target and AWS
connection changes make a saved synthesis unavailable for ordinary deployment. The Repository/AWS cards, stage-origin labels,
separate comparison/change-set controls and stage-creation form remain absent.
The full-width This machine, Client environment & frontend release, and Stateful retention
and retained-resource references cards are absent from Deploy. Their components and backend
services remain available; saved-plan reviews, local operation findings and Activity remain.
CloudFormation events are shown through Activity rather than repeated on the page.
The account/region line shows a caption-sized loading skeleton while the selected profile
is first read, preserving the same line height. Expired or missing
credentials replace that line with a red **AWS sign-in required** text action in the same
type size. Hover/focus reveals its link styling; activation opens the active profile's
configuration modal. These login failures do not add a Sign in button or a findings banner.
**This machine · N checks passed** opens a compact, viewport-bounded popover without
expanding the readiness strip; it follows the profile menu's native Escape, outside-click dismissal
and focus-return behavior. AWS connection details live in the global chevron. Domains still edits Production intent while the global source selector
may display Development: its operational connection is explicitly the active association.
Changing that association or its authentication/configuration invalidates evidence and
pending reviews; it never retargets running jobs. One persistent observer refreshes
read-only deployment evidence for each configured mode on every route; Deploy consumes
the same cached and in-flight queries. Other operational workspaces retain their explicit
inspection actions. See [AWS connections](../../framework-studio/aws-connections.md#shared-deployment-observations)
for target resolution, background scheduling and refresh policy.

| Workspace | Route | What the interface controls |
| --- | --- | --- |
| Map | `/` | Isometric declaration graph, search, tag emphasis, connection visibility, camera, resource navigation, creation and Inspector |
| Database | `/database` | Authored Prisma contract, diagram, validation, migration history and artifact review; separate explicit database target and application controls |
| Deploy | `/deploy` | Active source-mode deployment, header machine checks, synthesis, reviewed deployment, findings and Activity |
| GraphQL | `/graphql` | Placeholder for the GraphQL workspace |
| Authentication | `/cognito` | User pools, identity pools, providers and permissions, each with separate source and deployed evidence |
| DNS / Domains | `/domains` | Production domain input settings, selected-deployment observations and separately approved domain operations |
| WebSockets | `/websockets` | Local and API Gateway connection panels derived from the existing tester; connecting or sending is an explicit runtime action |
| Agent test (experiment) | `/test` | Installed coding CLI planning, exact diff review and separately applied edits to one fixed Studio demo message; see the [local experiment guide](../../framework-studio/local-agent-lab.md) |

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

| State | Owner and lifetime |
| --- | --- |
| Requested entity | Router `?select`; the draft/navigation guard controls acceptance |
| Accepted source mode, graph and pending edits | One mounted `StudioProvider`/`InspectorDraft`; dirty sessions retain their baseline |
| AWS profile associated with each source mode | `StudioProvider` via `aws-profile-selection.ts`; browser cache scoped to repository root, containing profile names only |
| Latest snapshot and source-read evidence | TanStack Query; [snapshot.ts](../../../framework-studio/src/snapshot.ts) and feature query definitions retain existing keys and refresh policies |
| Inspector return trail | In-memory accepted visits, with presentation retained separately per source mode; see [rendering](rendering.md) |
| Prisma text, validation and diagram | Independent `DatabaseSession`, preserving editor identity/undo |
| Docker availability | One Shell-mounted observer and shared query cache; Deploy, Map and Activity consume the same current host observation |
| Global Activity | `GlobalActivity` in the persistent shell owns open/selected state and operation reads; shared log storage and one global operation-event observer continue on every route. Execution belongs to the runner or the operation's legacy service |
| Agent conversation | `useAgentChat` in the persistent shell owns provider, each provider's model selection, transcript, draft, pending request and unread state. These survive mode switches, collapse and navigation, and reset on page reload |
| Sightline display and projection | `views/GlobalActivity.tsx` owns Conversation/Sightline display selection, `views/agent/AgentViewTabs.tsx` presents it in the bar and `sightline/AgentViews.tsx` shows the chosen view; the visible Sightline alone subscribes to route, Studio and cached evidence. Workspace owners register lazy typed readers in `sightline/bridge.ts`, removed on unmount; they never read the projection back. The agent receives none of it |
| Shared deployment target resolution and observations | Pure mode-aware resolver and one persistent observer; TanStack Query owns data/errors/freshness. Consumer hooks subscribe without polling or issuing reads |
| Specialized operational destination, inspection and approval | Owning workspace; shared deployment defaults never replace its explicit target, inspection action or review |
| Agent test prompt, provider and pending review | `AgentLab` owns local form/request state; `AgentLabService` owns expiring plans and the guarded write to `src/agent-lab-message.ts` |
| Camera, hover, filters and disclosures | Local view state; never persisted as framework configuration |

`http.ts` owns token/protocol HTTP mechanics; endpoint adapters own typed calls.
Shared deployment queries include repository/source revision, mode, profile, credential
generation and destination. `GlobalDeploymentObservations` activates one target per
configured mode and owns deployment polling/cache events. Pages subscribe through shared
hooks; specialized inspection state and all action approvals remain with their workspaces.
No AWS failure blocks source navigation or graph rendering. Use the
[source ownership map](../REPOSITORY-MAP.md#where-to-change-studio) to locate rendering,
state, transport and tests for a change.

Docker availability is observed through `/api/machine/docker`, reusing Deploy's host
probe and derived Docker/Compose readiness checks. One Shell observer refreshes every
five seconds while visible, on focus/reconnect and after Docker startup settles. Changed
observations share the existing event stream; older HTTP observations cannot replace newer
ones. Missing, stopped and unavailable/unknown remain distinct. This lightweight read does
not inspect AWS or deployment state.

## Shared Activity

The bottom **Activity** tray belongs to `Shell` and is mounted once for every route.
Its **Activity** and **Agent** tabs choose operation history or a question-and-answer
conversation. Selecting a tab preserves the panel's open or closed state; the separate
summary/chevron control opens and closes it. Arrow keys and Home/End select tabs;
Escape collapses the panel. The drawer slides with an interruptible 280ms
`cubic-bezier(.22,1,.36,1)` transition, disabled under reduced motion. A registered CSS
length on the shell drives both drawer height and map compensation in the same frame.
The occlusion marker remains until
closing finishes; collapsed contents are inert and hidden from accessibility navigation.
Agent offers editable suggestions, a pinned multiline composer, Codex/Claude and model selection,
Markdown answers, copy, stop, retry and confirmed New chat. Replies can finish while
Activity is selected without changing modes; a new-reply dot marks the Agent tab.
Explicit `openActivity(job.id)` switches back to Activity. The initial agent provides
general Q&A with a fixed Studio overview, without reading live source/graph/log context;
see [local coding agents](../../framework-studio/local-agent-lab.md).
`GlobalActivity` is memoized and consumes no route or Studio context, so navigation does
not render it again. Open state, selected job, log DOM, and the reader's scroll position
survive navigation. Job/log changes and tray interactions still update it normally.
Inside Agent, **Sightline** opens a collapsible JSON debug view with Copy JSON and a
character count. Conversation DOM, draft and scroll remain mounted while it is selected.
Only the visible Sightline mounts its input subscriptions; opening it initiates no data
reads. The existing JSON viewer loads lazily, with keyboard expansion controls and Studio
theme tokens. [Sightline](../../framework-studio/sightline.md) defines the read-only
contract, privacy allow-list, workspace state seams and current gaps. The conversation
still receives only its existing bounded messages and fixed server overview.
Opening the bottom panel shrinks the workspace, except the map's canvas, which [runs beneath it](rendering.md).
The tray observes `/api/operations` through the shared operation transport and owns the
global operation-event subscription. Deploy's event observer handles its plan-review/CloudFormation
callbacks. Operations started from Deploy call `openActivity(job.id)` to reveal their job
in the same tray. Cancellation retains the existing command semantics; failed reads and
cancellation errors stay in the tray, with read retry available there. Cursor-based replay
recovers historical log pages and missed tails without adding duplicate lines. Replay
failures remain explicit and retryable. Operations with an origin link offer **Open
workspace**; uncertainty, unverified outcomes and recovery instructions remain visible
separately from command completion.

The tray bar always shows Docker's current state beside the headline, on every route and
whichever job is selected. `dockerPresence` in `shared/machine.ts` derives it from the shared
machine observation and the running startup, never from a past job, and gives each state one
remedy: **Start** (the shared startup operation, in place), **Check again**, an install link,
or the restart/reload instruction when the running server or page is out of date. Startups
leave the headline because the status reports them; only the latest failed or interrupted
startup stays, while Docker is still not running, to explain why. A finished startup's detail
says only how it relates to the present ("Docker has since stopped."), so a past success never
reads as the current state. Stored job results and logs remain unchanged.

Deployment plan/apply/discard, deletion, drift, export and the fixed framework-check
operation use independent host workers. Their logs continue through Studio shutdown and
can be read after restart. Legacy local development and host-remedy jobs retain their
Studio-owned lifetime. Activity itself owns presentation and observation, never approval
or execution. See [operation lifecycle](../deployment/operations.md) for exact recovery
guarantees and the current macOS/Linux boundary.

## Reading the map

Resource and connection counts sit at the map's top right. In Development, the
lower-left **Docker Compose** switch is a visual
prototype. Its on/off state is local to the mounted map and resets when leaving
Development. The shared Docker observation gates activation: a fresh running engine enables
the preview directly; otherwise the existing Docker-help popover offers explicit startup
or rechecking. Confirmed engine shutdown/missing Docker turns the preview off. Starting
Docker never automatically enables the preview, and the switch does not start/stop app
containers. Deploy and the popup share the same startup action and pending operation. Whale motion follows
the map's motion control and the system's reduced-motion preference. Production
does not show the switch.

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

The CDK-file editor writes only `cdk-app/.env.dev` and `.env.prod`, preserving untouched
assignments and comments. Client environment mapping edits symbolic recipes in
`framework-config/client-environment.ts`; export later resolves these into ignored Vite
environment files. The **CDK environment files** island holds **CDK environment**, labeled
**Framework managed**. The separate **Client environment files** island holds the application's
client mappings, which carry no ownership label. The label describes ownership; framework input values remain editable. Every island ends with one
**Island entries** disclosure; there is no separate Files list. Select
`client-app/.env` from its island entries for both export destinations and
the file's mappings; file details remain collapsed. These are symbolic sources, not the
contents of the base `.env` file. Editing a recipe does not export values or deploy resources.
The islands use `island:environment` and `island:client-environment`, respectively.
**CDK environment** represents both physical files as one
variable list: per-environment readiness first, then one row per name with a Dev | Prod pair
(lit with a value, red when a required value is missing) that opens to both values side by
side. Editing is independent of the map's Source; one private review saves whichever files
changed, and refuses both if either file changed. Links to a variable open its row with that
environment's field focused. Revealed values clear when newer source arrives. Individual
file IDs and original connection evidence remain available behind the combined node and its
Dev/Prod supply rows.

Interactive startup creates missing conventional CDK files from their respective templates
before the first graph is published, preserving every existing file. A setup failure offers
**Create .env.<mode> from template** for that file only. Files deleted during the session stay
missing until then or the next launch; snapshot reads, refreshes and `--print` do not create them.

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
