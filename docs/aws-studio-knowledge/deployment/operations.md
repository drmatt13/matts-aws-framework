---
id: deployment.operations
summary: Studio jobs, fixed commands, CloudFormation observation, synth inventory, local logs and teardown.
read_when:
  - Changing Deploy UI operations or debugging job/status/log behavior
source:
  - framework-studio/server/deploy/service.ts
  - framework-studio/server/deploy/registry.ts
  - framework-studio/server/deploy/jobs.ts
  - framework-studio/server/deploy/observe.ts
  - framework-studio/server/deploy/stack-inspection.ts
  - framework-studio/shared/stack-inspection.ts
  - framework-studio/src/deploy/stack-inspection.ts
  - framework-studio/src/views/deploy/StackInspector.tsx
  - framework-studio/server/deploy/local.ts
  - framework-studio/src/deploy/local-runtime.ts
  - framework-studio/shared/operations.ts
  - framework-studio/server/operations/coordinator.ts
  - framework-studio/server/operations/worker.ts
  - framework-studio/server/operations/store.ts
  - framework-studio/server/operations/adapter.ts
  - framework-studio/server/operations/client.ts
  - framework-studio/server/operations/summaries.ts
  - framework-studio/src/operations/live.ts
  - framework-studio/server/infrastructure.ts
  - scripts/deployment-status.ts
  - scripts/destroy.ts
related:
  - deployment.lifecycle
  - deployment.planning-safety
  - deployment.environments
  - runtime.local-execution
---
# Deployment jobs and operational evidence

Start with the [operational lifecycle](lifecycle.md) for the complete source-to-runtime
flow and the separate database, identity and frontend effect boundaries. This page owns
Studio's jobs, observation and local process supervision.

Deploy uses a plain document header and the shared content column in loaded, loading and empty/error
states. It shows machine checks on the right of the deployment heading, with local issues
and remedies before passed checks. On narrow screens the group wraps below the name. The page
shows a loading skeleton in the reserved account/region line during the first profile read;
expired or missing credentials replace
it with a red **AWS sign-in required** link that opens profile configuration. Login failures
do not add a separate action button or findings card. Narrow layouts keep machine readiness
on its own row so target-name length does not change the header height. The page
has no subnav bar, deployment rail, Repository/AWS cards, stage-creation form or separate
template-comparison/change-set controls. **Synthesize** saves a prepared assembly and
template review. It is the header's only deployment action. The current plan card owns
**Review plan** and **Discard**; the deployment action is inside the review. The newest
completed plan generation decides what is current for its exact destination, including
an applied generation. Applying it leaves older proposals in **Earlier plans** rather
than promoting one back to current. Older reviews are retained without automatic deletion.
Synthesis never applies a plan; deployment requires
explicit confirmation inside its review.
The **Deployed · N stacks** card expands to show the observed destination and stack
statuses. **Destroy…** opens the existing identity-scoped teardown review and requires
its typed confirmation before deletion. Expanding the card never changes AWS.
Selecting a deployed stack opens **Stack details**. Its sections load on demand:
overview and stack policy, resources, events, outputs, parameters, original/processed
templates, tags, change sets and cross-stack dependencies. Overview includes stack IDs,
status reasons and timestamps, role and parent/root identity, termination protection,
rollback settings/alarms, notification topics and the last reported drift status.
Resources, events and change sets expose additional pages rather than silently limiting
the displayed inventory. Export importers load separately when the export is expanded.
Change-set inspection includes resource/property changes and
its reviewed input metadata; it does not execute the change set.

The protected stack-inspection API verifies the selected profile, account, region,
declaration mode and framework ownership before returning data. The initial overview
resolves the stack name to an immutable stack ARN; subsequent section reads use that
ARN. Pagination cursors are bound to the actor, destination, stack and section. Changing
the destination or credential generation closes the inspector and isolates cached data.
These reads do not start drift detection, deploy, delete or resolve Secrets Manager
values. NoEcho parameter values and template defaults are masked; an unavailable
parameter schema produces conservative masking with an explicit explanation.
Sensitive change-set property contexts are also masked when NoEcho inputs are present.
Source-only refreshes retain the expanded deployment and selected stack while updating
its evidence; credential or destination changes close it.

Activity owns preparation progress, logs and CloudFormation events. The full-width This machine, frontend-release and
stateful-retention cards are also absent; their underlying services remain intact. Machine
overview polls every 30 seconds; idle AWS discovery
and target status poll every two minutes, while in-progress jobs retain four-second status
reads and immediate event updates. Failed background reads keep last-good evidence and
offer a contextual retry. Profile/configuration-session changes use fresh query scopes and
invalidate pending reviews; running jobs keep their captured actor. Entering Deploy or
changing Source mode chooses a matching target through the unsaved-source guard. It never starts a deployment or restores an older
per-target profile.

