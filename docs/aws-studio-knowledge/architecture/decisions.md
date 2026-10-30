---
id: architecture.decisions
summary: Reconstructed architectural decision records with rationale, consequences and source evidence.
read_when:
  - Changing a boundary or proposing a new representation of the application
source:
  - framework.config.ts
  - packages/framework/src/config/index.ts
  - packages/framework/src/config/resources.ts
  - framework-studio/server/snapshot.ts
  - framework-studio/server/edits/batch.ts
  - framework-studio/server/edits/journal.ts
  - framework-studio/src/scene/build.ts
  - scripts/deploy.ts
related:
  - architecture.contracts
  - reference.invariants
  - reference.status
---
# Architectural decision records

These records reconstruct decisions embodied in source and existing guidance as of
2026-10-29. They are not retroactive claims about an approval meeting. **Established**
means the current implementation and working rules enforce or depend on the choice.
Rationale is architectural interpretation unless explicitly attributed. Proposed
extensions remain in [status and direction](../reference/status.md).

## ADR-001 — Keep TypeScript declarations authoritative

**Status: established.** The composition root imports literal workload sections,
resources, networks and the database declaration. Framework normalization is consumed
by CDK, local execution, generators and Studio. Arrays retain duplicate-key evidence;
object spreads can erase that evidence before validation.

This makes source review and normal developer tooling available while sharing one
application contract. Studio must represent unsupported expressions honestly and refuse
edits it cannot preserve. It must not serialize the graph into a second authoritative
configuration. Generated projections are regenerated from their producers.

Evidence: [configuration](../framework/configuration.md),
[source authority](contracts.md), `defineFrameworkConfig` and
`normalizeFrameworkConfig` in [config/index.ts](../../../packages/framework/src/config/index.ts).

## ADR-002 — Model native capabilities instead of cloning the AWS catalog

**Status: established.** Symbolic catalog references expose native CDK attributes and
grant methods. Application code constructs and links resources beside their native
constructs; framework finalization resolves deferred bindings and checks dependencies.

The catalog describes what consumers can receive or do. Native construction remains
extensible and preserves stack ownership/construct identity. A reference to a value is
not automatically a permission; grants, secret delivery and database capability each
have explicit behavior. Studio discovery of a type does not imply generic CRUD support.

Evidence: [resources/CDK](../framework/resources-and-cdk.md),
[framework-resources.ts](../../../cdk-app/lib/framework/framework-resources.ts),
[resources.ts](../../../packages/framework/src/config/resources.ts).

## ADR-003 — Derive the graph and layout from semantic evidence

**Status: established.** The snapshot combines normalized dev/prod models with source
locations and bounded CDK inference. Edges retain purpose and provenance; the scene
projects islands, network placement and grouped connections. Layout identity is not
infrastructure identity. Source-mode changes reuse a shared layout basis.

The consequence is a useful architecture view without a manually maintained diagram.
Inference must remain distinguishable from declarations and observed AWS state.
Searching, filtering, panning and selecting never rewrite placement. A future manual
layout would be a view preference, not a deployment input.

Evidence: [graph model](../studio/graph-model.md),
[rendering](../studio/rendering.md),
[snapshot.ts](../../../framework-studio/server/snapshot.ts),
[scene/build.ts](../../../framework-studio/src/scene/build.ts).

## ADR-004 — Review exact source changes through bounded writers

**Status: established.** Typed drafts are planned against recognized source shapes,
validated in overlays/disposable workspaces where applicable, and reviewed before
application. Hashes and expected effects reject stale writes. The source journal
records recoverable interrupted transactions; subsequent unrelated edits must survive.

This trades arbitrary visual editing for reviewable, constrained changes. Each writer
must state its allowlist, generation needs and recovery semantics. Prisma, environment
values and operations have specialized authorities rather than a generic write-any-file
endpoint. Saved-source history belongs to Git; historical global Undo/Redo guidance is
superseded. Recovery is not a crash-proof transaction spanning AWS and local files.

