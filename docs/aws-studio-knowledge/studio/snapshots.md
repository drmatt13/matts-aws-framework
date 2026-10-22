---
id: studio.snapshots
summary: Loopback server, mode-isolated evaluation, revisioned snapshots, watching, and browser synchronization.
read_when:
  - Debugging server startup, stale models, or snapshot refresh
source:
  - framework-studio/server/index.ts
  - framework-studio/server/server.ts
  - framework-studio/server/snapshot.ts
  - framework-studio/server/evaluator/pool.ts
  - framework-studio/server/evaluator/evaluate.ts
  - framework-studio/server/watch.ts
  - framework-studio/src/database-session.ts
  - framework-studio/server/database-history.ts
related:
  - studio.source-indexing
  - studio.graph-model
  - studio.editing
---
# Source to snapshot to browser

`main` in [server/index.ts](../../../framework-studio/server/index.ts) discovers the checkout using `findRepositoryRoot` in [inputs.ts](../../../framework-studio/server/inputs.ts), then prints a snapshot (`--print`) or calls `startServer`. [server.ts](../../../framework-studio/server/server.ts) binds loopback (default port 4590), builds services/routes, starts watching and serves the Vite frontend.

[guards.ts](../../../framework-studio/server/guards.ts) checks exact local Host/port, a random session token, same-origin POSTs and no-store caching; SSE carries the token in its query. Vite filesystem access is restricted. This is a trusted local tool executing repository code, not a remotely hosted multi-user service or hostile-code sandbox.

`SnapshotBuilder.refresh` in [snapshot.ts](../../../framework-studio/server/snapshot.ts) serializes/coalesces refreshes:

1. Hash editable files and read deployment settings.
2. `EvaluatorPool` loads dev and prod in separate forked module graphs. Synthetic inputs select mode; graph evaluation does not need resolved secret values. A narrow mode flag is read from the authored mode files. Forks inherit host trust/environment; do not describe them as secret-proof isolation.
3. `projectModel` normalizes/validates declarations into each `ModeModel`. `lambdaSpec` in [lambda-spec.ts](../../../framework-studio/server/model/lambda-spec.ts) asks `resolveLambdaTarget` once per Lambda per evaluated config; Studio never mutates an evaluated config (`applyPatch` copies).
4. [Source indexing](source-indexing.md) supplies locations, capabilities and CDK evidence. Prisma contract parsing, Compose metadata, client mappings, descriptions and input **metadata** enrich the snapshot.
5. Increment generation and combine it with a content hash for `revision`; atomically cache disposable CDK-link evidence under `.cache/framework-studio`.

Each mode also carries `interfaceEndpointServices`, copied from the framework's generated
CDK endpoint catalog by `projectModel`. The browser uses this list for the VPC service
picker without importing CDK or maintaining its own supported-service list. It describes
framework support, not live regional availability.

`lastGood` retains a previous nonempty graph after a new load failure, marks it stale/error and carries new diagnostics. It is display continuity, not permission to edit old source. Models are rebuilt, not incrementally patched node by node. A generation change may occur even for equal content.

[watchRepository](../../../framework-studio/server/watch.ts) watches configuration, framework config implementation, CDK sources, Prisma contract, Compose and mode input/template files using directory watches and a debounce. It does not watch every handler/application source. Source changes expire reviews and publish revision/status events. Watch errors are currently swallowed; a missing refresh can require manual diagnosis/restart.

[main.tsx](../../../framework-studio/src/main.tsx) defines Board, Isometric, Database and Deploy routes. [StudioProvider](../../../framework-studio/src/studio.tsx) owns shared selection/mode/draft context; [api.ts](../../../framework-studio/src/api.ts) fetches snapshots and subscribes to server events. Dirty drafts keep their baseline visible and record a newer snapshot as a conflict rather than silently rebasing; see [editing](editing.md).

An initial snapshot failure offers a connection retry. A failed background fetch with a
cached snapshot keeps `StudioProvider` mounted, preserving selection and unsaved drafts;
a persistent Shell notice offers retry. Successful retry removes the notice without
recreating the editor. This is separate from server-side stale-model diagnostics, which
continue to govern source editability.

Disposable source previews travel through evaluator IPC. [evaluate.ts](../../../framework-studio/server/evaluator/evaluate.ts) resolves proposed new TypeScript modules and replaces compilation from an override map without writing preview files. Evaluation still runs authored config; it does not synthesize CDK or run handlers.

Database editing is an independent exact-text session in
[database-session.ts](../../../framework-studio/src/database-session.ts). A framework
generation does not replace dirty Prisma text. The baseline uses the authored file's hash;
validation responses also carry that draft's source hash and request generation. Invalid
drafts retain a labeled last-valid diagram, while semantic errors stay distinct from
unsupported diagram projections. Compilation caches source plus an opaque per-server
config identity that covers imported local modules, relevant manifests and private inputs,
and validates through installed Prisma without publishing generated files. Config changes
invalidate same-text validation and diagrams; framework generations also expire/reload
history comparisons, preserving dirty source.

`DatabaseWorkbench.emitted` is a separate metadata-only observation of the generated JSON
named by the actual Prisma config. The configured serializer and canonical storage/execution
hashes verify its integrity on loading before saved-source comparison. Only status, safe
file label, content revision, semantic hashes and time reach the browser; raw generated
contracts and private config inputs do not. Missing/invalid/outside-checkout output stays
explicitly unknown or unavailable. No file is emitted, and matching JSON does not prove
generated TypeScript or downstream application consumers are current.

Migration/config changes are watched independently and notify database views. History in
[database-history.ts](../../../framework-studio/server/database-history.ts) hashes all
migration/snapshot/ref bytes, Prisma config and relevant manifests/lockfile, and refuses a
graph that changes during discovery. Comparisons and offline planning recheck source and
history before returning. Artifact reviews are in memory and expire; generated artifacts
from a disposable plan are installed only after explicit review and unchanged-input checks.
Observations include target connection-identity hashes, saved-source/history revisions,
baseline and freshness. Changing any relevant identity expires old evidence; a marker
match never substitutes for physical-schema verification. See the
[Database workbench guide](../../framework-studio/database-workbench.md).

Validate with [model](../../../framework-studio/test/model.test.ts), [guards](../../../framework-studio/test/guards.test.ts), [draft](../../../framework-studio/test/draft.test.ts), [startup/recovery UI](../../../framework-studio/test/startup-ui.test.ts) and [creation](../../../framework-studio/test/creation.test.ts) tests. Browser reconnect/render behavior needs browser verification beyond snapshot tests.