Source-only revisions retain the last deployment observation while a read is pending
or fails, including across navigation. This retained evidence is not a new AWS
observation. Repository, profile, credential generation, mode, deployment, account or
region changes clear it. Source-mode dots use these shared observations: green means
owned stacks are ready, red means confirmed absent, amber means failed, in progress or
unreadable, and muted means unconfigured or not yet observed. Green reports deployed
infrastructure, not application health.

The development map's Local runtime switch submits the same guarded local start/stop
operations as Deploy. Its lightweight `/deploy/local` read observes the checkout's
Compose project and captured runtime destination without AWS reads. Startup verifies
the exact dev destination and compatibility before exporting current outputs and
starting compute. Readiness, partial startup and unknown observations remain separate
states; progress/logs live in Activity. See [local execution](../runtime/local-execution.md).

Activity is a persistent shell tray on every route. `GlobalActivity` owns its job-query
observer and presentation state; it is memoized independently of route/source context.
The shared operation-event observer updates job/log caches once globally, while Deploy
subscribes separately for its route-specific plan-review and CloudFormation callbacks.
Navigation preserves the selected job, open state, mounted log and scroll position.
Activity reads `/api/operations` independently of the deployment overview; it does not
enable AWS discovery or selected-target status reads outside their owning workspaces.

`DeployService` in [service.ts](../../../framework-studio/server/deploy/service.ts) coordinates targets/preferences, prerequisites, plans, operation projection, cloud observer and local environment state. `buildOperation` in [registry.ts](../../../framework-studio/server/deploy/registry.ts) maps recognized actions to fixed repository commands/argv: plan/apply/discard, export, destroy, drift, framework checks, local start/stop, dependencies and Docker. It is not an arbitrary terminal API.

`process.ts` in [deploy/](../../../framework-studio/server/deploy/) launches commands without shell interpolation and delegates selected-profile environments to the shared host connection resolver. Deliberate `credential_source=Environment` dependencies retain their inputs; unrelated ambient sources are removed. Native sign-in uses the separate ephemeral [AWS connection coordinator](../../framework-studio/aws-connections.md), never generic raw-output job logs. Process-tree cancellation does not undo AWS requests already accepted.

## Independent host operations

[Shared contracts](../../../framework-studio/shared/operations.ts) describe versioned
intents, execution state, domain outcomes, cancellation requests and numbered log lines.
Production Studio submits plan/apply/discard, destroy, drift, export and the fixed
`framework-check` operation through a same-user Unix socket to the independent
[coordinator](../../../framework-studio/server/operations/coordinator.ts). The socket
has no TCP listener: its private temporary directory is keyed by user, workspace and
canonical state path. A database lease prevents competing coordinators from replacing a
live socket, including when clients use symlink aliases. The operation database binds to
one canonical checkout and refuses discovery or execution from another checkout.

The [store](../../../framework-studio/server/operations/store.ts) uses SQLite WAL with
FULL synchronous commits. Acceptance atomically records immutable intent, request-key
identity, resource scopes and any consumed review before responding. Identical request
keys return the original operation; different intent under that key is refused. A new
key cannot reuse a consumed apply/deletion review. Overlapping operations are refused;
the current adapter also takes a conservative checkout-tooling scope. Existing CLI
deployment and physical-reference locks remain authoritative.

A detached [worker](../../../framework-studio/server/operations/worker.ts) claims one
dispatch token and owns the complete adapter execution, child processes, output pipes,
credential snapshots and CloudFormation observation. Its children are tethered to the
worker. Browser disconnect and Studio shutdown leave it running. Coordinator restart
discovers existing execution through PID, user and process-start identity; an unavailable
identity probe displays an observation problem and does not prove that the worker died.
Ambiguous dispatch and lost workers
are never dispatched again. Resource claims remain held on execution uncertainty. A
matching verified CLI result can reconcile infrastructure completion without changing
lost execution to successful execution or making the review reusable. That observation
does not release resource claims: the CLI records success before local export, so it
does not prove that all local execution has stopped. There is no explicit inspected
lock-release workflow in this version.

Studio projects worker progress into shared operation events and preserves deployment
event compatibility. Sanitized CloudFormation stack/event payloads have a separate
durable cursor. Log and event replay pages are limited to 4 MiB as well as row counts;
oversized log lines carry a truncation marker, and oversized observation events fail
explicitly. The browser deduplicates committed logs and replays gaps, including the
missed tail after reconnect. Secret values and encoded
forms are redacted before durable logging, including transport chunk boundaries.
Computed numerical summaries, such as a plan's resource count, use typed number
segments so a short private input cannot partially redact a public count. All adjacent
freeform string segments are combined and sanitized with the same secret rules; raw
command output retains its existing redaction behavior.
For older successful synthesis records with a partially redacted count, the operations
client can project that count from the matching saved plan. Missing or mismatched
artifacts preserve the recorded summary; this read-only projection changes neither
the operation journal nor raw logs.
Authentication output and private SQL parameters do not belong to this log protocol.
Drift reports retain their account/region/deployment scope in separate private artifacts.

