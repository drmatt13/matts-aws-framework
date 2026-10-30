---
id: studio.editing
summary: Canonical draft, review, AST transformation, guarded apply, rollback contract.
read_when:
  - Changing Inspector fields or source-writing behavior
  - Debugging stale review, conflict, apply, or rollback
source:
  - framework-studio/src/draft.ts
  - framework-studio/src/views/ResourceEditor.tsx
  - framework-studio/shared/creation.ts
  - framework-studio/shared/resources.ts
  - framework-studio/server/resources.ts
  - framework-studio/server/resources-source.ts
  - framework-studio/src/views/Deployment.tsx
  - framework-studio/src/views/ManagedDatabaseInspector.tsx
  - framework-studio/src/views/DatabasePlacement.tsx
  - framework-studio/server/edits/transaction.ts
  - framework-studio/server/edits/batch.ts
  - framework-studio/server/edits/database.ts
  - framework-studio/server/edits/plan.ts
  - framework-studio/server/edits/splice.ts
  - framework-studio/server/edits/io.ts
  - framework-studio/server/edits/journal.ts
  - framework-studio/src/database-session.ts
  - framework-studio/server/database-workbench.ts
  - framework-studio/server/database-history.ts
  - framework-studio/server/database-application.ts
related:
  - studio.source-indexing
  - studio.snapshots
  - studio.creation-connections
---
# Inspector drafts and source transactions

Every workload role exposes Deploy, including event Lambdas and agent tools. The same
bounded token/condition source writer validates both graphs, applies and restores exact
bytes. Tool Inherit follows consuming agents; explicit overrides still satisfy invocation
edges. Event changes also control native AWS trigger attachment on the next deployment.
Catalog entries, stack members, gateway infrastructure, databases, network fixtures and
islands show their deployment owner and navigation to owner controls instead of a second
independent flag. Environment mappings explain that files supply inputs rather than deploy.

Inputs distinguish a public **Source parameter** from an **Environment parameter** through
**Link to .env file** in creation and the Inspector. `resource.value(...)` stores a non-secret
value directly in source, with per-mode values supported; it has no `fromEnv`, fallback,
local-value read or catalog-derived environment-file row. A linked input reads its variable and may declare
an optional `.default(...)`. Switching sources carries the Value/Default form text through
the normal reviewed source writer, without reading, moving or rewriting `.env` values.
Secret inputs always remain environment-linked and never accept a source value or default.
The `enableWebSocketApi` example uses a source value of `true` rather than a file override.

Source projection includes public `authoredValue` and mode `value` metadata, while resolved
environment-file values stay out of snapshots and symbolic client previews. New client
input recipes use canonical catalog IDs; legacy variable-name aliases remain readable.
Changing a link or group reviews affected recipe references with the declaration.

Tags use a typed `tags` draft operation for the owning declaration, including all aliases
of shared compute. `server/edits/tags.ts` plans narrow literal changes and
`server/source/tags.ts` supplies conservative editability. Tag changes participate in
normal both-mode review, per-file diffs, stale hashes, refreshed-model validation, guarded
guarded rollback. Stack member overrides are distinct from effective inherited tags;
removal restores inheritance. See [tag authoring](../../framework-studio/declarations-and-tags.md).
The tag Inspector uses labeled key/value inputs, an Add tag action that focuses the new
key, and visible Delete buttons. Validation is associated with its fields; deleting a
row returns keyboard focus to a remaining key or Add tag. Route ownership help stays
inside the Tags disclosure. Its compact heading retains the effective count and any
Modified/Needs attention draft state while collapsed. Registry-backed boolean fields
dispatch through `FieldRow` to the shared switch, including build options and defaults.
An open page with missing tag editability offers
Refresh editor, which reloads its snapshot without writing source; an expired server
session reconnects through a page reload. Refresh is disabled while a draft is dirty.

This is the canonical graph-to-source contract. Creators, trigger editors and resource tools reuse it; they do not gain arbitrary file-writing authority.

Prisma has a separate fixed authority rather than extending the TypeScript configuration
writer. `DatabaseSession` in [database-session.ts](../../../framework-studio/src/database-session.ts)
owns draft text, exact request generations, external-source conflicts and last-valid diagram
identity. CodeMirror retains selection/undo through validation, formatting and explicit
discard; source review remains required before saving. The actual configured Prisma 8
interpreter owns semantic diagnostics. Syntax/local-name suggestions do not promise a
compatible language server or safe rename.

