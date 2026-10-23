---
id: knowledge.router
summary: Select the smallest architecture context for a development task.
read_when:
  - Starting an architecture-sensitive change
source:
  - framework.config.ts
  - framework-studio/server/index.ts
related:
  - knowledge.architecture-map
  - knowledge.repository-map
---
# AWS Studio knowledge router

AWS Studio is a local, source-linked editor and architecture viewer for this AWS application framework. TypeScript declarations drive CDK, local execution, generated contracts, and Studio's graph. Source remains authoritative; reviewed Studio edits write source.

Read this router, **one first page**, then only its relevant dependency links. Verify critical symbols against current source. [Architecture map](ARCHITECTURE-MAP.md) explains the connections; [repository map](REPOSITORY-MAP.md) locates owners.

| Task | Read first | Then consult if affected |
| --- | --- | --- |
| Studio styling, workspace chrome or control consistency | [UI design system](../framework-studio/ui-design-system.md) | [Inspector conventions](../framework-studio/inspector-design.md), [Rendering](studio/rendering.md) |
| Cognito workspace, federation, identity pools or permission evidence | [Authentication workspace](studio/authentication.md) | [Identity/domain guide](../framework-studio/identity-and-domains.md), [Planning/safety](deployment/planning-and-safety.md) |
| Inspector property or source diff | [Editing](studio/editing.md) | [Source indexing](studio/source-indexing.md), [extension recipe](guides/extensions.md) |
| Prisma editor, migration history or database evidence | [Editing](studio/editing.md) | [Database workbench](../framework-studio/database-workbench.md), [Snapshots](studio/snapshots.md), [Graph model](studio/graph-model.md) |
| Add to Application or triggers | [Creation/connections](studio/creation-and-connections.md) | [Editing](studio/editing.md), [resources/CDK](framework/resources-and-cdk.md) |
| Snapshot, stale graph, server | [Snapshots](studio/snapshots.md) | [Graph model](studio/graph-model.md) |
| Isometric layout/routing | [Rendering](studio/rendering.md) | [Graph model](studio/graph-model.md) |
| Framework DSL or workload identity | [Configuration](framework/configuration.md) | [Change impact](reference/change-impact.md) |
| Resource reference or native grant | [Resources/CDK](framework/resources-and-cdk.md) | [Environment delivery](runtime/environment.md) |
| Step Functions operation | [Workflows](framework/workflows.md) | [Extension recipe](guides/extensions.md) |
| Agent or tool | [Agents/tools](framework/agents-and-tools.md) | [Local execution](runtime/local-execution.md) |
| Local invocation/containers | [Local execution](runtime/local-execution.md) | [Environment delivery](runtime/environment.md) |
| Deploy approval, ownership, failure | [Planning/safety](deployment/planning-and-safety.md) | [Operations](deployment/operations.md) |
| Stateful retention, teardown dependencies or retained-resource reuse | [Stateful lifecycle](../framework-studio/stateful-resources.md) | [Database references](framework/stateful-database.md), [Authentication](studio/authentication.md), [Planning/safety](deployment/planning-and-safety.md) |
| Secrets or input values | [Secrets](deployment/secrets.md) | [Environment delivery](runtime/environment.md) |
| Staging, named target, third mode | [Environments](deployment/environments.md) | [Change impact](reference/change-impact.md) |

[Walkthroughs](guides/workflows.md) trace common tasks. [Invariants](reference/invariants.md), [capabilities](reference/capabilities.md), [glossary](reference/glossary.md), and [source authority](architecture/contracts.md) resolve boundaries. [Retrieval checks](guides/retrieval-checks.md) test eight routes.

Copy into future prompts:

> Start at docs/aws-studio-knowledge/README.md. Load the smallest relevant page set, verify critical contracts in source, implement and test the change, and update only affected canonical pages.

Maintain/check using [this protocol](guides/verification-and-maintenance.md): `node docs/aws-studio-knowledge/check.mjs`.
