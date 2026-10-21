---
id: reference.change-impact
summary: Reverse dependency paths and coupled checks for foundational changes.
read_when:
  - Estimating the full change surface before editing shared contracts
source:
  - packages/framework/src/config/index.ts
  - framework-studio/shared/model.ts
  - packages/framework/src/deploy/identity.ts
related:
  - knowledge.architecture-map
  - guides.extensions
  - reference.invariants
---
# Change-impact graph

Read rows as **changed producer → consumers to inspect**, not a requirement to modify every consumer. The [architecture map](../ARCHITECTURE-MAP.md) gives the forward flow; [repository map](../REPOSITORY-MAP.md) locates owners. Use exact symbols from each canonical page.

| Producer changed | Dependency path / coupled checks |
| --- | --- |
| [Target normalization/identity](../framework/configuration.md) | NormalizedTarget → source origins/index → Studio nodes/lanes/edit preflight; route generation/local resolution → descriptors; CDK construct IDs/scopes → logical IDs/outputs. Check duplicate routes, shared target compatibility, mode predicates, generated contracts, runtime and synth identity |
| [Resource catalog/native public member](../framework/resources-and-cdk.md) | ResourceReference/CdkResourceGroup → links/finalization/native grants → cloud env/secret parameters; local manifest/requirements → workload startup; source capability discovery → graph evidence/triggers/Inspector. Rename field paths requires consumer/export/mapping migration, not just type fixes |
| [Editable field/domain](../studio/editing.md) | Framework setting/default → field facts/inheritance/source location → draft control/parser → semantic patch + literal splice → both-mode review → apply/undo verification. Check reset/removal, unsupported shapes and concurrent-source refusal |
| [Graph entity/relation](../studio/graph-model.md) | projectModel/shared schema → lookup/Inspector/evidence → aggregation → Board/Isometric layout weights/direction → routing/picking/focus. Check serialized compatibility, stable IDs and member-level provenance |
| [Layout/routing geometry](../studio/rendering.md) | Scene footprints/endpoints → optimizer cost/caches → routed samples → Canvas draw/picking/hover. Check consistent sampling, culling, mode-union stability and bounded work; model semantics should not move with geometry |
| [Workflow term/operation](../framework/workflows.md) | Builder → AST/normalize/validate/scopes → ASL/JSONata + local term evaluation → IAM/bindings/bridges → runner execution/callbacks → Studio graph/steps. Check both lanes and failure semantics; one compiler fixture is insufficient |
| [Agent/tool contract](../framework/agents-and-tools.md) | Contract module → generated schema/tool names → Gateway target + adapter validation → local live contract listing → agent model loop/identity/session → workflow invocation edges/IAM. Check code packaging and shared orchestration cycles |
| [Mode/target/identity](../deployment/environments.md) | Mode union/selection → input readers/bootstrap → deployment predicates/stack graph → metadata/tags/ownership → plan/apply/export/status/destroy → Studio evaluators/selectors/envfile graph. Search every dev/prod binary branch for a third mode; named staging target alone is a smaller change |
| [Secret/input lifecycle](../deployment/secrets.md) | Catalog required/default/enum → selected-file private editor → plan value comparison/binding → secret parameter/ARN → export/local manifest → Lambda reader/ECS injection; public metadata/evidence/logs need redaction checks throughout |
| [Deployment plan format/approval](../deployment/planning-and-safety.md) | Plan version/confirmation/status → saved CLI artifacts/private binding → Studio plans parser/PlanReview/fixed registry → apply staleness/identity gates → result/observer/recovery. Check old/moved/expired plans and zero writes on refusal |
| [Runner launch/build path](../runtime/local-execution.md) | Environment/fingerprint → worker/container lifecycle → declared transport → task/workflow/agent terminal state → image labels/reconciliation/Compose Watch. Check restarts, cancellation, data preservation and current/in-use image retention |

Before implementation, identify applicable [invariants](invariants.md), follow the appropriate [extension recipe](../guides/extensions.md), and select [verification](../guides/verification-and-maintenance.md). Afterward, update only the canonical pages whose contracts changed and the [capability matrix](capabilities.md) if support changed. Authorization boundaries remain separate from dependency analysis.
