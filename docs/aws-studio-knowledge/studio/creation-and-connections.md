---
id: studio.creation-connections
summary: Implemented creation wizards, bounded scaffolding, trigger adapters and native connection removal.
read_when:
  - Extending Add to Application
  - Creating or modifying Lambda triggers and failure destinations
source:
  - framework-studio/shared/creation.ts
  - framework-studio/src/views/AddMenu.tsx
  - framework-studio/src/views/CreationWizard.tsx
  - framework-studio/server/edits/creation.ts
  - framework-studio/server/edits/creation-generation.ts
  - framework-studio/server/edits/triggers.ts
  - framework-studio/server/edits/native-triggers.ts
related:
  - studio.editing
  - studio.source-indexing
  - framework.resources-cdk
---
# Creation and resource connections

Every creator accepts the same optional string key/value tags. Workloads append a literal
entry to the canonical `framework-config/workloads/<section>.ts` export (`http`, `events`,
`tasks`, etc.). Existing imports, comments and fragments are preserved; the existing root
array registration remains in place. A missing kind module is created and explicitly
registered. Computed/ambiguous canonical maps receive a corrective source-owned refusal.
Developers can still deliberately compose smaller maps through root arrays. Catalog
creation writes named descriptors and explicitly composes them in `resources.ts`.
Creation tags travel through generated-source review and history.

The default catalog granularity is cohesive: new flat inputs/secrets append named exports
to `resources/inputs.ts`, and new stack descriptors append to `resources/stacks.ts`.
Existing catalog groups retain their declaring module. The explicit facade imports/composes
each public name; descriptor filenames are never public catalog identity.

Current source implements **Add to Application**, not a disabled menu. [AddMenu](../../../framework-studio/src/views/AddMenu.tsx) opens [CreationWizard](../../../framework-studio/src/views/CreationWizard.tsx); `CREATORS`, `CreationRequest` and `readCreationRequest` in [shared/creation.ts](../../../framework-studio/shared/creation.ts) define forms and server-revalidated inputs. `InspectorDraft.beginCreation` stages one complete creation; it cannot be mixed with unrelated edits in a batch.

The chooser supports arrow keys, Home/End and Escape with focus returned to its trigger.
Unavailable choices explain their configuration/validation blocker in the menu.
Wizard fields keep labels, controls, helper text and validation together; tags and
list editors span the form width. Helpers remain associated when errors appear,
and all configuration controls freeze during validation, stale-source evaluation
or a source conflict. Cancel remains available for resolving a conflict. These UI
states do not change the reviewed-source transaction or deploy authorization.

`planCreation` in [edits/creation.ts](../../../framework-studio/server/edits/creation.ts) returns source overrides, expected entities/selection and impact. It does not write authored files. `assertCreationFile` allows fixed creator-owned destinations and refuses traversal/symlink components. Disposable evaluators load new proposed modules; the [transaction](editing.md) reviews, validates both modes/typechecks, applies, verifies and makes creation undoable.

`generateCreationArtifacts` in [creation-generation.ts](../../../framework-studio/server/edits/creation-generation.ts) copies selected source/manifests into a private preview directory, excludes authored environment values/dependencies/deployment outputs, overlays the proposal and runs the real framework generator with `--repository-root`. Its allowlisted generated outputs join the same diff/journal. New service and agent manifests also trigger an offline npm 11 lockfile-only update in the copy. Input hashes protect the review from generator-input changes. Generated files are never authored by scaffold templates or accepted as arbitrary HTTP write destinations.

| Creator | Current source behavior / boundary |
| --- | --- |
| Function / API route | Node TypeScript zip handler plus literal section and root array registration; HTTP/WebSocket/event categories. Compatible existing routed Lambda aliases are appended to the original literal section, preserving local references, imports, settings and construct identity. New WebSocket modules use `Partial<WebSocketSection>`; existing modules retain their authored type. Other runtimes/images remain manually authored |
| Stack | Application stack exposing an SQS queue, catalog type import/declaration and actual CDK entrypoint instantiation; custom members remain source-owned |
| VPC | Create an independent VPC module and registry entry. Each has its own map island and settings; prod builds it when used. Placement edits generate imported references and subnet settings together |
| Workflow | Identity workflow or initial sequence of existing event Lambdas/tasks through the existing DSL |
| Service / task | Node source, Dockerfile, declaration; service manifest and generated Compose/lock changes join the review where needed. No new arbitrary Docker execution path |
| Agent | Contract, agent/module/tool loop using shared model configuration and declared existing tools, workspace manifest and TypeScript configuration; not a tool creator or arbitrary agent-language generator |
| Input / secret | Catalog declaration and commented template keys; no authored environment values or secret provisioning |

The VPC creator separates immutable `id` / `cloud.constructId` from its optional
display `name`. Changing a display name preserves deployed construct identity.
The form and server reject duplicate IDs, duplicate deployed identities, invalid
private `/16` ranges and overlapping ranges before source writes. The DSL still
permits intentionally overlapping independent VPCs; Studio refuses to introduce
one accidentally. An existing intentional overlap can keep its CIDR while other
settings change. A VPC can be removed only after workloads, the database and all
other source imports/re-exports have stopped using it. Removal reviews the registry,
import, exclusive declaration module and map descriptions together, and uses the
same conflict checks, rollback and undo/redo as creation. Custom modules or computed
references stay source-owned and produce an actionable refusal.

Descriptions for every family use [framework-config/descriptions.ts](../../../framework-config/descriptions.ts), which the existing Inspector reads and edits. Optional input/secret consumer bindings reuse compatible catalog imports and the framework's ARN or startup-value delivery. Inputs/secrets share declarations across graphs; their authored values remain independent in each mode's protected input file. Creation refuses collisions, incompatible route reuse, nonliteral compositions and unknown references. Apply selects the created entity and saves the reviewed authored/generated artifacts; it does not deploy or start containers. Preview generation can fail when offline npm cache/workspace inputs are insufficient. Browser usability and live provisioned behavior require separate checks. The [capability matrix](../reference/capabilities.md) distinguishes implemented source paths from external validation.

Triggers are a separate change surface. [config/triggers.ts](../../../packages/framework/src/config/triggers.ts) defines `TriggerAdapterMetadata`, `defineTriggerAdapter`, `triggerAdapters`, trigger/failure-destination validation and normalization. [framework-triggers.ts](../../../cdk-app/lib/framework/framework-triggers.ts) and [framework-trigger-services.ts](../../../cdk-app/lib/framework/framework-trigger-services.ts) attach supported native integrations. Resource capabilities come from [type-aware discovery](source-indexing.md).

`validateTriggerBindings` / `planTriggers` in [edits/triggers.ts](../../../framework-studio/server/edits/triggers.ts) write declared event triggers. Failure destination and local replay changes share batch preflight; enabling replay also updates a supported handler wrapper through [local-replay.ts](../../../framework-studio/server/edits/local-replay.ts). Source-inferred native edges use `planNativeRemovals` in [native-triggers.ts](../../../framework-studio/server/edits/native-triggers.ts) only when a safe removal site is recognized. Unsupported native code is not a general CDK editor.

Validate using [creation](../../../framework-studio/test/creation.test.ts), [triggers](../../../framework-studio/test/triggers.test.ts), [removal](../../../framework-studio/test/trigger-removal.test.ts), [trigger services](../../../framework-studio/test/trigger-services.test.ts), [CDK triggers](../../../cdk-app/test/triggers.test.ts), and draft/undo tests. Adding a resource family requires the [extension recipe](../guides/extensions.md) across framework, CDK, discovery and transformations.
