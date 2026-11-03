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
| [ws-tester/](../../ws-tester/), [Studio WebSocket panels](../../framework-studio/src/views/websockets/) | Standalone client and Studio-adapted connection panels; shared launch-link convention, separate UI implementations | [Interface](studio/interface.md) |
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
| Authentication or production domains | [AuthenticationWorkspace.tsx](../../framework-studio/src/views/AuthenticationWorkspace.tsx) owns state/operations; [AuthenticationEvidence.tsx](../../framework-studio/src/views/AuthenticationEvidence.tsx) owns read-only evidence; [DomainsWorkspace.tsx](../../framework-studio/src/views/DomainsWorkspace.tsx), `identity-api`, `identity-queries` | `cognito-workspace-ui`, `domains-workspace-ui`, browser operations |
| Agent test `/test` | [AgentLab.tsx](../../framework-studio/src/views/AgentLab.tsx), [agent-lab-api.ts](../../framework-studio/src/agent-lab-api.ts), [server/agent-lab.ts](../../framework-studio/server/agent-lab.ts); [experiment guide](../framework-studio/local-agent-lab.md) owns the fixed demo-message boundary | `agent-lab`; CLI/source-refusal fixtures |

## Shared code and local conventions

Studio and `client-app` are different React applications. Studio's router is explicit
in `src/main.tsx`; the application uses file routes in `client-app/src/routes/` and a
generated route tree. Share framework contracts through package exports, rather than
importing one application's implementation into the other. The
[framework package manifest](../../packages/framework/package.json) defines explicit
`config`, `runtime/*`, `local` and `deploy` entry points; there is no package-root barrel.
Studio uses relative imports, while `client-app` also defines the `#/*` source alias in
its [manifest](../../client-app/package.json) and [TypeScript config](../../client-app/tsconfig.json).

| Concern | Existing owner / convention |
| --- | --- |
| Shared browser/server shapes | [Studio shared contracts](../../framework-studio/shared/); runtime imports stay browser-safe, as enforced by `browser-boundaries.test.ts`; type-only contracts can cross the boundary |
| Component and feature ownership | Named React components in `src/views/`; feature subdirectories hold cohesive rendering, while session/draft owners retain state and effects |
| Shared controls and class recipes | [src/ui/](../../framework-studio/src/ui/), [inspector-ui.ts](../../framework-studio/src/inspector-ui.ts), `DocumentUI`, `WorkbenchUI` and `views/map-styles.ts`; use the [UI design system](../framework-studio/ui-design-system.md) before changing presentation |
| Studio styles | [styles.css](../../framework-studio/src/styles.css) registers sources and responsive variants; [styles/](../../framework-studio/src/styles/) owns theme, base/native behavior and CodeMirror integration |
| Declaration discovery and source links | [config-source.ts](../../packages/framework/scripts/config-source.ts), [server/source/](../../framework-studio/server/source/); follow [source indexing](studio/source-indexing.md) before moving declarations or rewriting recognized syntax |
| Generated projections | [AGENTS.md](../../AGENTS.md) lists protected outputs; use root `framework:generate`, database `generate`, root `codegen` or the client route build through the [required contract sequence](../playbooks/typed-contract-propagation.md) |

These are current ownership boundaries, not a reason to rename every existing file or
introduce a common abstraction across applications. Native CDK, declaration modules and
Studio source writers have different contracts even where their TypeScript looks similar.

## Commands and test discovery

Root [package.json](../../package.json) owns user-facing command names. Its `scripts/`
entry files delegate deployment planning, assembly, exports and identity checks to
neighboring modules and `packages/framework/src/deploy/`. Framework contract generation
and checks live in [packages/framework/scripts/](../../packages/framework/scripts/);
database generators and maintenance tools belong to [packages/database/](../../packages/database/).
Follow the [development](../DEV-DEPLOYMENT.md) and [production](../PROD-DEPLOYMENT.md)
guides for command effects; a helper under `scripts/` is not necessarily an offline check.

| Test surface | Discovery / runner |
| --- | --- |
| Studio unit, DOM and service fixtures | `framework-studio/test/*.test.ts`, Node test runner with development conditions, CSS registration and `tsx`; use its workspace `test` script to preserve those options |
| Framework, CDK, database, API server and invocation runner | Each workspace's `test/*.test.ts` through its manifest; Node test runner and `tsx`, with workspace-specific concurrency |
| Application and standalone WebSocket client | Colocated `*.test.ts` / `*.test.tsx`, through the workspace's Vitest configuration |
| GraphQL executable schema | `cdk-app/lambda_functions/http_functions/graphql-api/schema/*.test.ts`, explicitly included by root `verify`; schema modules also require explicit registration |
| Studio browser fixtures and visuals | `framework-studio/test/browser/*.spec.ts`, a separate Playwright command; [browser guide](../../framework-studio/test/browser/README.md) owns sanitized API fixtures, pinned fonts, screenshot review and output retention |

Root `npm run verify` covers generated contracts, typechecks and workspace/schema suites
without AWS or a running database. Browser checks, full application synthesis, Docker
execution and live database/AWS evidence are separate. Test globs and explicit schema
imports make file placement significant; an apparently unimported test or fixture is
not evidence that it is unused. [Maintenance](guides/verification-and-maintenance.md)
maps checks to change surfaces; [repository hygiene](../REPOSITORY-HYGIENE.md) distinguishes
maintained fixtures and reviewed visual references from disposable output.

Respect [AGENTS.md](../../AGENTS.md) and its generated-file exclusions. Application GraphQL/data feature procedures remain in their existing guides; this wiki maps their boundary rather than duplicating them.
