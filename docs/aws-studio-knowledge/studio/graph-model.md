---
id: studio.graph-model
summary: Serialized graph entities, lanes, provenance, edge aggregation, and read-only database projection.
read_when:
  - Adding graph nodes, relations, evidence, or Inspector facts
source:
  - framework-studio/shared/model.ts
  - framework-studio/server/model/project.ts
  - framework-studio/src/connections.ts
  - framework-studio/server/database.ts
related:
  - studio.snapshots
  - studio.source-indexing
  - studio.rendering
---
# Graph entities and edge semantics

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

The Database view uses `parseDeclaredSchema` in [server/database.ts](../../../framework-studio/server/database.ts) to parse the authored Prisma contract and inspect local Compose database metadata. It does not introspect a live database, apply a migration or provide a database schema editor.

When adding a relation, update projection, shared types, lookup/category labels, aggregation, Inspector, layout direction/weight, focus/picking, and tests as applicable; use [change impact](../reference/change-impact.md). Start with [model tests](../../../framework-studio/test/model.test.ts), [database tests](../../../framework-studio/test/database.test.ts), and [rendering tests](rendering.md). Snapshot revisions and edit conflicts belong to [snapshots](snapshots.md) / [editing](editing.md).

`ModeModel.networks` contains stable VPC identities and per-network settings.
VPC workload placement includes `networkId`; recognized native member placement does too.
Network islands, subnet bands and fixtures use VPC-qualified IDs. The database's local
counterpart is drawn only in its declared VPC. Native helper calls and simple aliases are
source evidence; synthesis inventory remains the authority for built infrastructure.
