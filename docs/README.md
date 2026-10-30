# Documentation index

Start with [AWS Studio: product, architecture and direction](AWS-STUDIO.md). It explains
how the framework, visual interface, application code, local runtime and AWS operations
form one system. For a focused engineering task, use the
[knowledge router](aws-studio-knowledge/README.md), then follow source links from the
smallest relevant page.

## Current guides and canonical ownership

| Need | Canonical entry |
| --- | --- |
| Product identity and long-term direction | [AWS Studio](AWS-STUDIO.md) |
| Supported, bounded and proposed capabilities | [Status](aws-studio-knowledge/reference/status.md), [capability matrix](aws-studio-knowledge/reference/capabilities.md) |
| First setup | [Quickstart](../QUICKSTART.md), then [Development](DEV-DEPLOYMENT.md) |
| Framework architecture and DSL | [Architecture](aws-studio-knowledge/framework/architecture.md), [Framework guide](FRAMEWORK.md), [declaration layout](../framework-config/README.md) |
| Source ownership and cross-subsystem flow | [Repository map](aws-studio-knowledge/REPOSITORY-MAP.md), [architecture map](aws-studio-knowledge/ARCHITECTURE-MAP.md), [authority contracts](aws-studio-knowledge/architecture/contracts.md) |
| Studio user interface and backend | [Interface](aws-studio-knowledge/studio/interface.md), [backend](aws-studio-knowledge/studio/backend.md), [workspace README](../framework-studio/README.md) |
| Graph, source inference and rendering | [Graph](aws-studio-knowledge/studio/graph-model.md), [source indexing](aws-studio-knowledge/studio/source-indexing.md), [rendering](aws-studio-knowledge/studio/rendering.md) |
| Source changes and creation | [Editing](aws-studio-knowledge/studio/editing.md), [creation/connections](aws-studio-knowledge/studio/creation-and-connections.md) |
| Resources, native capabilities and CDK | [Resources/CDK](aws-studio-knowledge/framework/resources-and-cdk.md) |
| Local runtime and containers | [Local execution](aws-studio-knowledge/runtime/local-execution.md), [Development](DEV-DEPLOYMENT.md) |
| Inputs, source values, secrets and generated client configuration | [Environment delivery](aws-studio-knowledge/runtime/environment.md), [secrets](aws-studio-knowledge/deployment/secrets.md) |
| Environments, deployment and lifecycle | [Environments](aws-studio-knowledge/deployment/environments.md), [lifecycle](aws-studio-knowledge/deployment/lifecycle.md), [planning/safety](aws-studio-knowledge/deployment/planning-and-safety.md), [operations](aws-studio-knowledge/deployment/operations.md) |
| Production execution | [Production](PROD-DEPLOYMENT.md), [release procedure](playbooks/prod-deployment.md) |
| Database and application data | [Database](DATABASE.md), [data features](DATA-FEATURES.md), [propagation contract](playbooks/typed-contract-propagation.md) |
| Authentication and authorization | [Auth checklist](playbooks/auth.md), [Cognito workspace](aws-studio-knowledge/studio/authentication.md), [identity/domain operations](framework-studio/identity-and-domains.md) |
| Workflows and agents | [Workflow semantics](aws-studio-knowledge/framework/workflows.md), [AgentCore](AGENTCORE.md), [agent/tool reference](aws-studio-knowledge/framework/agents-and-tools.md) |
| Architectural rationale | [Decision records](aws-studio-knowledge/architecture/decisions.md), [invariants](aws-studio-knowledge/reference/invariants.md) |
| Extension work | [Extension recipes](aws-studio-knowledge/guides/extensions.md), [feature build](playbooks/feature-build.md), [change impact](aws-studio-knowledge/reference/change-impact.md) |
| Shared utilities and external development dependencies | [Shared functions](SHARED-FUNCTIONS.md), [shared AWS dependencies](SHARED-AWS-DEPENDENCIES.md) |
| Troubleshooting and evidence limits | [Development troubleshooting](DEV-DEPLOYMENT.md#verification-and-troubleshooting), [verification](aws-studio-knowledge/guides/verification-and-maintenance.md), [discovery record](framework-studio/discovery-2026-10-29.md) |
| Repository cleanup, output locations and retention | [Repository hygiene](REPOSITORY-HYGIENE.md) |

The source-linked wiki owns concise subsystem contracts. Existing development,
production, database and AgentCore guides own operational procedures and fuller examples.
Studio design documents own UI conventions and design history. Cross-reference these
owners instead of copying their entire explanation into several pages.

## Studio design and operational detail

[Studio documentation](framework-studio/README.md) provides the UI-oriented entry point.
The following pages preserve deeper design and implementation detail. Validate any
version-sensitive claim against the current source-linked contract.

| Document | Role |
| --- | --- |
| [architecture](framework-studio/architecture.md) | Detailed Studio architecture; concise authority reference lives in the wiki |
| [cognito-lifecycle](framework-studio/cognito-lifecycle.md) | Cognito state retention and lifecycle |
| [cognito-workspace-2026-10-23](framework-studio/cognito-workspace-2026-10-23.md) | Cognito workspace implementation and operational detail |
| [database-workbench](framework-studio/database-workbench.md) | Prisma editing, migration planning and database execution boundaries |
| [declarations-and-tags](framework-studio/declarations-and-tags.md) | Authoring layout, metadata and tagging |
| [deploy-and-run](framework-studio/deploy-and-run.md) | Historical deployment design with pointers to current operational contracts |
| [frontend-release](framework-studio/frontend-release.md) | Reviewed frontend build, assets, publication and rollback |
| [graph-layout](framework-studio/graph-layout.md) | Graph arrangement and routing design |
| [identity-and-domains](framework-studio/identity-and-domains.md) | Federation, identity pools, diagnostics and bounded DNS operations |
| [inspector-design](framework-studio/inspector-design.md) | Inspector forms, review and disclosure conventions |
| [isometric-view](framework-studio/isometric-view.md) | Scene projection, interaction and extension details |
| [lambda-invocations-design](framework-studio/lambda-invocations-design.md) | Invocation and trigger design; verify proposal status before implementation |
| [moving-forward](framework-studio/moving-forward.md) | Contributor guidance, pitfalls and proposed extensions |
| [network-database-declarations](framework-studio/network-database-declarations.md) | Explicit VPC/database placement and identity |
| [performance](framework-studio/performance.md) | Measurement procedures and performance boundaries |
| [permissions-analysis](framework-studio/permissions-analysis.md) | Permission-evidence reasoning and limits |
| [stateful-resources](framework-studio/stateful-resources.md) | Retained resource reuse, dependency checks and lifecycle |
| [ui-design-system](framework-studio/ui-design-system.md) | Shared components, styling, accessibility and responsive conventions |

## Historical audits, campaigns and plans

These are preserved evidence, not current instructions or renewed authorization to
repeat cloud operations. Dates, commit IDs, account-specific observations and past
failures belong to the original run. The [current status](aws-studio-knowledge/reference/status.md)
resolves supported behavior; the [October 29 reconstruction](framework-studio/discovery-2026-10-29.md)
records this documentation pass. No historical report was deleted or silently rewritten
as a current test result.

- [Cognito user/group operations — campaign evidence](framework-studio/campaign-2026-10-23-cognito-operations.md)
- [Isolated development lifecycle — October 23, 2026](framework-studio/campaign-2026-10-23-dev-lifecycle.md)
- [Identity, Cognito, domains campaign evidence](framework-studio/campaign-2026-10-23-identity.md)
- [Frontend release and deployment identity campaign — 2026-10-23](framework-studio/campaign-2026-10-23-release.md)
- [SQL, database and retention campaign — 2026-10-23](framework-studio/campaign-2026-10-23-sql.md)
- [Studio execution campaign — October 23, 2026](framework-studio/campaign-2026-10-23.md)
- [AWS Studio implementation and second pass — 2026-10-22](framework-studio/implementation-second-pass-2026-10-22.md)
- [Job 3 database, persistence and recovery evidence](framework-studio/job3-database-evidence-2026-10-23.md)
- [Job 3 integration and adversarial execution — 2026-10-23](framework-studio/job3-execution-2026-10-23.md)
- [Job 3 IAM and runtime integration evidence — 2026-10-23](framework-studio/job3-iam-runtime-evidence-2026-10-23.md)
- [Job 3 independent second application evidence](framework-studio/job3-independent-pass2-2026-10-23.md)
- [Job 3 Studio browser evidence — October 23, 2026](framework-studio/job3-studio-evidence-2026-10-23.md)
- [Job 4 build and generation evidence — 2026-10-23](framework-studio/job4-build-evidence-2026-10-23.md)
- [Job 4 independent developer acceptance — 2026-10-23](framework-studio/job4-developer-acceptance-2026-10-23.md)
- [Job 4 frontend and graph evidence — 2026-10-23](framework-studio/job4-frontend-evidence-2026-10-23.md)
- [Job 4 independent performance, correctness and security review — 2026-10-23](framework-studio/job4-independent-qa-2026-10-23.md)
- [Job 4: developer acceptance and performance — October 23, 2026](framework-studio/job4-performance-2026-10-23.md)
- [Job 4 local runtime evidence — 2026-10-23](framework-studio/job4-runtime-evidence-2026-10-23.md)
- [AWS Studio product audit and implementation plan](framework-studio/product-audit-2026-10-22.md)
- [Framework Studio: what has been built, and why](framework-studio/report.md)
- [Framework Studio resource baseline — 2026-10-20](framework-studio/resource-baseline-2026-10-20.md)
- [Job 2: stateful retention and reference reuse — 2026-10-23](framework-studio/stateful-resources-job2-2026-10-23.md)
- [Tooltip information and interaction audit](framework-studio/tooltip-audit.md)

Additional historical design inputs:

- [Visual editor discovery handoff](../UNIFIED_AWS_FRAMEWORK_VISUAL_EDITOR_HANDOFF.md): original product hypotheses, without initial repository verification.
- [Isometric phase prompt](../FRAMEWORK_STUDIO_ISOMETRIC_PHASE_PROMPT.md): an earlier implementation brief, including superseded UI/history assumptions.
- [Environment-model prompt](../codex-prompt-studio-env-model.md): earlier task context; current value sources and browser tooling differ.
- [Deploy/Run M0–M1 plan](superpowers/plans/2026-10-17-deploy-run-m0-m1.md): milestone implementation plan.
- [AWS AgentCore developer reference](AWS-AgentCore-Developer-Reference.md): dated external-service background, not the framework's supported capability contract; use [AgentCore](AGENTCORE.md) for repository guidance.

## Assets, procedures and agent instructions

[Architecture artwork prompts](assets/framework-architecture-whitepaper.prompt.md),
[isometric artwork](assets/framework-architecture-isometric.prompt.md) and
[section artwork](assets/framework-sections/README.md) describe presentation assets;
source-linked Mermaid diagrams carry architectural meaning. Static artwork is not a
resource inventory or deployment diagram maintained by synthesis.

[AGENTS.md](../AGENTS.md) is the short instruction/navigation entry point. The
[build-feature](../.agents/skills/build-feature/SKILL.md) and
[propagate-contract](../.agents/skills/propagate-contract/SKILL.md) procedures have
[Claude counterparts](../.claude/skills/build-feature/SKILL.md). Follow the invoked
procedure and current application source rather than interpreting old prompts as active
instructions. Migration SQL ownership is documented [beside the SQL](../packages/database/sql/README.md).

For browser work use the [browser verification guide](../framework-studio/test/browser/README.md);
for icon provenance use the [icon README](../framework-studio/public/icons/README.md).
Knowledge maintenance and the local metadata/link checker are documented
[here](aws-studio-knowledge/guides/verification-and-maintenance.md).
