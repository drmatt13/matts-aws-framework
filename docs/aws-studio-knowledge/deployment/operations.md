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
  - deployment.planning-safety
  - deployment.environments
  - runtime.local-execution
---
# Deployment jobs and operational evidence

`DeployService` in [service.ts](../../../framework-studio/server/deploy/service.ts) coordinates targets/preferences, prerequisites, plans, jobs, cloud observer and local environment state. `buildOperation` in [registry.ts](../../../framework-studio/server/deploy/registry.ts) maps recognized actions to fixed repository commands/argv: plan/apply/discard, export, destroy, drift, local start/stop, dependencies, Docker and AWS login. It is not an arbitrary terminal API.

`process.ts` in [deploy/](../../../framework-studio/server/deploy/) launches commands without shell interpolation, selects the chosen profile and drops direct credential/mode carryover where implemented. [jobs.ts](../../../framework-studio/server/deploy/jobs.ts) locks overlapping operations in the server, persists job metadata/log lines, batches SSE events and permits client gap replay. Old running records are restored as interrupted; this is not resumable CloudFormation execution. Watch/client child lifetimes use [tether.mjs](../../../framework-studio/server/deploy/tether.mjs). Process-tree cancellation does not undo AWS requests already accepted.

Production apply always follows review. Dev's optional auto-apply proceeds only when the generated plan requires no confirmation. UI checks complement, rather than replace, the [CLI safety gates](planning-and-safety.md).

| Evidence/action | Source / limit |
| --- | --- |
| AWS identity/discovery/status/watch | `AwsObserver` in [observe.ts](../../../framework-studio/server/deploy/observe.ts) invokes [deployment-status.ts](../../../scripts/deployment-status.ts); cached CloudFormation stack/resource/events, not application telemetry |
| Drift | Starts CloudFormation detection and polls status/resource drifts; no resource update, but it is an AWS operation and not complete runtime-state inspection |
| Synthesized inventory | `InfrastructureService` in [infrastructure.ts](../../../framework-studio/server/infrastructure.ts) synthesizes explicit mode in a temporary workspace with selected inputs, fingerprints/caches and cleans outputs; [inspectInfrastructureAssembly](../../../scripts/infrastructure-inventory.ts) traces template ownership/dependencies |
| Inventory ownership | [framework-inventory.ts](../../../cdk-app/lib/framework/framework-inventory.ts) marks constructs without changing logical IDs; inventory separates primary/framework/supporting/imported/unowned objects and has dynamic/nested-template limits |
| Local status/logs | [local.ts](../../../framework-studio/server/deploy/local.ts) inspects Compose/project labels and fetches bounded timestamped Docker logs per service |
| Local start/stop | Requires Docker and matching dev export; launches existing dev commands. Stop preserves database data; start can run migrations |

**No CloudWatch application log/metric/trace explorer is implemented in these operational paths.** Lambda log groups exist in CDK and local/job/CloudFormation logs are available; those do not establish a CloudWatch observability product.

[destroy.ts](../../../scripts/destroy.ts) discovers deployment-owned stacks from AWS identity instead of relying on current source, validates account/mode, orders importers before exports, requires typed confirmation before disabling termination protection, and reports failed/retained resources. Managed secrets are retained. Studio's explicit destroy can address discovered deployments beyond repository-declared targets; a read-only/foreign deployment display must not be treated as a universal CLI deletion prohibition. Teardown requires separate environment-specific authorization.

Tests: Studio [jobs](../../../framework-studio/test/deploy-jobs.test.ts), [tether](../../../framework-studio/test/deploy-tether.test.ts), [log store](../../../framework-studio/test/deploy-log-store.test.ts), [infrastructure](../../../framework-studio/test/infrastructure.test.ts); CDK [status](../../../cdk-app/test/deployment-status.test.ts), [destroy](../../../cdk-app/test/deployment-destroy.test.ts), [inventory](../../../cdk-app/test/infrastructure-inventory.test.ts). Cloud status, Docker readiness and browser event recovery need their corresponding environments, not just offline verify.