`DatabaseWorkbenchService` in
[database-workbench.ts](../../../framework-studio/server/database-workbench.ts) reviews,
revalidates and hash-guards writes only to `packages/database/prisma/contract.prisma`.
Source success is reported separately from snapshot-refresh failure. It neither generates
artifacts nor applies storage. `DatabaseHistoryService` in
[database-history.ts](../../../framework-studio/server/database-history.ts) runs pinned
Prisma emission/planning in a disposable copy, exposes actual artifact bytes, then installs
only reviewed new files after source/config/history checks, including the bounded imported
configuration helpers used by source validation and copied into offline planning. Existing migration packages
remain immutable; history browsing never executes them. `DatabaseApplicationService` in
[database-application.ts](../../../framework-studio/server/database-application.ts) owns
the separate local target review, typed approval, input/path revalidation and canonical
runner. Empty local initialization has its own metadata-only emptiness check, SQL review and
typed authorization; populated unknown storage remains blocked. Redacted database operation
records survive restart and never replay writes. Database effects and follow-up inspection
failures remain separate. `DatabaseCloudService` and the versioned VPC task add production
inspection/application: read-only metadata preparation pins a named destination and stack-owned
task revision and full launch/log descriptor, showing actual public-IP/subnet/security-group placement (database stays private/IAM), then typed billed inspection returns SQL/source for a separately typed write
approval. Old write-only tasks fail before launch. Full marker/ledger and strict historical
storage checks run under the canonical runner's transaction lock before DDL. Durable task ARN,
request token and CloudWatch evidence survive restart without automatic write retries. Local and production empty initialization share a full-native-operation/SQL-parameter review and under-transaction empty metadata proof; production requires its distinct typed Initialize approval. Populated/partial unknown storage is never adopted or reset. See the
[Database workbench guide](../../framework-studio/database-workbench.md) for precise actions,
evidence and capability limits.

`InspectorDraft` in [draft.ts](../../../framework-studio/src/draft.ts) owns baseline/latest snapshots, staged entries, validation, review and navigation protection. While dirty, the visible graph stays on the baseline. A different snapshot revision marks conflict; it does not auto-merge. Invalid/conflicting drafts cannot apply. An explicit Review against latest source preserves ordinary typed entries and requests a fresh proposal; protected resource/input forms require their own reload. `StudioProvider` in [studio.tsx](../../../framework-studio/src/studio.tsx) connects this lifecycle across routes and browser exit. Drafts remain in memory; interrupted source writes have a separate durable journal.

During apply, draft setters and discard are inert until the server responds, preserving
the accepted review payload. Network creation/settings and workload placement controls
use the same busy, evaluating, stale and conflict gates as the other Inspectors.

Inspector settings consume `FieldFact` inheritance and source editability. `FIELDS`, `DEFAULT_FIELDS`, `fieldFacts` and `fieldById` in [edits/fields.ts](../../../framework-studio/server/edits/fields.ts) define recognized fields, domains, parsers, source paths and defaults. Add a field through this shared contract rather than a UI-only input. Effective inherited values and authored overrides must remain distinct; removal restores inheritance. Some boolean fields support true/absence rather than explicit false.

Boolean settings reuse `InspectorSwitch` in `InspectorUI.tsx`, including VPC/database
policies and creation forms; toggling stages the owning draft and never applies source.
VPC inspectors contain only network settings and membership, not global workload defaults.
`SharedDefaults.tsx` presents family defaults in their related inspectors; database caller
pool defaults live in Application PostgreSQL's Connection pool defaults and still edit `defaults.database`,
independently of the server policy declaration. See the
[inspector conventions](../../framework-studio/inspector-design.md).

`InterfaceEndpointPicker.tsx` replaces comma entry in VPC editing and creation with
searchable service icons and removable selections. It stages exact endpoint IDs through
the existing network/create drafts. `ModeModel.interfaceEndpointServices` is projected
directly from `INTERFACE_ENDPOINT_SERVICES`, the framework's generated CDK catalog;
`src/endpoint-services.ts` supplies only labels and local artwork. Gateway endpoints keep
their separate controls. An unavailable catalog offers a server restart instruction and
preserves authored selections. The catalog does not verify regional service availability.

The shared [Deployment section](../../../framework-studio/src/views/Deployment.tsx) places the same Dev/Prod cards and scope field on workloads and routes. Route edits target the owning workload. Token previews use framework-projected `deployChoices`; conditional Deploy uses a typed batch operation and the existing resource import alias. The evaluator sends condition metadata to the parent; only holds/fails/unset outcomes return over IPC. Each environment resolves privately against its own inputs. Saved conditions show both outcomes; review resolves drafts, and selectors count as consumers for catalog rename/delete safety. Catalog/local-service inspectors reuse the cards, with managed ownership explained instead of inventing a deploy field. Catalog availability is not evidence of deployed infrastructure. See the [inspector conventions](../../framework-studio/inspector-design.md).

