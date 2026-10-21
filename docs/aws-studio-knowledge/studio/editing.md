---
id: studio.editing
summary: Canonical draft, review, AST transformation, guarded apply, rollback and undo contract.
read_when:
  - Changing Inspector fields or source-writing behavior
  - Debugging stale review, conflict, apply, rollback, or undo
source:
  - framework-studio/src/draft.ts
  - framework-studio/src/views/Deployment.tsx
  - framework-studio/server/edits/transaction.ts
  - framework-studio/server/edits/batch.ts
  - framework-studio/server/edits/plan.ts
  - framework-studio/server/edits/splice.ts
  - framework-studio/server/edits/io.ts
related:
  - studio.source-indexing
  - studio.snapshots
  - studio.creation-connections
---
# Inspector drafts and source transactions

This is the canonical graph-to-source contract. Creators, trigger editors and resource tools reuse it; they do not gain arbitrary file-writing authority.

`InspectorDraft` in [draft.ts](../../../framework-studio/src/draft.ts) owns baseline/latest snapshots, staged entries, validation, review and navigation protection. While dirty, the visible graph stays on the baseline. A different snapshot revision marks conflict; it does not auto-merge. Invalid/conflicting drafts cannot apply. `StudioProvider` in [studio.tsx](../../../framework-studio/src/studio.tsx) connects this lifecycle across routes and browser exit. The draft/history is in memory, not durable recovery storage.

Inspector settings consume `FieldFact` inheritance and source editability. `FIELDS`, `DEFAULT_FIELDS`, `fieldFacts` and `fieldById` in [edits/fields.ts](../../../framework-studio/server/edits/fields.ts) define recognized fields, domains, parsers, source paths and defaults. Add a field through this shared contract rather than a UI-only input. Effective inherited values and authored overrides must remain distinct; removal restores inheritance. Some boolean fields support true/absence rather than explicit false.

Boolean settings reuse `InspectorSwitch` in `InspectorUI.tsx`, including VPC/database
policies and creation forms; toggling stages the owning draft and never applies source.
VPC inspectors contain only network settings and membership, not global workload defaults.
`SharedDefaults.tsx` presents family defaults in their related inspectors; database caller
pool defaults live beside Managed PostgreSQL controls and still edit `defaults.database`,
independently of the server policy declaration. See the
[inspector conventions](../../framework-studio/inspector-design.md).

`InterfaceEndpointPicker.tsx` replaces comma entry in VPC editing and creation with
searchable service icons and removable selections. It stages exact endpoint IDs through
the existing network/create drafts. `ModeModel.interfaceEndpointServices` is projected
directly from `INTERFACE_ENDPOINT_SERVICES`, the framework's generated CDK catalog;
`src/endpoint-services.ts` supplies only labels and local artwork. Gateway endpoints keep
their separate controls. An unavailable catalog offers a server restart instruction and
preserves authored selections. The catalog does not verify regional service availability.

The shared [Deployment section](../../../framework-studio/src/views/Deployment.tsx) places the same Dev/Prod cards and scope field on workloads and routes. Route edits target the owning workload. Draft scope previews use each `ModeModel.webSocketApi` flag; saved availability comes from each graph's own target. Catalog/local-service inspectors reuse the cards, with managed ownership explained instead of inventing a deploy field. Catalog availability is not evidence of deployed infrastructure. See the [inspector conventions](../../framework-studio/inspector-design.md).

```mermaid
flowchart LR
  A[Stage draft] --> B[Plan source overlays]
  B --> C[Validate both modes + relevant TS checks]
  C --> D[Review per-file diffs / impact]
  D --> E[Recheck revision / hashes / authority]
  E --> F[Write files / rebuild snapshot / compare]
  F --> G[Record undo or guarded restoration]
```

`EditService` in [transaction.ts](../../../framework-studio/server/edits/transaction.ts) serializes its operations and keeps plans/history. `BatchEditor` in [batch.ts](../../../framework-studio/server/edits/batch.ts) composes field, route, trigger, failure destination, replay wrapper, description, mapping and creation changes into source overrides. Resource and environment details have specialized services with their own validation/private data; see [secrets](../deployment/secrets.md).

`planEdit` in [plan.ts](../../../framework-studio/server/edits/plan.ts) uses [source locations](source-indexing.md), narrow parsing and semantic patches; `diffOf` emits a compact contiguous diff. [splice.ts](../../../framework-studio/server/edits/splice.ts) replaces/inserts/removes supported literal ranges while preserving surrounding source/quotes. It refuses unsafe computed shapes/comments instead of reprinting entire files.

Plans capture revision and file hashes; both fresh mode evaluations must pass. Trigger/CDK/creation changes also use TypeScript checks where implemented. Normal Inspector edits preserve target/construct identity. Creation permits expected additions while preserving existing identities and includes [preview-generated artifacts](creation-and-connections.md) in review/history. Plans expire after relevant source changes. Review approval saves authored/generated source; it does not synthesize or deploy infrastructure.

Apply checks source before and after preflight, then checks each write's expected contents. `writeSourceChange` in [io.ts](../../../framework-studio/server/edits/io.ts) distinguishes absent files (`null`) from empty files, creates through an exclusive link, and replaces existing files by temporary-file rename. After refresh, the batch compares relevant actual identities/settings/routes/triggers/creation relationships with the reviewed model.

**Multi-file apply is not a crash-atomic filesystem transaction.** On caught failure it restores written files in reverse only while they still equal its own written contents. Concurrent edits are preserved and can produce `unconfirmed`; inspect those files. Undo/redo uses expected contents and inverse validation, including creator-owned file deletion. Server restart loses in-memory review/history; no durable journal makes interrupted writes automatically recoverable. Revision/hash checks also do not eliminate every external-editor race between a check and rename.

Use [extensions](../guides/extensions.md) for new fields. Tests: [plan](../../../framework-studio/test/plan.test.ts), [splice](../../../framework-studio/test/splice.test.ts), [transaction](../../../framework-studio/test/transaction.test.ts), [draft](../../../framework-studio/test/draft.test.ts), [draft UI](../../../framework-studio/test/draft-ui.test.ts), and feature-specific creation/trigger/resource suites. Assert refusal causes zero writes and undo preserves unrelated changes.

Typed VPC removal and managed database settings reuse this batch journal, including
post-apply semantic checks, guarded rollback and undo/redo. VPC removal rescans source
consumers immediately before writing. Database edits target only literal policy settings;
placement and native identity changes remain source-owned. The
[HTTP response helper](../../../framework-studio/server/http.ts) catches synchronous
validation as well as rejected planning promises. A shared browser/server protocol blocks
incompatible edits with an explicit restart instruction; a Vite refresh does not reload
the running server API.
