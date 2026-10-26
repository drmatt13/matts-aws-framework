---
id: studio.graph-model
summary: Serialized graph entities, lanes, provenance, edge aggregation, and database source projections.
read_when:
  - Adding graph nodes, relations, evidence, or Inspector facts
source:
  - framework-studio/shared/model.ts
  - framework-studio/shared/permissions.ts
  - framework-studio/shared/grants.ts
  - framework-studio/server/model/project.ts
  - framework-studio/server/model/catalog-context.ts
  - framework-studio/src/connections.ts
  - framework-studio/server/database.ts
  - framework-studio/shared/database-workbench.ts
  - framework-studio/shared/database-history.ts
related:
  - studio.snapshots
  - studio.source-indexing
  - studio.rendering
---
# Graph entities and edge semantics

`ModeModel.tagging` maps canonical entity IDs to authored/effective tags, per-key provenance
and explicit AWS ownership/capability explanations. Targets, routes, networks, database,
catalog entries and source-discovered public members share this metadata. It never contains
secret values. Board and Isometric retain the same canonical selection and source identities;
tag filtering is a rendering projection rather than a new infrastructure resource.

[shared/model.ts](../../../framework-studio/shared/model.ts) is the serialized server/browser contract; avoid creating parallel graph types in a view. `projectModel`, `targetLanes` and `targetPlacement` in [model/project.ts](../../../framework-studio/server/model/project.ts) derive the graph from normalized declarations and mode predicates.

Each synchronous `projectModel` call creates fresh operation-local availability
from the canonical framework enabled/deployed predicates. Cloud selection and
cloud-edge validation likewise share one normalized target map per call. Lambda
settings for fields, compute and placement are batch-resolved into a temporary
projection scope in [lambda-spec.ts](../../../framework-studio/server/model/lambda-spec.ts)
and restored/released in `finally`. The next projection refreshes this scope even
if its config object was changed in place. No persistent graph or availability
cache crosses operations. Standalone predicate calls keep their current-config
semantics. [Projection regression tests](../../../framework-studio/test/projection-performance.test.ts)
check bounded declaration enumeration, fresh subsequent projections and complete
lane-byte equivalence with the standalone predicate path.

| Model | Carries |
| --- | --- |
| `Snapshot` | Revision, dev/prod `ModeModel`s, source index, file hashes, schema and descriptions |
| `ModelTarget` | Canonical ref/kind/role, directory/origin, construct ID, compute, placement, lanes, environment and permission facts; optional implementation artifact readiness/problems |
| `ModelRoute` | Public route/method semantics and target; route and target identities are distinct |
| `ModelResource` | Catalog path/kind, member/input/secret metadata, capabilities and stack usage; not resolved secret contents |
| `ModelEdge` | Directed `from`/`to`, relation, provenance, source evidence and supported removal information |
| `FieldFact` | Authored/effective setting, inheritance, domain and editability reason |
| `SourceIndex`, `CdkLinkIndex` | Source entities/files, capabilities, inferred connections and diagnostics |

Relations cover routing, authorization, environment/secret reads, native grants, database access, invocation bindings, workflow steps/integrations, event triggers, callbacks and failure destinations. Their meanings differ: a grant is permission; an invocation binding is capability; neither proves an actual runtime call. Schedule triggers may have no catalog resource endpoint.

The [permissions investigation](../../framework-studio/permissions-analysis.md)
maps the grant-generation paths and source-evidence limits. `ModelEdge.permissionContext`
records typed normalization/adapter facts; `withConnectionAuthorizations` derives
principal, actions when known, symbolic scope, conditions and policy kind. It runs in
projection and again after source/local enrichment. `authorization` is derived presentation
and excluded from binding review signatures; typed context remains part of the source semantics.
Original relation IDs, labels and description keys stay stable. Database IAM is `rds-db:connect`
for `app_user`; its local PostgreSQL derivative carries no AWS grant. Reader access retains
writer access. Typed secret ARN delivery grants the workload role; container startup injection
uses the ECS execution role. Pull event arrows and IAM principal direction are independent.

Connection titles and relationship rows retain their authored labels and purpose verbs,
including `Routes to` for managed API routes. Authorization never replaces a route,
environment variable, grant binding or workflow-step label. Single-connection hovers append
a compact IAM action/helper summary after the relationship details, qualified `AWS only`
when the selected graph does not build those permissions. Connection/member inspectors
keep principal, scope, conditions and evidence behind a collapsed Permissions disclosure;
resource previews omit IAM counts. Workload Permissions retains the full capability list.
`Only IAM grants` filters background wires within enabled purpose
categories, checking all current-mode group members. Selected/previewed resources still reveal
all context. User-token agent invocations and unknown/custom native references do not qualify.
Schedules, unlinked callbacks, custom integrations and explicit `cloud.access` also appear in
workload permissions without inventing graph endpoints. Supported grant creation is a bounded
type-discovered allowlist shared by UI and server (S3, SQS, DynamoDB, SNS, EventBridge).
Source-derived facts do not establish synthesized, deployed or effective IAM access; arbitrary
native statements, trust/key policies and policy evaluation require their own evidence.