```mermaid
flowchart LR
  A[Stage draft] --> B[Plan source overlays]
  B --> C[Validate both modes + relevant TS checks]
  C --> D[Review per-file diffs / impact]
  D --> E[Recheck revision / hashes / authority]
  E --> F[Write files / rebuild snapshot / compare]
  F --> G[Confirm source or guarded restoration]
```

`EditService` in [transaction.ts](../../../framework-studio/server/edits/transaction.ts) serializes its operations and keeps expiring plans. `BatchEditor` in [batch.ts](../../../framework-studio/server/edits/batch.ts) composes field, route, trigger, failure destination, replay wrapper, description, mapping and creation changes into source overrides. Resource and environment details have specialized services with their own validation/private data; see [secrets](../deployment/secrets.md).

Batch review rejects unchanged source before expensive work. Applicable framework
artifacts are generated in the existing disposable copy, then the complete candidate
is evaluated in fresh dev/prod processes once, with the relevant TypeScript checks.
Generator errors still block otherwise valid intent; rejected intent retains normal
both-mode diagnostics. Binding comparisons exclude only snapshot display evidence,
so source excerpts/locations do not cause unrelated candidate type-checks. Grant
scope, permission, destination and invocation changes remain validation dependencies.
The final review rechecks all captured generator-input hashes after validation.
Apply repeats validation and confirms actual written models; no review result is
reused across source changes. See the [performance evidence and replay procedure](../../framework-studio/job4-performance-2026-10-23.md).

`planEdit` in [plan.ts](../../../framework-studio/server/edits/plan.ts) uses [source locations](source-indexing.md), narrow parsing and semantic patches; the shared diff engine preserves interior unchanged runs and emits contextual hunks. [splice.ts](../../../framework-studio/server/edits/splice.ts) replaces/inserts/removes supported literal ranges while preserving surrounding source/quotes. It refuses unsafe computed shapes/comments instead of reprinting entire files.

Comment protection belongs in the shared source operations: inserting the first property
into a commented empty object is refused, and `setProperty` refuses replacing a literal
whose range contains comments. Editors may change a neighboring literal while preserving
comments outside that range. Do not add editor-specific fallbacks that discard this prose.
VPC settings use the registered declaration's source span, including official import
aliases and modules containing multiple declarations; a helper's spelling or file layout
does not identify the declaration to edit.

Plans capture revision and file hashes; both fresh mode evaluations must pass. Canonical source resolution and artifact validation check configured directories, handlers and Dockerfiles against proposed files. Missing implementation is projected independently from declaration validity so repair remains available. Type-aware connection/creation/repair changes use TypeScript checks. Normal Inspector edits preserve target/construct identity. Creation permits expected additions and explicit removal permits only the selected removed identity. Projection-affecting edits, including the legacy route/deployment APIs, run real generation in a private copy and include changed/generated/deleted outputs in review. Generator input hashes include existing implementations, contracts and Dockerfiles even when no output changes. Review approval saves authored/generated source; it does not synthesize or deploy infrastructure.

Apply checks source before and after preflight, then checks each write's expected contents. `writeSourceChange` in [io.ts](../../../framework-studio/server/edits/io.ts) distinguishes absent files (`null`) from empty files, creates through an exclusive link, and replaces existing files by temporary-file rename. After refresh, the batch compares relevant actual identities/settings/routes/triggers/creation relationships with the reviewed model.

**Multi-file apply is not a crash-atomic filesystem transaction.** On caught failure it restores written files in reverse only while they still equal its own written contents. Concurrent edits are preserved and can produce `unconfirmed`; inspect those files. Saved-source history belongs to Git. Source-edit undo/redo APIs and in-memory history are removed. Server restart loses in-memory reviews. [journal.ts](../../../framework-studio/server/edits/journal.ts) writes a private fsynced write-ahead source record before batch/resource multi-file writes. An exclusive checkout lock spans writes and post-write verification; competing Studio processes cannot begin another journaled transaction. Begin never reclaims a stale lock. Restart exposes dead-owner records (including a lock acquired before journaling) through Source recovery. Typed Restore source restores matching bytes and preserves later edits; typed Keep current source completes recovery only after current-source revalidation and a fingerprint check. A separate exclusive recovery lock serializes explicit recovery. A shared active registry excludes in-flight transactions across service instances and rejects recovery against them. Record/root/path/symlink validation applies on reads as well as writes. Corrupt metadata or an interrupted recovery lock requires explicit inspection while snapshots remain inspectable and source writes remain blocked. Environment values and database operations have separate service boundaries. Revision/hash checks do not eliminate every external-editor race between a check and rename; editors outside Studio do not honor its lock.

