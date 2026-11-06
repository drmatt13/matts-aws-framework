---
id: runtime.local-execution
summary: HTTP/WebSocket ingress, Node workers, containers, tasks, workflows, and agent processes.
read_when:
  - Running or debugging workloads locally
  - Changing runner transports, process lifecycle, or Docker paths
source:
  - local-api-dev-server/src/index.ts
  - local-ws-dev-server/src/index.ts
  - packages/framework/src/local/index.ts
  - packages/framework/src/local/lambda-process.ts
  - local-invocation-runner/src/index.ts
  - local-invocation-runner/src/tasks.ts
  - framework-studio/server/deploy/local.ts
  - framework-studio/server/deploy/registry.ts
  - framework-studio/src/deploy/local-runtime.ts
  - framework-studio/src/deploy/local-runtime-state.ts
  - framework-studio/src/views/map/ComposePreview.tsx
related:
  - runtime.environment
  - framework.workflows
  - framework.agents-tools
---
# Local execution paths

[Development](../../DEV-DEPLOYMENT.md) owns setup/reload commands. Local execution consumes normalized declarations; do not add application route/import tables to generic servers.

| Workload | Call path / lifecycle |
| --- | --- |
| HTTP Lambda | [API server](../../../local-api-dev-server/src/index.ts) maps literal route/method and verifies declared Cognito auth → `LocalLambdaExecutor` in [local/index.ts](../../../packages/framework/src/local/index.ts) → Node child or container runner |
| Service | Same API server → Compose DNS service URL, with mount prefix removed; generated Compose owns declared local service registration |
| WebSocket | [WS server](../../../local-ws-dev-server/src/index.ts) runs declared connect/message/disconnect handlers, retains authorizer context, and supplies connection push transport |
| Node zip Lambda | `invokeLocalNodeLambda` in [lambda-process.ts](../../../packages/framework/src/local/lambda-process.ts) resolves environment before loading handler, creates Lambda context, enforces timeout, returns result/error over IPC |
| Warm Node worker | `LambdaWorkerPool` caches processes by handler/source/environment fingerprint, serializes reuse and evicts idle workers; configured limits differ from cloud concurrency. Tools opt for cold execution |
| Container Lambda | [runner/index.ts](../../../local-invocation-runner/src/index.ts) builds architecture-pinned image, launches Runtime Interface Emulator container and invokes it |
| Container task | `LocalTaskSupervisor` in [tasks.ts](../../../local-invocation-runner/src/tasks.ts) builds/starts container, records running/terminal state, logs and stop requests; zero/nonzero exit determines outcome |
| Workflow | `LocalWorkflowEngine` delegates the [shared IR interpreter](../framework/workflows.md) to Lambda/task/integration/agent executors and callback broker |
| Agent | [LocalAgentSupervisor and Gateway emulation](../framework/agents-and-tools.md) provide session processes and contract-enforced tools |

Node zip execution supports the configured Node handler path; a Python zip declaration does not imply local Python support. Environment fingerprints prevent reuse after environment changes; source changes restart the owner through Watch. These processes are not a security sandbox. Closing an executor cancels active cold-only calls as well as warm workers; closing a pool also cancels cold overflow calls. Both become terminal and refuse new invocations. An already cancelled invocation never launches a handler. Local workloads use ordinary host and Docker networking without VPC egress guards or forced dual-stack SDK endpoints. Local success does not verify deployed VPC reachability.

Runtime `runTask` / `startWorkflow` in [invocation.ts](../../../packages/framework/src/runtime/invocation.ts) consume declared descriptors and select local runner or AWS transport. Never branch in application code to choose transport. Local caller/binding checks are not cryptographic IAM. Poll terminal outcomes when testing; an accepted start is not a completed task/workflow.

Docker images own dependencies and generated database artifacts. [docker-compose.yml](../../../docker-compose.yml) plus generated service projection and override conventions define Watch delivery; never mount the whole checkout over image dependencies. Preserve `postgres_data`. `LocalImageJanitor` in [images.ts](../../../local-invocation-runner/src/images.ts) keeps current/in-use images and removes only superseded labeled project images, unforced. Legacy images without a project label are preserved because ownership cannot be established. New runner build paths must preserve names/labels.

Events marked `localReplay: true` still originate in AWS: `withLocalReplay` in [event-replay.ts](../../../packages/framework/src/runtime/event-replay.ts) captures payloads through dev S3/SQS infrastructure; the local dispatcher polls and invokes the declared handler. Queue acknowledgments/retries and handler completion are distinct. This is not local emulation of every event source.

Local does **not** mean offline: Cognito, stack-created secret reads, workflow service SDK calls/bridges, event replay and models can reach AWS/providers. AWS profile permissions may exceed deployed roles. Default Compose startup runs read-only `prisma-verify`; initialization/migration, orphan cleanup and test identity setup have separate authorizations/profiles and are never compute-start dependencies. A verification failure leaves PostgreSQL available for the Database workbench. Studio reports readiness only after container health and client HTTP checks; that does not prove authenticated application correctness. Runner restart loses in-memory workflows/callbacks. [Environment delivery](environment.md) defines supplied values; [maintenance](../guides/verification-and-maintenance.md) separates offline tests from Docker/live checks.

The development map's **Local runtime** switch uses the existing guarded startup/stop
operations. A fresh AWS observation must confirm the selected development target,
account, region, profile and source compatibility before export or compute starts.
Every start, restart and resume regenerates development exports after the same preflight:
root `.env`, `.framework/local/resources.json`, and `client-app/.env.development.local`.
Export generation preserves authored values and validates the exported destination
before compute starts. Existing files cannot replace a fresh AWS completion check.
Startup never deploys resources, applies migrations or seeds identities.
Startup clears inherited `COMPOSE_PROFILES` so maintenance profiles cannot be enabled
implicitly. Readiness inventories the native resolved Compose configuration (including
generated includes and overrides), requires every default enabled service and successful
one-shot prerequisite completion, then checks watch, client and client HTTP readiness.
Missing services cannot be hidden by a healthy remaining container. Profiled maintenance
services remain outside compute readiness; native configuration values stay server-side.

`GET /api/deploy/local` observes only this checkout's Compose project, managed watch/client,
exported destination and captured run binding; it performs no AWS reads. The map shares
that repository-scoped query across navigation and refreshes it every five seconds
(two during a runtime operation), alongside existing operation events. Read errors stay
unknown rather than becoming stopped; last-known active evidence remains explicitly
unavailable until a successful observation confirms shutdown. Active Compose/runner
containers, including paused and one-shot processes, and host watch/client processes
keep the switch engaged. Merely created or exited containers are inactive. **Running**
requires readiness plus exact captured/exported binding; a partial startup stays on
with **Needs attention** so toggling off stops it. Start is disabled until AWS, host and
operation evidence confirm eligibility; **Details** explains the next step. Changing
Source profile never exports over a running binding automatically.

Development apply, destruction, manual export/repoint and cloud-writing plan preparation
require local runtime fully off. Studio repeats this guard at acceptance and immediately
before the command, including detached workers, with shared local/export locks. Source
editing and ordinary template synthesis/review stay available. Production infrastructure
keeps its separate scope. Stop resumes paused containers only to stop them gracefully,
and preserves containers and volumes. Activity owns operation progress and logs.