The `runsTask` binding appears in the permissions category as `Launch ECS task`.
Its solid red connection describes the derived ECS launch and role-passing grants plus
launch configuration, rather than an observed execution. Conditional `deployWhen`
connections use dashed orange lines and name the selecting input in their hover text.

Client environment `maps` edges point from public catalog input parameters and native
stack outputs into `client-envfile` (`client-app/.env`), never directly from CDK input files.
CDK files supply parameters; each parameter carries selected-mode presence/default metadata
and sanitized outcomes for declared client comparisons. Hover and connection
details say `Maps into`; the client's incoming connection list says `Mapped from`.
Layout uses this source-to-client direction without reversing these edges.
Local URL inputs are declared under `resources.client` only in Development.
`VITE_LOCAL_WS_URL` also consumes `resources.enableWebSocketApi`; its condition writes
an empty URL when the selected input does not match `"true"`. Raw input values stay private.
The evaluator pair retains an absent input's type from the other mode while preserving
its absence, so snapshot display, creation review and apply checks share the same metadata.

Declared/derived/source-inferred edges retain their evidence classification. [source-indexing](source-indexing.md) defines inference limits. Studio is a declaration/source graph, not an authoritative live AWS topology or full IAM analysis.

Implementation health is separate from declaration validity: a missing handler can leave
the declaration graph readable so its node offers repair. Board, Isometric and Inspector
show this warning without inventing a replacement target, changing topology or asserting
runtime health. Reviewed source application checks canonical artifacts against the proposed
file overlay; current files are never silently scaffolded during evaluation.

`aggregateConnections` in [connections.ts](../../../framework-studio/src/connections.ts) groups directed visible endpoint pairs while retaining original members and mode availability. A rendered line may summarize several relations; selection/Inspector must preserve member-level evidence. Dev/prod union topology can stabilize layout while the active mode controls availability and styling. `lookup.ts` in [src/lookup.ts](../../../framework-studio/src/lookup.ts) centralizes entity/relationship lookup labels.

The Database workbench uses `parseDeclaredSchema` in
[server/database.ts](../../../framework-studio/server/database.ts) for source-linked diagram
projection. Semantic validity comes from the configured, installed Prisma interpreter in
[server/database-workbench.ts](../../../framework-studio/server/database-workbench.ts),
independently from the framework snapshot. The editor draft remains authoritative for its
diagram; temporarily invalid drafts retain an explicitly marked last-valid diagram.
Logical Prisma names and mapped storage names remain distinct. Unsupported valid source
stays accessible instead of being regenerated from the projection.

`DatabaseHistory` in [shared/database-history.ts](../../../framework-studio/shared/database-history.ts)
describes migration graph edges and verified semantic snapshots; terminal nodes are hints,
never implicit migration origins. `DatabaseObservation` in
[shared/database-workbench.ts](../../../framework-studio/shared/database-workbench.ts)
separates selected-target marker/ledger evidence from strict physical verification against
saved and historical storage. A declaration graph, matching marker or valid source alone
cannot establish database synchronization. Local observation never starts Compose. Local
database application needs a target-bound review. Production uses an explicitly approved
private IAM task: metadata preparation, billed read-only inspection and reviewed application
are distinct actions. No database action follows the graph-mode switch. See the
[workbench guide](../../framework-studio/database-workbench.md).

`DatabaseWorkbench.emitted` separately observes the configured generated JSON's content
revision and canonical storage/execution hashes against saved source. It carries safe
metadata/status only, never the raw artifact. This evidence neither generates files nor
proves generated TypeScript, downstream consumers, migration application or live storage.

When adding a relation, update projection, shared types, lookup/category labels, aggregation, Inspector, layout direction/weight, focus/picking, and tests as applicable; use [change impact](../reference/change-impact.md). Start with [model tests](../../../framework-studio/test/model.test.ts), [database tests](../../../framework-studio/test/database.test.ts), and [rendering tests](rendering.md). Snapshot revisions and edit conflicts belong to [snapshots](snapshots.md) / [editing](editing.md).

`ModeModel.networks` contains stable VPC identities and per-network settings.
VPC workload placement includes `networkId`; recognized native member placement does too.
Network production applicability derives from the projected targets' placement and
production lanes, including resolved workload deployment conditions, then adds database and
source-discovered native-stack consumers. Do not recalculate workload availability in
the network projection with different deployment options.
Network islands, subnet bands and fixtures use VPC-qualified IDs. The database's local
counterpart is drawn only in its declared VPC. Native helper calls and simple aliases are
source evidence; synthesis inventory remains the authority for built infrastructure.

`ModeModel.gateways` describes actual HTTP/WebSocket gateways and their route IDs,
authorizer and export-stack resource. `deployChoices` comes from the framework's
pure lane preview. Conditional `Lanes.when` contains references, comparison literals
from source and per-environment outcomes; it never contains resolved input values.
The `deployWhen` relation connects workloads to their selecting input.
