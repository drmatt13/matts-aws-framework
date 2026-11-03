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
Deploy's jobs, observation and local process supervision.

Deploy's subnav contains machine checks and their local remedies, with no account summary
or animated refresh button. Machine overview polls every 30 seconds; idle AWS discovery
and target status poll every two minutes, while in-progress jobs retain four-second status
reads and immediate event updates. Failed background reads keep last-good evidence and
offer a contextual retry. Profile/configuration-session changes use fresh query scopes and
invalidate pending reviews; running jobs keep their captured actor. Selecting a deployment
accepts its declared mode through the unsaved-source guard, and entering Deploy or changing
Source mode chooses a matching target. It never starts a deployment or restores an older
per-target profile.

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

[destroy.ts](../../../scripts/destroy.ts) discovers deployment-owned stacks from AWS identity instead of relying on current source, validates account/mode, orders importers before exports, saves a 15-minute deletion review binding account/region/mode, immutable StackIds, policies/templates/imports and retain-failed/protection choices. Required unreadable consequences or external importers block execution. Apply rechecks the scope, uses StackIds, records each phase atomically and requires typed confirmation plus reviewed opt-in to lift termination protection. Managed secrets are retained. Studio's explicit destroy can address discovered deployments beyond repository-declared targets; the rail labels these “not declared here,” with source/deploy controls unavailable and separate deletion recovery. Teardown requires separate environment-specific authorization.

Tests: Studio [jobs](../../../framework-studio/test/deploy-jobs.test.ts), [tether](../../../framework-studio/test/deploy-tether.test.ts), [log store](../../../framework-studio/test/deploy-log-store.test.ts), [infrastructure](../../../framework-studio/test/infrastructure.test.ts); CDK [status](../../../cdk-app/test/deployment-status.test.ts), [destroy](../../../cdk-app/test/deployment-destroy.test.ts), [inventory](../../../cdk-app/test/infrastructure-inventory.test.ts). Cloud status, Docker readiness and browser event recovery need their corresponding environments, not just offline verify.

Cloud evidence, plans, drift and events are scoped to the resolved destination. Default-region discovery failures do not hide a readable selected-region target; observations show age and partial failures. Failed/unverified/interrupted/export-failed releases retain their phase/result evidence and expose review/recheck/new-plan or separate export recovery. CloudFormation completion never claims application health.

Deploy and saved teardown share a per-checkout deployment-name lock. Stale, incomplete or unreadable locks require inspecting their progress and AWS before explicit removal; automatic reclamation could race a new owner. Release checks a unique ownership token. This is not cross-machine coordination.