Evidence: [editing](../studio/editing.md),
[batch.ts](../../../framework-studio/server/edits/batch.ts),
[transaction.ts](../../../framework-studio/server/edits/transaction.ts),
[journal.ts](../../../framework-studio/server/edits/journal.ts).

## ADR-005 — Separate mode, execution location, deployment identity and values

**Status: established.** Development and Production are binary framework modes.
Development may use local compute and AWS-managed dependencies. Named deployment
targets add explicit identity/account/region context without adding a third mode.
Inputs, public source values, secrets, runtime exports and client mappings have distinct
sources and delivery rules.

This prevents a graph switch from silently selecting a cloud target, or a generated
client file from becoming an input authority. Adding an independent mode would affect
normalization, evaluators, file selection, deployment guards and exports together.
Source values remain public; secrets cannot be smuggled through public stack strings.

Evidence: [environments](../deployment/environments.md),
[environment delivery](../runtime/environment.md), [secrets](../deployment/secrets.md).

## ADR-006 — Share execution contracts while preserving runtime differences

**Status: established.** Declared invocation bindings drive injected runtime descriptors
and cloud IAM. Workflows compile and interpret one symbolic IR; agents/tools share
contracts and local/cloud adapters. Application handlers do not choose transport by
checking the environment.

This reduces divergent application code. It does not make local Docker, child processes
or in-memory workflow histories equivalent to IAM isolation, Step Functions durability
or AgentCore runtime behavior. Explicit live evidence is still required.

Evidence: [local execution](../runtime/local-execution.md),
[workflows](../framework/workflows.md), [agents/tools](../framework/agents-and-tools.md).

## ADR-007 — Bind operational authority to reviewed effects and explicit targets

**Status: established.** Deployment uses saved assemblies, target/account/ownership
checks and reviewed fingerprints. Secret changes, database execution, identity writes,
DNS operations and frontend releases have their own review/outcome contracts. Studio
uses typed operational adapters; there is no generic shell endpoint.

A source review cannot authorize an AWS mutation. Unknown or partial outcomes must
remain visible rather than being reported as success or blindly retried. Local guards
are not distributed locks and repository wrappers cannot prevent out-of-band AWS
changes. Planning can itself have documented AWS effects, such as preparing change sets;
“plan” should not be used as a synonym for “offline.”

Evidence: [planning/safety](../deployment/planning-and-safety.md),
[operations](../deployment/operations.md),
[operational lifecycle](../deployment/lifecycle.md),
[deploy.ts](../../../scripts/deploy.ts).

## ADR-008 — Treat data and infrastructure identity as durable

**Status: established.** Target IDs, public routes, stack scopes, construct IDs and
output names are separate contracts. Stateful lifecycle uses explicit retention,
deployment evidence and resource-specific reuse. Teardown follows deployed identities
and dependencies rather than assuming current source enumerates everything deployed.

This protects upgrades and recovery when code evolves. Removing source does not
automatically remove cloud resources. Retaining infrastructure does not automatically
make it safe to reuse or restore. Preserve `postgres_data`, compare logical IDs for
infrastructure moves and inspect every resource-specific recovery precondition.

Evidence: [invariants](../reference/invariants.md),
[stateful lifecycle](../../framework-studio/stateful-resources.md),
[stateful database](../framework/stateful-database.md).

## ADR-009 — Keep Studio a local host tool and preserve extension boundaries

**Status: established.** Studio runs as a host process with React/TypeScript rendering,
Express, middleware Vite and isolated evaluator module state. Its HTTP surface uses
loopback/Host/token/origin guards. It remains optional for the framework.

The process needs local source/tool access; it is not a remote collaborative service
or a hostile-code sandbox. New resource families and UI workflows should extend existing
normalization, capability discovery, typed intents and review adapters. Remote operation
would need an explicit authentication, authorization, credential and collaboration design.

Evidence: [backend](../studio/backend.md),
[server.ts](../../../framework-studio/server/server.ts),
[moving forward](../../framework-studio/moving-forward.md),
[extension recipes](../guides/extensions.md).
