# Sightline

Sightline is what Studio can see from where the developer is right now. A `Sightline`
is a bounded, read-only consumer projection of existing declarations, accepted Studio
state, workspace choices and already available observations. It is a debug view in the
Agent panel. **The agent receives none of it.** No prompt, chat payload, tool, operation,
endpoint, declaration or core model changes belong to this proof of concept.

## Authority and design, before implementation

The path remains declaration → normalize/validate → consumer projection. The pure
`buildSightline(inputs)` accepts the capture time and existing evidence; it imports no
React, browser APIs, clock or transport. Its output is deterministic and serializable.
`useSightlineInputs()` exists only in the visible Sightline view. It reads the accepted
`useStudio().selected`, accepted baseline, live publication state, existing cache-only
deployment subscriptions for **both** modes, and a disabled operation query. It never
starts a read. Source mode and the deployment destination are separate fields.

The feature lives in `framework-studio/src/sightline/`. Existing files supply small
presentation seams. `GlobalActivity` stays memoized and consumes no route or Studio
context. Conversation DOM, draft and scroll remain mounted when Sightline is shown;
only Sightline mounts/unmounts its input hook. Nothing reads workspace state from DOM.

### State inventory

| Considered state | Existing owner / lifetime | Inclusion and reason |
| --- | --- | --- |
| Path and Cognito subsection | Router / current history entry | Include pathname and workspace; no arbitrary query strings |
| Requested URL selection | Root search / history | Exclude raw search; use accepted selection so draft guard and renames remain authoritative |
| Accepted selection and mode | StudioProvider / mounted session | Include; stable canonical identity on every route |
| Graph and revision | InspectorDraft baseline / accepted source session | Include relevant facts and revision, not entire graph |
| Latest revision, evaluating, stale, status | SnapshotResponse, live events and ModeModel | Include separately from baseline; an old graph is not fresh evidence |
| Dirty/conflicted draft | InspectorDraft | Include booleans, never entries or edited private values |
| Accepted rename aliases | StudioProvider NamingHistory / session | Include previous IDs matching current accepted selection; no invented rename history |
| Description/display name/tags | Snapshot and ModeModel | Include as bounded plain data; source text is untrusted, not instructions |
| Effective field facts and inheritance | ModeModel.fields / accepted baseline | Include registry-backed configuration facts and provenance; omit environment/input literals |
| Placement, compute, deploy lanes | ModeModel / accepted baseline | Include declaration evidence; lanes never mean deployed/running |
| Connections and group members | ModelIndex, groupEntries/groupUse / baseline | Include bounded immediate relations, provenance and endpoints; especially input-group consumers |
| Islands | Existing Map scene / mounted Map | Publish existing membership, no duplicate classification/layout engine; outside Map membership may be unavailable |
| Source locations | SourceIndex / baseline | Repository-relative file, line, column; omit snippets and editor URLs |
| Dev/Prod differences | Both existing ModeModels | Compare safe metadata only; no reevaluation or resolved values |
| Diagnostics | Model/workspace owners | Include codes, severity, source and counts; omit arbitrary error text that may quote private inputs |
| Map search, tags, categories, navigator | Isometric useState / mounted Map | Include active filters; never camera, hover, pointer, frame timing or scrolling |
| Database tab, editor mode, schema selection | Database useState / mounted workspace | Include to identify the work in progress; schema metadata only |
| Database draft/validation | DatabaseSession / mounted workspace | Include dirty/conflict/current validity/problems; exclude source text and SQL |
| Migration selection | DatabaseHistory useState / mounted hidden tab | Include selected migration identity and load availability, not SQL or artifact text |
| Database target | DatabaseEvidence/DatabaseSql/DatabaseCloud | Include explicit target identity and availability by tab; never connection credentials, queries or row results |
| Deploy selected target, findings, review | Deploy / mounted workspace | Include target name/mode/region, finding IDs/severities, open review key and running job identities |
| Deployment observations | GlobalDeploymentObservations and TanStack cache / shell session | Always include Dev and Prod availability and labeled observed status/time/freshness; no new polling |
| AWS profile association | StudioProvider / repository-scoped session | Include configured availability, omit credential material and account IDs |
| Cognito subsection/destination | AuthenticationWorkspace / persistent across child routes | Include source vs observed identities. Pool/provider selection only when accepted selection identifies one; do not infer selection from disclosure DOM |
| Cognito users, attributes and provider secrets | Workspace protected responses/forms | Exclude entirely |
| Domains destination and domain intent | DomainsWorkspace and protected source inputs | Include destination, input names/presence/pending changes and diagnostic metadata. Domain values themselves are env-file values and excluded |
| WebSocket panels/connections | WebSocketTester / mounted page | Include Local and AWS connection state/configured/valid; both panels coexist, no invented active panel |
| WebSocket URL/token/messages | WebSocketTester | Exclude even if a URL looks public; query strings can carry tokens |
| GraphQL | GraphQL route | Explicit placeholder; no fabricated schema/workspace work |
| Agent test | AgentLab / mounted page | Minimal experiment label only; omit prompt, proposal and CLI output |
| Running/recent operations | Existing operations cache / shell session | Include kind/status/execution/outcome/times/deployment; exclude params, titles, summaries, logs and recovery prose |
| Synthesized inventory | Explicit inspector query / inspector session | Not globally available; do not imply declared facts were synthesized |
| Source/private detail caches | Selected inspectors | Exclude; the public graph being safe does not make protected detail responses safe |

