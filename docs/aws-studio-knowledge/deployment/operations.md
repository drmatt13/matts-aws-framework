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
has no subnav bar, deployment rail, Repository/AWS cards, stage-creation form or direct
template-comparison/change-set controls. The full-width This machine, frontend-release and
stateful-retention cards are also absent; their underlying services remain intact. Machine
overview polls every 30 seconds; idle AWS discovery
and target status poll every two minutes, while in-progress jobs retain four-second status
reads and immediate event updates. Failed background reads keep last-good evidence and
offer a contextual retry. Profile/configuration-session changes use fresh query scopes and
invalidate pending reviews; running jobs keep their captured actor. Entering Deploy or
changing Source mode chooses a matching target through the unsaved-source guard. It never starts a deployment or restores an older
per-target profile.

Activity is a persistent shell tray on every route. `GlobalActivity` owns its job-query
observer and presentation state; it is memoized independently of route/source context.
The shared deployment-event observer updates job/log caches once globally, while Deploy
subscribes separately for its route-specific plan-review and CloudFormation callbacks.
Navigation preserves the selected job, open state, mounted log and scroll position.
The overview read is local and profile-metadata-only; global Activity does not enable AWS
discovery or selected-target status reads outside their owning workspaces.

`DeployService` in [service.ts](../../../framework-studio/server/deploy/service.ts) coordinates targets/preferences, prerequisites, plans, jobs, cloud observer and local environment state. `buildOperation` in [registry.ts](../../../framework-studio/server/deploy/registry.ts) maps recognized actions to fixed repository commands/argv: plan/apply/discard, export, destroy, drift, local start/stop, dependencies, Docker and AWS login. It is not an arbitrary terminal API.

`process.ts` in [deploy/](../../../framework-studio/server/deploy/) launches commands without shell interpolation and delegates selected-profile environments to the shared host connection resolver. Deliberate `credential_source=Environment` dependencies retain their inputs; unrelated ambient sources are removed. [jobs.ts](../../../framework-studio/server/deploy/jobs.ts) locks overlapping operations in the server, persists job metadata/log lines, batches SSE events and permits client gap replay. Native sign-in now uses the separate ephemeral [AWS connection coordinator](../../framework-studio/aws-connections.md), never generic raw-output job logs. Old running records are restored as interrupted; this is not resumable CloudFormation execution. Watch/client child lifetimes use [tether.mjs](../../../framework-studio/server/deploy/tether.mjs). Process-tree cancellation does not undo AWS requests already accepted.

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

Cloud evidence, plans, drift and events are scoped to the resolved destination. Default-region discovery failures do not hide a readable selected-region target; partial failures retain contextual retry feedback. Detailed observation timestamps and stack lists remain in service responses, while the former AWS card is absent from the page. Failed/unverified/interrupted/export-failed releases retain their phase/result evidence and expose review/recheck/new-plan or separate export recovery. CloudFormation completion never claims application health.

Deploy and saved teardown share a per-checkout deployment-name lock. Stale, incomplete or unreadable locks require inspecting their progress and AWS before explicit removal; automatic reclamation could race a new owner. Release checks a unique ownership token. This is not cross-machine coordination.
