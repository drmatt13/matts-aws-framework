---
id: studio.graph-model
summary: Serialized graph entities, lanes, provenance, edge aggregation, and database source projections.
read_when:
  - Adding graph nodes, relations, evidence, or Inspector facts
source:
  - framework-studio/shared/model.ts
  - framework-studio/server/model/project.ts
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

| Model | Carries |
| --- | --- |
| `Snapshot` | Revision, dev/prod `ModeModel`s, source index, file hashes, schema and descriptions |
| `ModelTarget` | Canonical ref/kind/role, directory/origin, construct ID, compute, placement, lanes, environment and permission facts |
| `ModelRoute` | Public route/method semantics and target; route and target identities are distinct |
| `ModelResource` | Catalog path/kind, member/input/secret metadata, capabilities and stack usage; not resolved secret contents |
| `ModelEdge` | Directed `from`/`to`, relation, provenance, source evidence and supported removal information |
| `FieldFact` | Authored/effective setting, inheritance, domain and editability reason |
| `SourceIndex`, `CdkLinkIndex` | Source entities/files, capabilities, inferred connections and diagnostics |

Relations cover routing, authorization, environment/secret reads, native grants, database access, invocation bindings, workflow steps/integrations, event triggers, callbacks and failure destinations. Their meanings differ: a grant is permission; an invocation binding is capability; neither proves an actual runtime call. Schedule triggers may have no catalog resource endpoint.

Declared/derived/source-inferred edges retain their evidence classification. [source-indexing](source-indexing.md) defines inference limits. Studio is a declaration/source graph, not an authoritative live AWS topology or full IAM analysis.

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
cannot establish database synchronization. Production access remains unsupported; local
observation never starts Compose. Reviewed local application uses a separate target-bound
approval. See the [workbench guide](../../framework-studio/database-workbench.md).

`DatabaseWorkbench.emitted` separately observes the configured generated JSON's content
revision and canonical storage/execution hashes against saved source. It carries safe
metadata/status only, never the raw artifact. This evidence neither generates files nor
proves generated TypeScript, downstream consumers, migration application or live storage.

When adding a relation, update projection, shared types, lookup/category labels, aggregation, Inspector, layout direction/weight, focus/picking, and tests as applicable; use [change impact](../reference/change-impact.md). Start with [model tests](../../../framework-studio/test/model.test.ts), [database tests](../../../framework-studio/test/database.test.ts), and [rendering tests](rendering.md). Snapshot revisions and edit conflicts belong to [snapshots](snapshots.md) / [editing](editing.md).

`ModeModel.networks` contains stable VPC identities and per-network settings.
VPC workload placement includes `networkId`; recognized native member placement does too.
Network production applicability derives from the projected targets' placement and
production lanes, including the selected WebSocket API setting, then adds database and
source-discovered native-stack consumers. Do not recalculate workload availability in
the network projection with different deployment options.
Network islands, subnet bands and fixtures use VPC-qualified IDs. The database's local
counterpart is drawn only in its declared VPC. Native helper calls and simple aliases are
source evidence; synthesis inventory remains the authority for built infrastructure.
