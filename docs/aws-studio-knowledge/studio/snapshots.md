---
id: studio.snapshots
summary: Loopback server, mode-isolated evaluation, revisioned snapshots, watching, and browser synchronization.
read_when:
  - Debugging server startup, stale models, or snapshot refresh
source:
  - framework-studio/server/index.ts
  - framework-studio/server/server.ts
  - framework-studio/server/commands.ts
  - framework-studio/server/snapshot.ts
  - scripts/atomic-replace.cjs
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

The listener claims its port before acquiring Vite, source watchers or evaluator
processes. It returns 503 while initialization is pending. Port conflicts therefore
exit before creating those resources. Signal supervision is installed before
startup and remains registered while asynchronous cleanup runs. Partial startup
failures release every registered resource and the listener. Shutdown closes
incoming connections, stops watching and closes the builder's explicit
`EvaluatorLifetime`: snapshot, batch-review, route-review and resource-review
pools all belong to that owner, and live evaluators are released from its registry
on exit. Terminal builder disposal refuses new or already queued refreshes. Cleanup
joins startup and tracked refreshes, then drains any late acquisition; interrupted
startup never reports readiness. Local compute/storage started separately through Deploy & Run keeps
its existing ownership rules; closing Studio does not delete persistent volumes.
Evaluator disposal first disconnects IPC and sends SIGTERM, then escalates after
one second to SIGKILL against only that owned child if it has not exited. This also
bounds cleanup when authored code installs a signal handler and blocks its event
loop. The escalation timer is cleared on exit, and repeated disposal shares the
same completion.
The fixed generator/check commands in [commands.ts](../../../framework-studio/server/commands.ts)
also belong to this lifetime. Shutdown stops their supervised process tree and
waits for the active command to settle before exiting; a closed runner refuses
new commands and never advances to a later step. The existing tether also stops
those children if Studio is killed outright. Commands still use fixed argv without
a shell, and generation still requires explicit confirmation.

[guards.ts](../../../framework-studio/server/guards.ts) checks exact local Host/port, a random session token, same-origin POSTs and no-store caching; SSE carries the token in its query. Vite filesystem access is restricted. This is a trusted local tool executing repository code, not a remotely hosted multi-user service or hostile-code sandbox.

`SnapshotBuilder.refresh` in [snapshot.ts](../../../framework-studio/server/snapshot.ts) serializes/coalesces refreshes:

1. Hash editable files and read deployment settings.
2. `EvaluatorPool` loads dev and prod in separate forked module graphs. Synthetic inputs select mode; graph evaluation does not need resolved secret values. A narrow mode flag is read from the authored mode files. Forks inherit host trust/environment; do not describe them as secret-proof isolation.
3. `projectModel` normalizes/validates declarations into each `ModeModel`. A fresh availability resolver supplies canonical lane predicates for that projection. `withLambdaSpecs` in [lambda-spec.ts](../../../framework-studio/server/model/lambda-spec.ts) temporarily seeds build settings from one fresh batch; `finally` restores or removes that scope. Later projections re-read mutated settings. The ordinary evaluator treats loaded configuration as immutable (`applyPatch` copies).
4. [Source indexing](source-indexing.md) supplies locations, capabilities and CDK evidence. Prisma contract parsing, Compose metadata, client mappings, descriptions and input **metadata** enrich the snapshot.
5. Increment generation and combine it with a content hash for `revision`; atomically cache disposable CDK-link evidence under `.cache/framework-studio`.

Each mode also carries `interfaceEndpointServices`, copied from the framework's generated
CDK endpoint catalog by `projectModel`. The browser uses this list for the VPC service
picker without importing CDK or maintaining its own supported-service list. It describes
framework support, not live regional availability.

`lastGood` retains a previous nonempty graph after a new load failure, marks it stale/error and carries new diagnostics. It is display continuity, not permission to edit old source. Models are rebuilt, not incrementally patched node by node. A generation change may occur even for equal content.

If indexing or writing the disposable CDK-link projection fails after a successful
snapshot, `SnapshotBuilder` publishes a new revision retaining the previous source
and graphs as stale/error. It disposes the failed generation's evaluators and
provides a failed preflight with a safe error code and contained file path. Old
graphs cannot authorize edits after their evaluator processes have been replaced.
Resolve the filesystem/index failure and refresh to recover. An initial failure
without a previous snapshot still rejects. Atomic projection replacement retries
only transient Windows sharing errors; a permanent failure remains visible.

[watchRepository](../../../framework-studio/server/watch.ts) watches configuration, framework config implementation, CDK sources, Prisma contract, Compose and mode input/template files using directory watches and a debounce. Workload implementation roots (Lambda handlers, container contexts and agents) are also watched, excluding dependencies/build output. Source changes expire reviews and publish revision/status events. Native watch errors expose a persistent source-health notice and activate the same five-second content comparison used to detect missed events and newly created directories. Failed watches retry; recovery clears the notice. The notice includes paths/error codes and a read-only **Reload source** action. Environment contents never enter health events. A reconnect re-fetches the snapshot while preserving dirty drafts.

[main.tsx](../../../framework-studio/src/main.tsx) defines Board, Isometric, Database, Deploy, the nested Cognito workspace and Domains routes. [StudioProvider](../../../framework-studio/src/studio.tsx) owns shared selection/mode/draft context; [api.ts](../../../framework-studio/src/api.ts) fetches snapshots and subscribes to server events. Snapshot and Deploy observers share one reference-counted EventSource per tab through `src/events.ts`, preserving each observer's listeners during navigation and leaving HTTP/1 connections available for reads and approvals with several tabs open. Six or more simultaneous tab streams can still reach the browser's per-origin connection limit. Unknown API routes return JSON 404; an older server's HTML fallback is rejected as an invalid API response instead of appearing as empty successful data. Dirty drafts keep their baseline visible and record a newer snapshot as a conflict rather than silently rebasing; see [editing](editing.md).

An initial snapshot failure offers a connection retry. A failed background fetch with a
cached snapshot keeps `StudioProvider` mounted, preserving selection and unsaved drafts;
a persistent Shell notice offers retry. Successful retry removes the notice without
recreating the editor. This is separate from server-side stale-model diagnostics, which
continue to govern source editability.

During frontend hot replacement, the entry retains its React root, query cache and router
through Vite's per-module HMR data. Its exported root component remains a React Refresh
boundary, and replacement updates the retained router's route tree without remounting
the application or discarding its inspector draft. Removing the entry releases the root,
cache and browser history; ordinary replacement does not unmount them.

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

Validate with [model](../../../framework-studio/test/model.test.ts), [guards](../../../framework-studio/test/guards.test.ts), [draft](../../../framework-studio/test/draft.test.ts), [startup/recovery UI](../../../framework-studio/test/startup-ui.test.ts), [snapshot I/O recovery](../../../framework-studio/test/snapshot-recovery.test.ts), [creation](../../../framework-studio/test/creation.test.ts) and [watch failure/recovery](../../../framework-studio/test/watch.test.ts) tests. Browser reconnect/render behavior needs browser verification beyond snapshot tests.