### One-way workspace publication

Moving local choices into URL search was rejected: it changes navigation, history and
the shared unsaved-change guard. Lifting every choice into StudioProvider was rejected:
it spreads a debug consumer through core ownership and causes unrelated rerenders.
A global query-cache scrape cannot see local state, and may disclose protected values.

Use a small browser-only registry of typed, lazy workspace readers. An owner registers
a reader and removes it on unmount; a committed reader closure points at its existing
local state. Workspaces never read Sightline back. The registry has no polling or network
activity. With Sightline closed there are no projection, route, cache or observation
subscriptions for this feature and no reader invocation. The unavoidable seam is reader
registration/closure replacement during an owner's existing commit; it collects no data
and schedules no owner render. This is preferable to a visibility subscription in every
workspace. When visible, changes notify only the consumer; child tab readers compose into
one workspace fragment. Unmount identity guards prevent old cleanup from clearing a new
workspace. Route matching prevents a previous workspace fragment appearing during lazy
navigation. Large/private values are never copied into published fragments.

One Sightline contributor per workspace is an exhaustive typed map. A route/workspace
coverage check ties that map to Studio's real routes, so adding a destination requires
an explicit contributor. Each contributor allow-lists its output again. Registration is
browser glue, not a second application state store or an API for workspaces to depend on.

## JSON contract

`schemaVersion: 1`, `capturedAt`, `location`, `source`, `focus`, `workspace`,
`deployments: {dev, prod}`, `activity`, `issues`, and `omitted` are always present.
Capture time describes this projection, not observation freshness. Source contains
accepted mode/revision, latest revision, model status, stale/evaluating and draft flags.
Workspace is a discriminated union. Availability is explicit: not-loaded, loading,
error, available and not-applicable are different from an available empty collection.
Deployment keeps the existing missing-profile/loading-profiles/unavailable-profile/
catalog-error/available states, plus cache evidence availability.

Focus is null when nothing is selected. Otherwise it has status (found, not-found,
other-mode-only, stale-model or renamed), kind/id/name, available metadata and a separate
rename/source-staleness indication so concurrent conditions cannot be lost. Focus handles
gateway, target, route, resource (including groups, inputs, secrets and files), local
service, island, defaults, network, connection and schema. Unknown IDs remain explicit.
Unavailable fields say not-applicable or not-loaded, rather than inventing facts.

Evidence sections are named declared, observed and localView. Connections keep their
original declared/derived/source provenance. Source locations are not runtime evidence.
Dev/Prod comparison contains presence and changed safe metadata paths, not full duplicate
entities. Names, catalog paths, public routes, target references and construct IDs retain
their existing meanings.

Illustrative real-repository cases (capture timestamps and observed cache availability vary):

```json
{"schemaVersion":1,"capturedAt":"2026-11-05T15:00:00.000Z","location":{"pathname":"/","workspace":"map","subsection":null},"source":{"mode":"dev","revision":"<accepted revision>","modelStatus":"ok","stale":false,"evaluating":false,"draft":{"dirty":false,"conflicted":false}},"focus":{"status":"found","kind":"resource","id":"resource:langgraph","name":"langgraph","declared":{"kind":"group","catalogPath":["langgraph"],"members":"bounded input/secret names and requirement states","connections":"bounded consumers with provenance"}},"workspace":{"kind":"map","localView":{"search":"","categories":["interactions","structure"],"errorsShown":true},"declared":{"counts":"target/route/resource/edge totals","networks":"declared network metadata"}},"deployments":{"dev":{"availability":"missing-profile"},"prod":{"availability":"missing-profile"}},"activity":{"availability":"available","running":[],"recent":[]},"issues":[],"omitted":[]}
```