State defaults to `.cache/framework-studio/operations/`, including `operations.sqlite`
and its WAL. The database has a 256 MiB page limit; WAL overhead is additional. Storage
failure refuses acceptance or stops further execution rather than silently dropping
evidence. There is no automatic retained-log or recovery-record purge. Preserve this
directory with the separate CLI plans, bindings and journals during investigation.

[Legacy JobManager](../../../framework-studio/server/deploy/jobs.ts) continues to own
local development, dependency installation and host remedies. Watch/client tethers still
belong to Studio. Existing job files remain readable; they are not converted into
resumable runner operations. Database, publication, identity, DNS, authentication and
synthesis services retain their current review, privacy and recovery boundaries.

The coordinator starts on demand and exits after 60 seconds without client requests
when no accepted/dispatched/running worker remains. It is independent of application
Compose and development-stop labels. This version supports macOS/Linux, not Windows;
it installs no OS startup service and provides no remote execution, distributed locking,
automatic reboot continuation or worker-toolchain version pinning.

Both development and production require explicit plan review before Studio applies. Saved plans include inline security/property/template evidence, retained stacks and incomplete-analysis blockers. UI checks complement, rather than replace, the [CLI safety gates](planning-and-safety.md).

| Evidence/action | Source / limit |
| --- | --- |
| AWS identity/discovery/status/watch | `AwsObserver` in [observe.ts](../../../framework-studio/server/deploy/observe.ts) invokes [deployment-status.ts](../../../scripts/deployment-status.ts); cached CloudFormation stack/resource/events, not application telemetry |
| Drift | Starts CloudFormation detection and polls status/resource drifts; no resource update, but it is an AWS operation and not complete runtime-state inspection |
| Synthesized inventory | `InfrastructureService` in [infrastructure.ts](../../../framework-studio/server/infrastructure.ts) synthesizes explicit mode in a temporary workspace with selected inputs, fingerprints/caches and cleans outputs; [inspectInfrastructureAssembly](../../../scripts/infrastructure-inventory.ts) traces template ownership/dependencies |
| Inventory ownership | [framework-inventory.ts](../../../cdk-app/lib/framework/framework-inventory.ts) marks constructs without changing logical IDs; inventory separates primary/framework/supporting/imported/unowned objects and has dynamic/nested-template limits |
| Local status/logs | [local.ts](../../../framework-studio/server/deploy/local.ts) inspects Compose/project labels and fetches bounded timestamped Docker logs per service |
| Local start/stop | Requires Docker and matching dev export; launches existing dev commands. Stop preserves database data; start verifies storage read-only. Database application, orphan cleanup and test identity setup are separate explicit actions |

**No CloudWatch application log/metric/trace explorer is implemented in these operational paths.** Lambda log groups exist in CDK and local/job/CloudFormation logs are available; those do not establish a CloudWatch observability product.

[destroy.ts](../../../scripts/destroy.ts) discovers deployment-owned stacks from AWS identity instead of relying on current source, validates account/mode, orders importers before exports, saves a 15-minute deletion review binding account/region/mode, immutable StackIds, policies/templates/imports and retain-failed/protection choices. Required unreadable consequences or external importers block execution. Apply rechecks the scope, uses StackIds, records each phase atomically and requires typed confirmation plus reviewed opt-in to lift termination protection. Managed secrets are retained. Studio's destroy service can address discovered deployments beyond repository-declared targets; the current Deploy page follows the active source-mode target and does not expose the former discovery rail or actions menu. Teardown requires separate environment-specific authorization.

Tests: Studio [jobs](../../../framework-studio/test/deploy-jobs.test.ts), [tether](../../../framework-studio/test/deploy-tether.test.ts), [log store](../../../framework-studio/test/deploy-log-store.test.ts), [infrastructure](../../../framework-studio/test/infrastructure.test.ts); CDK [status](../../../cdk-app/test/deployment-status.test.ts), [destroy](../../../cdk-app/test/deployment-destroy.test.ts), [inventory](../../../cdk-app/test/infrastructure-inventory.test.ts). Cloud status, Docker readiness and browser event recovery need their corresponding environments, not just offline verify.

Independent runner fixtures cover [store/recovery](../../../framework-studio/test/operations-store.test.ts),
[worker output and failure handling](../../../framework-studio/test/operations-worker.test.ts)
and [coordinator lifecycle](../../../framework-studio/test/operations-process.test.ts).
These use controlled local commands; they do not establish live AWS execution.

Cloud evidence, plans, drift and events are scoped to the resolved destination. Default-region discovery failures do not hide a readable selected-region target; partial failures retain contextual retry feedback. Detailed observation timestamps and stack lists remain in service responses, while the former AWS card is absent from the page. Failed/unverified/interrupted/export-failed releases retain their phase/result evidence and expose review/recheck/new-plan or separate export recovery. CloudFormation completion never claims application health.

Deploy and saved teardown share a per-checkout deployment-name lock. Stale, incomplete or unreadable locks require inspecting their progress and AWS before explicit removal; automatic reclamation could race a new owner. Release checks a unique ownership token. This is not cross-machine coordination.
