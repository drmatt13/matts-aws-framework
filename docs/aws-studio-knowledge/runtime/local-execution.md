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

Node zip execution supports the configured Node handler path; a Python zip declaration does not imply local Python support. Source/environment fingerprints prevent stale worker reuse but are not a security sandbox. Local egress guards approximate declared network restrictions in Node; they are not VPC firewalls.

Runtime `runTask` / `startWorkflow` in [invocation.ts](../../../packages/framework/src/runtime/invocation.ts) consume declared descriptors and select local runner or AWS transport. Never branch in application code to choose transport. Local caller/binding checks are not cryptographic IAM. Poll terminal outcomes when testing; an accepted start is not a completed task/workflow.

Docker images own dependencies and generated database artifacts. [docker-compose.yml](../../../docker-compose.yml) plus generated service projection and override conventions define Watch delivery; never mount the whole checkout over image dependencies. Preserve `postgres_data`. `LocalImageJanitor` in [images.ts](../../../local-invocation-runner/src/images.ts) keeps current/in-use images and removes only superseded labeled project images, unforced. New runner build paths must preserve names/labels.

Events marked `localReplay: true` still originate in AWS: `withLocalReplay` in [event-replay.ts](../../../packages/framework/src/runtime/event-replay.ts) captures payloads through dev S3/SQS infrastructure; the local dispatcher polls and invokes the declared handler. Queue acknowledgments/retries and handler completion are distinct. This is not local emulation of every event source.

Local does **not** mean offline: Cognito, stack-created secret reads, workflow service SDK calls/bridges, event replay and models can reach AWS/providers. AWS profile permissions may exceed deployed roles. Default Compose startup runs read-only `prisma-verify`; initialization/migration, orphan cleanup and test identity setup have separate authorizations/profiles and are never compute-start dependencies. A verification failure leaves PostgreSQL available for the Database workbench. Studio reports readiness only after container health and client HTTP checks; that does not prove authenticated application correctness. Runner restart loses in-memory workflows/callbacks. [Environment delivery](environment.md) defines supplied values; [maintenance](../guides/verification-and-maintenance.md) separates offline tests from Docker/live checks.
