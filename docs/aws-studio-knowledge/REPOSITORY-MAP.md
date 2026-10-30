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

## Where to change Studio

Keep route entries and session owners easy to find; group extracted feature rendering
beside its owner. The [interface guide](studio/interface.md) owns the route/state model,
and the [UI design system](../framework-studio/ui-design-system.md) owns shared controls.

| Change | Start here | Relevant regression surface |
| --- | --- | --- |
| Page route, deep link or selection URL | [main.tsx](../../framework-studio/src/main.tsx); page entry in `src/views/` | `startup-ui`, `hmr-ui`, browser `shell` |
| Shared navigation, source selector or health drawer | [Shell.tsx](../../framework-studio/src/views/Shell.tsx), `NavigationStrip`, `SourceContext` | `navigation-polish`, browser `shell`/`responsive` |
| Inspector section or entity-specific content | [Inspector.tsx](../../framework-studio/src/views/Inspector.tsx) dispatches to [views/inspector/](../../framework-studio/src/views/inspector/) and existing specialized editors | `draft-ui`, browser `inspector-navigation`/`map-editing` |
| Trigger form steps or field editors | [Triggers.tsx](../../framework-studio/src/views/Triggers.tsx) owns state; [inspector/triggers/](../../framework-studio/src/views/inspector/triggers/) owns rendering | `trigger-ui`, `draft-ui`, creation/trigger server fixtures |
| Draft lifecycle or source request conversion | [draft.ts](../../framework-studio/src/draft.ts), [draft-entries.ts](../../framework-studio/src/draft-entries.ts) | `draft`, `draft-ui`, source transaction fixtures |
| Map toolbar or keyboard entity list | [views/map/](../../framework-studio/src/views/map/); [Isometric.tsx](../../framework-studio/src/views/Isometric.tsx) owns state/callbacks | `isometric-ui`, browser `map-editing`/`responsive` |
| Scene geometry, layout, drawing or picking | [scene/](../../framework-studio/src/scene/); [types.ts](../../framework-studio/src/scene/types.ts) defines scene contracts | geometry/layout/landscape/hover suites; browser map cases |
| HTTP behavior, snapshot refresh or server events | [http.ts](../../framework-studio/src/http.ts), [api.ts](../../framework-studio/src/api.ts), [snapshot.ts](../../framework-studio/src/snapshot.ts), [events.ts](../../framework-studio/src/events.ts) | `api-response`, `events`, `startup-ui`, `browser-boundaries` |
| Deployment evidence, refresh or live logs | [deploy/](../../framework-studio/src/deploy/) separates API, query definitions, event hooks and log store; [Deploy.tsx](../../framework-studio/src/views/Deploy.tsx) composes the page | `deploy-ui`, deploy-service fixtures, browser `operations` |
| Authentication or production domains | [AuthenticationWorkspace.tsx](../../framework-studio/src/views/AuthenticationWorkspace.tsx), [DomainsWorkspace.tsx](../../framework-studio/src/views/DomainsWorkspace.tsx), `identity-api`, `identity-queries` | `cognito-workspace-ui`, `domains-workspace-ui`, browser operations |

Respect [AGENTS.md](../../AGENTS.md) and its generated-file exclusions. Application GraphQL/data feature procedures remain in their existing guides; this wiki maps their boundary rather than duplicating them.
