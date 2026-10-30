---
id: studio.backend
summary: Studio backend service boundaries, source authorities, state ownership and API navigation.
read_when:
  - Tracing a Studio interaction into the backend
  - Extending a source writer or operational endpoint
source:
  - framework-studio/server/server.ts
  - framework-studio/server/guards.ts
  - framework-studio/server/edits/batch.ts
  - framework-studio/server/edits/journal.ts
  - framework-studio/server/database-workbench.ts
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
fixed command children. See [snapshots](snapshots.md) for startup, reload and disposal.

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
| Identity and identity-policy services | Source-owned identity configuration, selected AWS observations and typed operation boundaries | A generic IAM policy simulator or proof that provider-side sign-in works |
| `CommandRunner` | Fixed `framework:check` and confirmed `framework:generate` scripts | A request-controlled shell or the complete operations surface |

Each authority has its own typed request and checks. The generic configuration writer
allows existing `framework.config.ts` and `framework-config/**/*.ts` by real path,
without symlinks. Creation, generated projections, starter implementations, selected native
trigger removal, identity policy, Prisma and private input edits have narrower dedicated
validators. Do not broaden the generic allowlist to accommodate a new workflow.

## Request and state flow

The browser fetches `/api/snapshot` and subscribes to `/api/events`. A snapshot contains
both mode models and source locations, not live AWS state. One reference-counted
EventSource per tab serves snapshot and deployment observers. Reconnect invalidates
queries; source changes expire reviews. Dirty drafts keep their own snapshot baseline.

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
| `/deploy` | `server/deploy/routes.ts`: target discovery, plans, approvals, operations and local runtime |
| `/frontend-release` | `server/frontend-release-routes.ts`: frontend release and deployment identity workflows |
| `/identity`, `/identity-policy` | `server/identity/routes.ts`, `server/identity-policy.ts`: identity/domain evidence and source/operation workflows |
| `/stateful-resources` | `server/stateful-resources.ts`: lifecycle inventory, reviews and operations |
| `/websockets/defaults` | Starting endpoint URLs; not a proxy for WebSocket traffic |
| `/commands/:name` | Fixed allowlisted commands with bounded output and runtime |

Unknown API routes return JSON 404. There are no `/edits/undo` or `/edits/redo` routes.
The generic mutation protocol version is checked separately from authentication; a stale
frontend receives a restart/reload error instead of issuing incompatible mutations.

## Trust and failure behavior

The server binds `127.0.0.1`, accepts only exact loopback Host/port values, and requires a
per-process token on every API request. SSE uses the token in its query; other calls use
`x-studio-token`. Non-GET requests also require the exact origin and current
`x-studio-protocol`. Responses are no-store; Vite filesystem serving is restricted.

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
