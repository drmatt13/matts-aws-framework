---
id: guides.retrieval
summary: Eight realistic tasks validate short router-to-source paths and impact awareness.
read_when:
  - Checking whether navigation supports a future engineering request
source:
  - framework-studio/server/edits/fields.ts
  - framework-studio/src/scene/routing.ts
  - packages/framework/src/config/workflow-builder.ts
  - scripts/deploy.ts
related:
  - guides.extensions
  - reference.invariants
  - reference.change-impact
---
# Retrieval validation

These are conceptual route checks, not claims that the example features were implemented or tested. Start at the [router](../README.md); the first page below is directly linked there. Usually one first page and one or two dependency pages suffice; open only the relevant recipe/section of a shared guide.

| Representative request | First → additional context | Exact source anchors | Invariants / tests to consider |
| --- | --- | --- | --- |
| Editable Lambda property | [Editing](../studio/editing.md) → [Inspector recipe](extensions.md#inspector-editable-property), source indexing if needed | `FIELDS`/`fieldFacts` in edits/fields.ts; `FieldFact`; `planEdit`; model/preflight.ts; Inspector.tsx | Authored vs inherited, safe literal edit, dual-mode preflight, identity, stale hashes; plan/splice/transaction/draft + relevant execution tests |
| New Step Functions operation | [Workflows](../framework/workflows.md) → [DSL recipe](extensions.md#workflow-dsl-operation) | workflow-builder.ts, workflow-ast.ts, workflow-validate.ts, `compileWorkflowToAsl`, local `runWorkflow`, framework-workflows.ts | Symbolic outputs, shared semantics/scopes, IAM, Standard/Express; authoring/ASL/interpreter/service-step/runner tests |
| Resource reference/native grant | [Resources/CDK](../framework/resources-and-cdk.md) → [environment delivery](../runtime/environment.md) | resources catalog; public stack field; `linkResources`, `applyNativeGrant`, `finalizeFrameworkResources` | No CDK value imports into config; actual instantiation; narrow grants; native/stack-resource/export tests and both synths |
| Deployment approval failure | [Planning/safety](../deployment/planning-and-safety.md) → [secrets](../deployment/secrets.md) if binding-related, [operations](../deployment/operations.md) if job-related | deploy.ts `prepare`/`plan`/`apply`; `confirmationLevel`; `assertDeploymentAllowed`; registry deploy-apply; PlanReview.tsx | Identity/account/ownership, exact saved assembly, staleness/typed approval, no premature writes; plan/apply/guard/secret-review/Studio plan tests |
| Isometric routing improvement | [Rendering](../studio/rendering.md) → [graph model](../studio/graph-model.md) | `routeConnections`; `measureLayout`; `optimizeLayout`; `SceneRenderer`; picking.ts | Semantic direction/member evidence, bounded work, shared route/pick geometry and stable mode switching; layout/landscape/hover tests plus browser measurements |
| Agent tool integration | [Agents/tools](../framework/agents-and-tools.md) → [local execution](../runtime/local-execution.md), resources/CDK only for grants | framework-config/workloads/tools.ts + agent tool IDs; contract.ts; runtime/tools.ts; `FrameworkAgentCore`; agent-routes.ts | Tool-derived lanes, contract/auth/session ownership, generated projection, narrow IAM; agent schema/runtime/provisioning/local E2E and separate live Gateway check |
| Third independent mode | [Environments](../deployment/environments.md) → [change impact](../reference/change-impact.md) | `DeploymentMode`, `parseTargets`, `selectTarget`, config mode predicates, CDK bootstrap, Studio `Mode`/evaluators/input files, export/destroy | Two-mode assumptions, no accidental dev/prod cross-write, ownership/secrets isolation; target/identity/isolation/export/model tests and all mode synths |
| New Add to Application flow | [Creation/connections](../studio/creation-and-connections.md) → [creator recipe](extensions.md#add-to-application-creator), [editing](../studio/editing.md) | `CreationRequest`/`CREATORS`/`readCreationRequest`; `planCreation`/`assertCreationFile`; `generateCreationArtifacts`; `BatchEditor`; CreationWizard.tsx | Fixed authority/no symlinks, preview without authored writes, generated artifacts/input hashes, expected additions/existing IDs, review/rollback; creation/draft/transaction fixtures, browser flow; deploy separate |

Each route reaches named code owners without opening unrelated deployment/rendering/runtime material. Cross-cutting [invariants](../reference/invariants.md) and [change impact](../reference/change-impact.md) are lookup references, not mandatory full reads. If a future task repeatedly needs unrelated pages, move that contract to a better canonical home or add a direct router row; do not repeat its explanation across pages.