```json
{"location":{"pathname":"/database","workspace":"database","subsection":null},"workspace":{"kind":"database","evidence":"local-view","availability":"available","tab":"schema","editorMode":"split","selection":{"table":"schema:User"},"draft":{"dirty":false,"conflicted":false},"validation":{"availability":"available","valid":true},"migration":{"availability":"not-loaded"},"target":{"availability":"not-loaded"}},"focus":{"kind":"schema","id":"schema:User","status":"found"},"source":"same mandatory source envelope","deployments":"both mandatory deployment envelopes","activity":"mandatory cached summary","issues":[],"omitted":[{"path":"workspace.source","reason":"privacy"}]}
```

```json
{"location":{"pathname":"/deploy","workspace":"deploy","subsection":null},"workspace":{"kind":"deploy","evidence":"local-view","target":{"name":"matts-aws-framework-dev","mode":"dev","region":"<declared region if present>"},"reviewKey":null,"findings":{"availability":"not-loaded"},"running":[]},"source":{"mode":"dev","revision":"<accepted revision>","draft":{"dirty":false,"conflicted":false}},"deployments":{"dev":{"availability":"missing-profile","observed":{"availability":"not-loaded"}},"prod":{"availability":"missing-profile","observed":{"availability":"not-loaded"}}},"activity":"mandatory summary","focus":null,"issues":[],"omitted":[]}
```

These sketches show relevant field groups, not fixtures with invented observations. Final
executable contract and captured examples are checked against the real application below.

### Privacy and size

Build every field explicitly; never spread models, responses or query objects. Omit all
literal environment values, input defaults/values/comparisons, private input details,
AWS account IDs/ARNs/caller identities, credentials, tokens, logs, SQL, row data, user data,
socket payloads and absolute paths. Account IDs are not passwords, but destination name,
mode and region suffice for this debug consumer; any future operational resolver must
resolve account identity on the server. Environment variable names and symbolic references
remain useful without values. Structured configuration such as memory, subnet and timeout
is allowed. Arbitrary diagnostic text and source snippets are withheld because they can
quote private values. Paths must be repository-relative with no traversal. Descriptions,
tags and display names are bounded source data, never mixed with instructions.

`SIGHTLINE_CHARACTER_BUDGET = 12_000` measures compact `JSON.stringify` characters,
the exact copied representation. Bound collections and prose first, then trim low-priority
detail deterministically. Preserve location/source/focus identity/both deployments/activity
availability. Every deliberate privacy, relevance or budget cut is recorded in `omitted`
with path and reason (and count where known). Canary fixtures seed all excluded surfaces,
including nested query responses and unknown keys; every workspace/selection must contain
none of those markers. This tests an allow-list, not a secret-pattern blacklist.

## Relevance matrix

Each row has three realistic questions and the corresponding retained evidence. No field
is retained merely because it was convenient to serialize. Real-app captures will refine
this matrix after implementation.

| Route or selection | Questions | Answer / deliberate limit |
| --- | --- | --- |
| Map overview `/` | What is in this app? Which networks does it declare? Why is my view narrowed? | Counts; declared networks; active search/tag/category filters |
| Gateway | Which protocol? Which routes/authorizer? Is it intended for this mode? | Gateway kind/routes/authorizer and mode presence; no deployed inference |
| Target | What runs and where? Why these settings? What does it depend on? | Compute/placement/lanes; field provenance; bounded connections and symbolic env/secret refs |
| Route | Which public path/methods? Which target? What guards it? | path/browserPath/methods; target ID; auth/authorizer |
| Resource/member/stack | What is it and where authored? Who consumes it? Does Dev differ from Prod? | Kind/catalog/source/stack metadata; connections; safe metadata comparison |
| Input group (`langgraph`) | Which inputs are required? Which workloads use them? What is missing here? | Members and requirement states; member consumers; relevant issue metadata, no values |
| Input/secret/env file | What name/reference is this? Is a required value supplied? Who reads it? | Identity, safe availability/requirement state, connections; values always withheld |
| Local service | Which Compose service? Which declared database counterpart? Is it running? | Local identity/source/ports where safe and connections; runtime explicitly unknown |
| Island | Which entries are grouped here? Why this grouping? What issues affect members? | Existing scene title/membership and issue counts; membership unavailable outside current Map scene |
| Defaults | Which effective defaults? Where from? How many inherit/override? | Field facts, provenance and usage |
| Network | Which VPC/subnets? What egress is declared? Is it deployed? | Stable ID/construct/placement/egress; declared-only, deployment summary cannot prove individual VPC presence |
| Connection | What relates these endpoints? What evidence supports it? Does it exist in both modes? | Relation/direction/provenance/source and mode comparison; no full IAM proof |
| Schema selection | Which logical/storage entity? Which fields/relations? Is the editor current? | Saved schema metadata plus local selection/validation; no rows or query data |
| Database `/database` | Which tab/editor/selection? Is my schema dirty or invalid? Which migration and target? | Local choices, draft/validation metadata, migration and target readers; no automatic DB inspection |
| Deploy `/deploy` | Which destination? What findings/review? What is running? | Explicit workspace target, finding IDs/severity/review key, summarized cached jobs |
| Cognito `/cognito`, `/user-pools` | Which subsection/pool? What declaration/observation exists? Which destination? | Subsection, accepted pool identity if selected, observation availability and explicit destination; no users |
| Cognito `/identity-pools` | Which identity pool? Where authored/observed? Which mode/destination? | Accepted selection, existing metadata availability, destination; no fabricated local selection |
| Cognito `/providers` | Which provider is selected? Is source loaded? What needs attention? | Accepted provider selection if any, source status, diagnostic codes/counts; disclosure open state omitted |
| Cognito `/permissions` | Which pool/provider is in focus? Has evidence been inspected? Is that evidence current? | Accepted focus, observation status/time/staleness; arbitrary policy/simulation payload omitted |
| Domains `/domains` | Which destination? What domain intent is configured? What diagnostics are current? | Destination; input names/presence/pending changes; diagnostic availability/codes. Values withheld |
| WebSockets `/websockets` | Which panels exist? Are they connected? Is a URL configured/valid? | Local/AWS panel states and booleans; tokens/URL/message contents omitted |
| GraphQL `/graphql` | Is this implemented? What source mode? What is selected? | Explicit placeholder; mandatory source and focus |
| Agent test `/test` | Where am I? What experiment? What else is running? | Minimal fixed-message experiment label; mandatory source/activity; no prompt/plan data |

