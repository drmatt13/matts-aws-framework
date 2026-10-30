---
id: framework.configuration
summary: Literal section composition, normalized targets, stable identities, and execution lanes.
read_when:
  - Adding a workload or changing the framework DSL
  - Debugging identity or local/cloud selection
source:
  - framework.config.ts
  - framework-config/contracts.ts
  - packages/framework/src/config/index.ts
related:
  - framework.resources-cdk
  - deployment.environments
  - reference.change-impact
---
# Configuration and normalized identities

The canonical layout groups one workload module per kind under `framework-config/workloads/<kind>.ts`,
catalog descriptors under `resources/`, and reusable fragments under `shared/`. The catalog
facade remains an explicit `defineResources({ namedDescriptor, ... })` object. Each root array normally names its kind module (`http: [http]`). Grouped and
smaller literal modules remain supported through direct imports when deliberately splitting a large section;
directory depth does not define identity or registration. See the
[authoring guide](../../framework-studio/declarations-and-tags.md).

`DeclarationTags` uses ordinary string key/value metadata on each declaration; resource
factory options use `{ tags, members }`. There are no global defaults. Stack members
inherit owner tags and override keys explicitly; removing an override restores inheritance.
Routes sharing compute must agree on tags. Reserved AWS/framework namespaces and portable
AWS limits are validated before synthesis. Tags never rename targets or resolve secrets.

[framework.config.ts](../../../framework.config.ts) composes `defaults`, `networks`, `resources`, application database/user-pool references, and arrays of `http`, `webSocket`, `events`, `services`, `tasks`, `workflows`, `tools`, and `agents` modules. [contracts.ts](../../../framework-config/contracts.ts) specializes section types from the catalog and exports only types.

In [config/index.ts](../../../packages/framework/src/config/index.ts), `defineFrameworkConfig` merges sections and validates normalization eagerly. `mergeSection` detects duplicate keys before information is lost; an object spread could erase that evidence. `normalizeFrameworkConfig` / `getFrameworkTargets` give CDK, generation, runtime and Studio one target vocabulary.

| Identity | Meaning / preservation rule |
| --- | --- |
| Public path / WebSocket key | How traffic enters; may change without renaming compute |
| Target `id` / canonical `kind:id` | Shared workload identity; routed IDs derive from directory unless explicit |
| `directory` | Framework path relative to cdk-app; agents have their documented root-directory convention |
| `cloud.constructId` | Stable deployed construct identity; moving source must preserve it where appropriate |
| Stack scope + output prefix | CloudFormation logical identity and export compatibility, independent of route names |

`NormalizedTarget` records kind, role, resolved compute/settings, source origin, references and bindings. Several routes may share one compatible target; target-level settings must agree. Lambda inheritance resolves framework defaults → section defaults → workload override. Container architecture has its own defaults chain.

Every workload role accepts `deploy`, including events and tools. Events default to
both and include enabled cloud functions in both AWS modes. Tools default to consuming
agents' union, with explicit policies overriding it. Disabled events omit optional
native hooks and framework trigger descriptors; required native lookups still fail.

`isTargetEnabled` applies deploy tokens or `{ when: { resource, equals } }` to execution lanes. Conditions select declared non-secret strings from `resource.value` or `resource.fromEnv`; standalone values resolve from source, while environment-linked inputs resolve context, file and default. Optional unset inputs disable the workload. Conditional queries require explicit `DeployInputs`; generators request `"unconditioned"` supersets. `isTargetDeployed` separately applies the deployment mode: dev builds AWS-invoked event infrastructure, not the normal locally executed HTTP/task/workflow/agent fleet; prod builds cloud-enabled workloads. Event deploy policies apply in both graphs. Tools derive their default lanes from consuming agents, with explicit policies supported. WebSocket handlers deploy in both AWS graphs when enabled, and the framework builds their API when a route exists. Guard validation requires every route to fit inside `$connect` and its authorizer. These predicates are not synonyms. [Environment modes](../deployment/environments.md) owns named-target behavior.

`assertCloudEdgesResolvable` rejects cloud consumers whose required declared targets/resources cannot resolve. Source validation also checks literal routes, overlap, handler wrappers, invocation cycles, workflow semantics and runtime packaging. `npm run framework:generate` emits projections; `framework:check` detects drift and authoring violations. Neither is a live deployment check.

The application uses one shared conditional Deploy input for its WebSocket routes
and authorizer: `resources.enableWebSocketApi` is
`resource.value("true").enum("true", "false")` in
[resources/inputs.ts](../../../framework-config/resources/inputs.ts). Every handler
requires `equals: "true"`. This source-owned value has no environment-file line or
context override; use a mode-valued declaration if the two graphs should differ.
It does not add another global API Gateway flag to CDK.

Batch tooling uses `getLambdaTargets` and `createTargetArtifactValidator` from the
configuration/source entry points to resolve Lambda build settings once per
operation. Studio implementation health uses the canonical per-target tool/agent
and Cognito checks, avoiding a whole-application scan for each handler. These are
invocation-local snapshots, never a persistent cache of a mutable config. Recreate
them after edits; standalone resolution remains fresh. Local target selection and
route validation likewise use one fresh normalization. The
[artifact benchmark](../../../packages/framework/scripts/benchmark-artifacts.ts)
provides timing/CPU/RSS samples without brittle unit-test timing limits; see
[campaign evidence](../../framework-studio/job4-build-evidence-2026-10-23.md).

`createTargetAvailability` shares the exact canonical enabled/deployed predicates
within an operation. Standalone predicates remain fresh, including their existing
unknown-target behavior. Cloud selection and edge validation use one fresh target
map; no cache crosses those calls. Studio model projection uses operation-local
availability and a temporary batch of Lambda settings, restored in `finally`.

Extend a DSL field through its type, normalization/defaults, validation, CDK/local consumers, generated projections and Studio projection/editability as applicable; use [extension recipes](../guides/extensions.md). Start from existing [Framework guidance](../../FRAMEWORK.md), then use [change impact](../reference/change-impact.md). Resource references belong to [resources/CDK](resources-and-cdk.md), not new environment-specific import tables.

VPC declarations are exported `defineNetwork({ id, ... })` values, one module under
`framework-config/networks/<id>/index.ts`, registered in a literal `networks` array.
Networked Lambdas declare `vpc`; services/tasks declare `cloud.vpc`. References are
explicit, never inherited. Registration and placement import the same declaration value;
another `defineNetwork` call with matching IDs is rejected rather than silently replacing
its policy with the registry's CIDR, egress, endpoints and tags. The imported `defineDatabase` value owns its resource and VPC, allowing cross-VPC
rejection even when native RDS is absent in development.

The primary managed PostgreSQL declaration is `defineDatabase` in
[databases/application/index.ts](../../../framework-config/databases/application/index.ts).
The root selects `database: applicationDatabase`; network, subnet and PostgreSQL policy
belong to that value. Stable declaration IDs do not determine deployed RDS identities.
Existing deployment inputs/context override declared defaults. See the
[design and migration contract](../../framework-studio/network-database-declarations.md).
