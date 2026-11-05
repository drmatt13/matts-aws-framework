---
id: studio.backend
summary: Studio backend service boundaries, source authorities, state ownership and API navigation.
read_when:
  - Tracing a Studio interaction into the backend
  - Extending a source writer or operational endpoint
source:
  - framework-studio/server/server.ts
  - framework-studio/server/machine/docker.ts
  - framework-studio/shared/machine.ts
  - framework-studio/server/guards.ts
  - framework-studio/server/deploy/observe.ts
  - framework-studio/server/deploy/service.ts
  - framework-studio/src/deploy/observations.tsx
  - framework-studio/src/deploy/live.ts
  - framework-studio/server/edits/batch.ts
  - framework-studio/server/edits/journal.ts
  - framework-studio/server/database-workbench.ts
  - framework-studio/server/operations/client.ts
  - framework-studio/server/operations/coordinator.ts
  - framework-studio/server/operations/worker.ts
  - framework-studio/server/operations/ipc.ts
  - framework-studio/shared/operations.ts
related:
  - studio.interface
  - studio.snapshots
  - studio.editing
  - deployment.planning-safety
---
# Backend services and authority boundaries

Studio is a local Node host serving React through Vite middleware. It executes trusted
repository configuration and may run explicitly requested local or AWS operations. Its
browser protections do not make arbitrary checked-out code safe to run, and it is not a
hosted multi-user administration service.

[server.ts](../../../framework-studio/server/server.ts) assembles services, guarded API
routes, server-sent events, Vite and the watcher. [index.ts](../../../framework-studio/server/index.ts)
finds the repository and chooses server mode or one-shot `--print`. The listener claims
loopback before expensive initialization; shutdown owns evaluators, watcher, Vite and
legacy fixed command children. Independent operation workers outlive this shutdown;
Studio closes only its runner client. See [snapshots](snapshots.md) for startup, reload
and disposal, and [operations](../deployment/operations.md) for runner lifecycle.

## Separate authorities

| Service / entry point | Owns | Does not establish |
| --- | --- | --- |
| `SnapshotBuilder`, `EvaluatorPool`, `projectModel` | Both normalized mode graphs, source revision, source evidence and metadata projections | Deployed resources, live health or secrecy against hostile authored code |
| `EditService`, `BatchEditor`, `ResourceService` | Typed source proposals, complete overlay validation and guarded writes | Arbitrary code editing or deployment approval |
| `DeploymentInputService` | Private values and reviewed edits to the two fixed CDK environment files | Secret upload, client export or complete infrastructure validation |
| `DatabaseWorkbenchService`, `DatabaseHistoryService` | Prisma source, semantic validation, history comparison and reviewed offline artifact installation | Application of migrations to a database |
| `DatabaseApplicationService`, `DatabaseCloudService`, SQL router | Separately targeted, reviewed database operations | Authority derived merely from editing Prisma or choosing a source mode |
| `InfrastructureService` | Explicit CDK synthesis and sanitized assembly inventory, with per-mode freshness | Deployment, live drift or AWS runtime health |
| `DeployService`, frontend-release and stateful-resource services | Named targets, plans, operation approvals, evidence and recovery/lifecycle workflows | Implicit authority from source Apply or a canvas selection |
| Operations coordinator and workers | Durable accepted intents, duplicate prevention, resource claims, independent execution/log capture and shared projection for supported adapters | New deployment authority, replay of uncertain mutations or approval for database/publication/identity actions |
| Identity and identity-policy services | Source-owned identity configuration, selected AWS observations and typed operation boundaries | A generic IAM policy simulator or proof that provider-side sign-in works |
| `AwsConnectionsService` | Machine-local profile catalog, identity observations, native authentication coordination, reviewed non-secret AWS configuration and profile deletion | Deployment approval, complete IAM authorization or browser access to credentials |
| `CommandRunner` | Fixed `framework:check` and confirmed `framework:generate` scripts | A request-controlled shell or the complete operations surface |
| `AgentLabService` | Bounded question answering through local CLIs, experimental demo planning and a separate guarded save of one demo string declaration | Live source/graph/log inspection, arbitrary agent-authored code execution or general framework editing |

Each authority has its own typed request and checks. The generic configuration writer
allows existing `framework.config.ts` and `framework-config/**/*.ts` by real path,
without symlinks. Creation, generated projections, starter implementations, selected native
trigger removal, identity policy, Prisma and private input edits have narrower dedicated
validators. Do not broaden the generic allowlist to accommodate a new workflow.

## Request and state flow

The browser fetches `/api/snapshot` and subscribes to `/api/events`. A snapshot contains
both mode models and source locations, not live AWS state. One reference-counted
EventSource per tab serves snapshot, operation and deployment observers. Reconnect invalidates
queries; source changes expire reviews. Dirty drafts keep their own snapshot baseline.

One persistent browser deployment observer reads overview/profile metadata and one
mode-correct deployment target per configured association on every route. Shared Query
entries own its responses/errors; pages subscribe without adding requests or polling.
The existing status batch contains discovery, recent events/change-set summaries and
Development compatibility; it avoids a separate equivalent discovery request. This is
read-only evidence, separate from specialized inspection and mutation approval.