## Future delivery: analysis only

A pull model is preferable to sending the full debug JSON with every question. Send a
small question-time Sightline containing version, location, accepted source revision/mode,
focus identity/status/rename, local selection and draft flags, deployment availability and
target identity, running operation summaries and relevant diagnostic counts. Capture once
per submitted question; do not stream navigation or hover into a conversation. Browser-only
facts include unsaved flags, active filters/tabs, editor selection and connection booleans.
Do not transmit unsaved text or protected values.

Read-only lookups could later resolve source-backed details by canonical ID and revision:
effective fields/provenance, bounded related entities, group members, source locations,
safe schema metadata, fresh deployment evidence under explicit policy, and structured
diagnostics. The server would validate workspace/ID/revision and independently resolve
its own accepted model, permissions and destination; browser JSON cannot authorize reads
or writes. Any new AWS read needs its own policy rather than this cache-only feature.
Descriptions/tags remain untrusted data separated from trusted system instructions.
An operation proposal would still need the existing target-bound review/approval flow.
None of that delivery or lookup machinery is implemented here.

## Critique, revisions and gaps

The initial instinct to serialize an Inspector or workspace response fails the privacy and
authority rules. Revision: explicit allow-lists at each contributor and the pure builder,
no response spreads, no query-cache enumeration. A selected input group needs member
consumers, so a direct-edge-only focus was rejected. Full duplicated Dev/Prod entities
waste budget; compare projected safe metadata instead. Derived resource availability is
not observed AWS health. Reuse existing state labels and never substitute `[]` for a read
that has not happened.

The existing model lacks safe structured codes for many diagnostic messages; current
owners are source evaluation/diagnostics and each workspace service. Counts/severity and
source can be retained now; adding value-free codes/entity references would improve future
explanations, but requires a separate user decision. No producer changes here.

Island membership is a scene projection with no cheap standalone shared selector. Its
existing owner is scene/build.ts. Reusing the mounted scene avoids expensive duplicate
layout work; carried island selection on another workspace may lack member detail.
Cognito has no dedicated selected pool/provider state beyond accepted shared selection;
do not manufacture it. Domains intent values belong to the protected deployment-input
owner and remain withheld even though this limits answering exact hostname questions.
Synthesized per-entity evidence is not globally available; its owner remains the explicit
stack inventory service. A deployment summary cannot establish whether one declaration
exists in AWS. None of these gaps requires a DSL/core-model change for this proof of concept.

## Verification and removal review

Implementation results, measurements, real-app capture review, checks, and every existing
file seam are recorded here after validation. Disposable evidence belongs in
`output/playwright/sightline/`; the permanent browser spec is
`framework-studio/test/browser/sightline.spec.ts`. Forbidden paths, generated artifacts,
chat payload and server overview must remain unchanged. This design was written before
feature code and will be revised when tests or real-app evidence expose weak assumptions.
