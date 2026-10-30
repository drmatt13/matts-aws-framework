---
id: knowledge.repository-map
summary: Source ownership and exact entry points without a full repository tree.
read_when:
  - Locating implementation and test owners
source:
  - package.json
  - AGENTS.md
related:
  - knowledge.architecture-map
  - guides.maintenance
---
# Source ownership map

For the product map start with [AWS Studio](../AWS-STUDIO.md); for all documentation
areas use the [documentation index](../README.md).

Paths are relative to the repository. Symbols are search anchors; source links intentionally avoid fragile line numbers.

| Source owner | Entry points / responsibility | Architecture |
| --- | --- | --- |
| [framework.config.ts](../../framework.config.ts), [framework-config/](../../framework-config/) | Composition root, literal sections, defaults, network, catalog, type-only contracts | [Configuration](framework/configuration.md) |
| [packages/framework/src/config/](../../packages/framework/src/config/) | `defineFrameworkConfig`, `normalizeFrameworkConfig`, resource types, workflow builder/IR/ASL | [DSL](framework/configuration.md), [workflows](framework/workflows.md) |
| [cdk-app/bin/](../../cdk-app/bin/), [lib/framework/](../../cdk-app/lib/framework/) | Mode bootstrap, composition factories, Lambda/ECS/network/orchestration, resource finalization | [Resources/CDK](framework/resources-and-cdk.md) |
| [cdk-app/lib/app/](../../cdk-app/lib/app/) | Application-owned Cognito, database, frontend and custom resource constructs | [Resources/CDK](framework/resources-and-cdk.md) |
| [framework-studio/server/](../../framework-studio/server/) | `main`, `startServer`, `SnapshotBuilder`; model, source evidence, editing, deploy adapters | [Snapshots](studio/snapshots.md), [editing](studio/editing.md) |
| [framework-studio/shared/](../../framework-studio/shared/) | `Snapshot`, `ModeModel`, `ModelEdge`, API intents, creation forms | [Graph](studio/graph-model.md) |
| [framework-studio/src/](../../framework-studio/src/) | Router, `StudioProvider`, `InspectorDraft`, views, Canvas scene | [Rendering](studio/rendering.md), [editing](studio/editing.md) |
| [packages/framework/src/local/](../../packages/framework/src/local/), [src/runtime/](../../packages/framework/src/runtime/) | Local executor/environment/interpreter vs deployed helpers/auth/invocation | [Local](runtime/local-execution.md) |
| [local-api-dev-server/](../../local-api-dev-server/), [local-ws-dev-server/](../../local-ws-dev-server/) | HTTP/service proxy, Cognito auth, WebSocket connection transport, replay | [Local](runtime/local-execution.md) |
| [local-invocation-runner/src/](../../local-invocation-runner/src/) | Container Lambdas/tasks, workflow runs/callbacks, agent processes, image reconciliation | [Local](runtime/local-execution.md), [agents](framework/agents-and-tools.md) |
| [agents/](../../agents/), [packages/models/](../../packages/models/) | Agent application modules/contracts and shared model providers | [Agents/tools](framework/agents-and-tools.md) |
| [scripts/deploy.ts](../../scripts/deploy.ts), [packages/framework/src/deploy/](../../packages/framework/src/deploy/) | Plan/apply, identity, target selection, ownership/discovery/classification | [Planning](deployment/planning-and-safety.md) |
| [scripts/deployment-status.ts](../../scripts/deployment-status.ts), [destroy.ts](../../scripts/destroy.ts) | AWS observation/drift and identity-scoped teardown | [Operations](deployment/operations.md) |
| [packages/database/](../../packages/database/), [packages/api-contract/](../../packages/api-contract/), [client-app/](../../client-app/) | Prisma storage/repositories, browser-safe routes/payloads, application UI | [Existing data guide](../DATA-FEATURES.md) |
| [docker-compose.yml](../../docker-compose.yml), [scripts/dev.mjs](../../scripts/dev.mjs) | Image-owned dependencies, Compose Watch and local bootstrap | [Existing development guide](../DEV-DEPLOYMENT.md) |

Tests live beside each workspace: [Studio](../../framework-studio/test/), [framework](../../packages/framework/test/), [CDK/deployment](../../cdk-app/test/), [runner](../../local-invocation-runner/test/). [Maintenance](guides/verification-and-maintenance.md) maps checks to change surfaces.

Respect [AGENTS.md](../../AGENTS.md) and its generated-file exclusions. Application GraphQL/data feature procedures remain in their existing guides; this wiki maps their boundary rather than duplicating them.