The single-edit API and resource editor follow the same expected-contents write guard during recovery.

`DatabaseSqlService` in
[database-sql.ts](../../../framework-studio/server/database-sql.ts) owns a separate
fixed source authority under `packages/database/sql/`. A `.sql` file contains versioned
metadata and one parameterized statement. Hash-guarded review/save does not contact
storage. A separate expiring, single-use execution review binds saved bytes, positional
values and private loopback target identity; production is refused rather than bypassing
its IAM/TLS task. Inspection is a PostgreSQL read-only transaction; writes require
acknowledged COMMIT and once-only intent uses a database-side ledger in that transaction.
Redacted fsynced history records uncertain outcomes without replay. The service reuses
private target resolution, the database operation lock and the installed PostgreSQL
driver, never a second connection configuration or startup runner. `DataRetention.tsx`
reuses the protected environment-input service for mode-specific
`RETAIN_STATEFUL_RESOURCES`; saving it is distinct from deploying protection, teardown
and actual recovery.
Journal records retain per-file authority: recognized native CDK edits first pass the
linked-stack ownership check and record a bounded native source entry; generated/new
files retain creator authority. A mixed native/source/generated transaction can recover
without broadening the normal configuration writer or accepting HTTP-selected paths.
`identityPolicy` batches edit only the recognized linked native stack's literal
`identityPoolAccess` options. ReaderRole Allow/Deny statements replace convenience
bucket settings; default/guest roles stay permissionless and guest issuance is an
explicit opt-in. Stack/helper/validator hashes expire reviews. Custom shapes and
authored comments refuse replacement. The separate read-only IAM simulator uses
saved statements and an STS-pinned account; it rechecks all three source authorities
after the asynchronous request and does not prove credential claims, boundaries,
SCPs, resource policies or runtime access. See the
[identity guide](../../framework-studio/identity-and-domains.md#identity-pools).
Post-write snapshot exceptions and stale/error models trigger restoration, never a
successful edit response. An external edit or deletion remains untouched and yields
`unconfirmed`. If refresh still fails after recovery, the response distinguishes restored
source from an unavailable snapshot and asks the user to refresh after resolving it.
`SourceJournal.begin` acquires its exclusive checkout lock before inspecting pending
records. A competing writer is refused even while the owner is initializing lock
metadata; it cannot misread that live lock as a corrupt record. Pending records
still block new writes, and a refused attempt releases only its own token. Incomplete
or abandoned locks remain explicit inspection/recovery work. See the deterministic
[lock race tests](../../../framework-studio/test/source-lock-race.test.ts).
Resource rollback attempts every written file even when one was externally deleted or
cannot be restored, reports `unconfirmed` and preserves later edits.

Use [extensions](../guides/extensions.md) for new fields. Tests: [plan](../../../framework-studio/test/plan.test.ts), [splice](../../../framework-studio/test/splice.test.ts), [transaction](../../../framework-studio/test/transaction.test.ts), [draft](../../../framework-studio/test/draft.test.ts), [draft UI](../../../framework-studio/test/draft-ui.test.ts), and feature-specific creation/trigger/resource suites. Assert refusal causes zero writes and rollback preserves unrelated changes.

Typed VPC removal and managed database settings reuse this batch journal, including
post-apply semantic checks, guarded guarded rollback. VPC removal rescans source
consumers immediately before writing. `ManagedDatabaseInspector.tsx` joins local PostgreSQL
and production RDS, showing independent data, connection paths, the VPC home and consumers.
Policy edits target literal settings. A separate typed `databasePlacement` operation
coordinates the database declaration and the union of normalized database consumers in
both modes, preserving each workload's subnet tier and bindings. `DatabasePlacement.tsx`
offers only registered VPCs and private/isolated subnets; the owning VPC is required.
Computed declarations and competing consumer placement edits are refused. Actual placement
is checked after apply; mismatch uses guarded rollback.
This edits source only: deployed RDS moves need migration/cutover planning and separately
authorized deployment. Identity and native CDK source remain source-owned. See
[placement and parity](../../framework-studio/network-database-declarations.md).
The [database placement suite](../../../framework-studio/test/database-placement.test.ts)
covers coordinated consumers, policy composition, unsafe-source refusal, post-write rollback
and guarded rollback without touching a live database.
The
[HTTP response helper](../../../framework-studio/server/http.ts) catches synchronous
validation as well as rejected planning promises. A shared browser/server protocol blocks
incompatible edits with an explicit restart instruction; a Vite refresh does not reload
the running server API.

Local readiness uses the valid development snapshot to recognize service launchers
that exit zero because Deploy is disabled. Their container row says Disabled by Deploy;
nonzero exits and unhealthy active services still block startup.