`AwsObserver` shares pending command reads independently of their completed-cache TTL.
Freshness starts at completion. A forced read bypasses a completed entry but joins a
pending request in the same profile/configuration generation. Profile/all invalidation
removes old entries so new reads cannot join an earlier generation; late completion can
only finish the original request. Failed observations are not cached. Source publication
invalidates source-dependent observations, and terminal operations invalidate the host
cache before broadcasting completion. Browser query identities and scoped invalidation
preserve the same destination/credential boundaries. See
[AWS connections](../../framework-studio/aws-connections.md#shared-deployment-observations)
for scheduling, failure and reconnect policy.

Shared operation requests pass from guarded Studio HTTP routes through
[`OperationsClient`](../../../framework-studio/server/operations/client.ts) and
[private Unix-socket IPC](../../../framework-studio/server/operations/ipc.ts) to a
separate host coordinator. The coordinator commits acceptance before acknowledgement;
workers reconstruct allowlisted adapters rather than executing request-supplied commands.
Worker-owned SQLite log writes continue without Studio. The API combines these records
with legacy jobs for Activity; execution and domain outcome are separate fields.

An Inspector review sends typed intent and its source revision. The server locates
the authored syntax, composes candidate text in memory, validates the complete overlay
in fresh mode evaluators and performs operation-specific type/graph checks. Apply accepts
the server-owned plan ID, rechecks files and revision, writes, reloads and verifies the
predicted result. The browser does not supply arbitrary configuration text to the generic
writer. The Prisma editor is a distinct fixed-file text authority.

Batch/resource multi-file writes use `SourceJournal` and an exclusive checkout lock.
The private write-ahead record supports explicit interrupted-write recovery. A multi-file
apply is not a crash-atomic filesystem transaction; rollback restores only bytes still
matching the transaction's writes and preserves intervening edits. In-memory reviews are
lost on restart. Git remains the history mechanism.

## API navigation

These are service families, not a frozen exhaustive endpoint specification. Consult the
mounted router and `src/*-api.ts` transport before extending a request.
All prefixes in this table are relative to `/api`.

| Prefix | Main actions / source owner |
| --- | --- |
| `/snapshot`, `/events` | Source read/refresh and live notifications in `server/server.ts` |
| `/edits`, `/routes`, `/resources` | Review/apply typed fields, batches, routes and catalog resources |
| `/deployment-inputs` | Fixed-file metadata/value reads, creation from template, private review/apply |
| `/source-recovery` | Read recovery records; typed restore or keep-current after validation |
| `/infrastructure` | Read inventory; explicit `/synthesize` |
| `/database/workbench`, `/database/history` | Source validation/format/review/save; history compare/plan/install/discard |
| `/database/application`, `/database/cloud`, `/database/sql` | Separate target review/application and SQL operations |
| `/machine/docker` | Shared host Docker/Compose observation and timestamp, without AWS discovery; one in-flight probe/cache feeds readiness and Docker-dependent operations |
| `/deploy` | `server/deploy/routes.ts`: target discovery, plans, approvals, operations and local runtime |
| `/operations` | `server/server.ts`: shared operation list/submission, `/:id/log?after=<seq>` replay and `/:id/cancel`; adapter-specific approval stays with its owning workspace |
| `/aws-connections` | `server/aws-connections`: catalog, protected connection checks, ephemeral authentication, configuration, deletion and logout reviews |
| `/frontend-release` | `server/frontend-release-routes.ts`: frontend release and add-a-deployment-stage workflows |
| `/app-name` | `server/app-name-routes.ts`: the app's name and id (`framework:app`, `framework:appId`): read, review (read-only AWS discovery by app id and stage decides which production stages keep their deployed name), `/deploy-as/review` (keep one stage's deployed name, from Deploy) and hash-guarded apply to `cdk-app/cdk.json`; source edits, not AWS operations |
| `/identity`, `/identity-policy` | `server/identity/routes.ts`, `server/identity-policy.ts`: identity/domain evidence and source/operation workflows |
| `/stateful-resources` | `server/stateful-resources.ts`: lifecycle inventory, reviews and operations |
| `/websockets/defaults` | Starting endpoint URLs; not a proxy for WebSocket traffic |
| `/commands/:name` | Fixed allowlisted commands with bounded output and runtime |
| `/agent-lab` | `/status` checks native CLI login; `/models?provider=codex\|claude` discovers the CLI's model choices without inference; `/chat` answers a bounded conversation with optional validated model selection, fixed product context and cancellation on disconnect; `/plan` and `/apply` retain the fixed demo edit experiment. See [local coding agents](../../framework-studio/local-agent-lab.md) |

Unknown API routes return JSON 404. There are no `/edits/undo` or `/edits/redo` routes.
The generic mutation protocol version is checked separately from authentication; a stale
frontend receives a restart/reload error instead of issuing incompatible mutations.

## Trust and failure behavior

The server binds `127.0.0.1`, accepts only exact loopback Host/port values, and requires a
per-process token on every API request. SSE uses the token in its query; other calls use
`x-studio-token`. Non-GET requests also require the exact origin and current
`x-studio-protocol`. Responses are no-store; Vite filesystem serving is restricted.

Runner IPC is separately restricted by current-user ownership and private directory/socket
permissions, with protocol-version checks and no network listener. Its allowlisted
deployment adapter retains CLI review checks and private credential handling. Process
identity includes user and start-time evidence; an uncertain or unreadable execution
record is preserved rather than automatically reclaimed. The runner is local macOS/Linux
infrastructure, separate from application Compose and its stop/cleanup lifecycle.

Evaluator children receive synthetic mode inputs and condition outcomes rather than
authored environment-file values. They still inherit the host process environment and
execute repository code with filesystem access. Public `resource.value` values and
declared defaults are ordinary source metadata and may appear in snapshots. Private
environment values are handled by the dedicated service, not the graph or source journal.

Failure classes remain distinct: stale source refuses review/apply; invalid declaration
syntax keeps a labeled previous graph; synthesis failure retains labeled last-good
inventory; interrupted writes expose recovery; failed or unknown operations require
their service's reconciliation. Never convert any of these states into a green runtime
health assertion. See [deployment safety](../deployment/planning-and-safety.md) for
target verification, approvals and cloud operation recovery.
