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
  - framework-studio/server/edits/implementation-scaffold.ts
  - framework-studio/server/edits/connections.ts
  - framework-studio/server/edits/removal.ts
  - framework-studio/server/edits/triggers.ts
  - framework-studio/server/edits/native-triggers.ts
  - framework-config/auth-providers.ts
  - cdk-app/lib/app/auth-providers.ts
  - cdk-app/lib/app/identity-pool-access.ts
related:
  - studio.editing
  - studio.source-indexing
  - framework.resources-cdk
---
# Creation and resource connections

Workload/catalog creators accept optional string key/value tags. Workloads append a literal
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

When the authorized WebSocket `$connect` handler has the same input condition in both
graphs, a new WebSocket handler's default Deploy choice is **Use $connect condition**.
Creation copies that selector and comparison into the new declaration, using its actual
catalog path and existing imports. Off remains available; incompatible local/cloud-only
choices are refused. Existing-target route aliases retain their target's settings.

Current source implements **Add to Application**, not a disabled menu. [AddMenu](../../../framework-studio/src/views/AddMenu.tsx) opens [CreationWizard](../../../framework-studio/src/views/CreationWizard.tsx); `CREATORS`, `CreationRequest` and `readCreationRequest` in [shared/creation.ts](../../../framework-studio/shared/creation.ts) define forms and server-revalidated inputs. `InspectorDraft.beginCreation` stages one complete creation; it cannot be mixed with unrelated edits in a batch.

The Cognito view's federation creator reuses this transaction for literal
`framework-config/auth-providers.ts` entries. OIDC declares/reuses a catalog secret
reference; SAML authors metadata URL and explicit claim mappings. The native existing
Cognito stack/client consumes environment-scoped entries, preserving Google/pool/client
identities. External provider configuration, secret access and actual sign-in remain
unverified until separately observed. Provider metadata reads are allowlisted and never
request secret values. See the [identity guide](../../framework-studio/identity-and-domains.md).

The Stack creator also supplies an authenticated-only identity-pool template through
native `identityPoolAccess`. Guest/classic flows are disabled, web-identity trust is
constrained by pool audience and authenticated amr, and ambiguous token role mapping
denies credentials. The default authenticated role is always permissionless. A distinct
reader role supplies the reader-group claim (precedence10) and alone receives optional
`s3:GetObject` for an explicit bucket/prefix; no listing/write/admin grants are added.
This separation preserves the missing-group boundary if Cognito falls back to its
default role. Group assignment, effective IAM and retained-resource reattachment are
separate operations; source/synth success is not runtime authorization proof.

The chooser supports arrow keys, Home/End and Escape with focus returned to its trigger.
Unavailable choices explain their configuration/validation blocker in the menu.
The Input parameters and secrets island opens the same creator as Add to application.
One form uses a Secret switch to choose an input parameter or a secret, preserving shared
settings while retaining their distinct validated source declarations. Input defaults and
allowed values apply only to parameters; no secret value is entered or written by creation.
Wizard fields keep labels, controls, helper text and validation together; tags and
list editors span the form width. Helpers remain associated when errors appear,
and all configuration controls freeze during validation, stale-source evaluation
or a source conflict. Cancel remains available for resolving a conflict. These UI
states do not change the reviewed-source transaction or deploy authorization.

`planCreation` in [edits/creation.ts](../../../framework-studio/server/edits/creation.ts) returns source overrides, expected entities/selection and impact. It does not write authored files. `assertCreationFile` allows fixed creator-owned destinations and refuses traversal/symlink components. Disposable evaluators load new proposed modules; the [transaction](editing.md) reviews, validates both modes/typechecks, applies and verifies creation.

`generateCreationArtifacts` in [creation-generation.ts](../../../framework-studio/server/edits/creation-generation.ts) copies selected source/manifests into a private preview directory, excludes authored environment values/dependencies/deployment outputs, overlays the proposal and runs the real framework generator with `--repository-root`. Its allowlisted generated outputs join the same diff/journal. New service and agent manifests also trigger an offline npm 11 lockfile-only update in the copy. Input hashes protect the review from generator-input changes. Generated files are never authored by scaffold templates or accepted as arbitrary HTTP write destinations.

| Creator | Current source behavior / boundary |
| --- | --- |
| Function / API route | Node TypeScript zip handler plus literal section and root array registration; HTTP/WebSocket/event categories. Compatible existing routed Lambda aliases are appended to the original literal section, preserving local references, imports, settings and construct identity. New WebSocket modules use `Partial<WebSocketSection>`; existing modules retain their authored type. Other runtimes/images remain manually authored |
| Stack | Application stack exposing an SQS queue or private, encrypted, retained S3 bucket, catalog type import/declaration and actual CDK entrypoint instantiation; custom members remain source-owned |
| VPC | Create an independent VPC module and registry entry. Each has its own map island and settings; prod builds it when used. Placement edits generate imported references and subnet settings together |
| Workflow | Identity workflow or initial sequence of existing event Lambdas/tasks through the existing DSL |
| Service / task | Node source, Dockerfile, declaration; service manifest and generated Compose/lock changes join the review where needed. No new arbitrary Docker execution path |
| Agent | Contract, deterministic echo starter by default or explicit model/tool loop using shared model configuration and declared existing tools, workspace manifest and TypeScript configuration; echo requires no provider/model setup |
| Agent tool | Adjacent Zod request/response/description contract and `tool` or default `authenticatedTool` wrapper, configured Lambda directory, literal tools section registration; no separate user-pool declaration |
| Input / secret | Catalog declaration and commented template keys; no authored environment values or secret provisioning |

Workload creation accepts an explicit implementation directory and create/existing-code
choice. `defaultImplementationDirectory` is shared by forms and backend. Existing code
is never overwritten; use-existing adds declarations only, then canonical artifact and
TypeScript validation checks the actual code. New agent/service manifests must match root
workspace patterns. Path authority rejects traversal and symlink components.

The target's Implementation section reports artifact diagnostics and stages the typed
`implementation` operation through the exact HTTP draft parser. Repair writes only absent
files at the configured path, previews each new file, typechecks partial scaffolds and
hash-guards existing artifact bytes. Node ZIP: `index.ts` with configured export, HTTP
JSON response/authenticated wrapper where declared, and replay wrapper where required.
Tool: `contract.ts` plus validated wrapper. Agent: echo `index.ts`, `contract.ts`, manifest
and tsconfig. ECS service: `index.mjs`, nonroot Dockerfile and local dev manifest; task:
run-to-completion `index.mjs` and Dockerfile. Unauthenticated conventional Python ZIP
repair creates `lambda_function.py`; authenticated Python/custom entry points/image
Lambda repair deliberately requires source review. Incompatible existing contract exports
produce a no-write compiler conflict, never a template overwrite.

`connections.ts` supports purpose-based database IAM/VPC placement, pool identifiers,
declared task/workflow/agent invocation and tools, catalog inputs/secrets, and native
bucket/queue grants. Imports reuse existing catalog aliases. Secret delivery follows
ARN/read for Lambda/agent and startup-value delivery for containers. Literal grants have
optional bucket key scope; disconnect matches the exact resource/method/scope and
preserves other bindings. Spreads, computed owners, commented arrays, custom grants and
ambiguous shared bindings stay source-owned. Handler authentication is separate from
providing pool identifiers.

`removal.ts` checks consumers across both modes and refuses shared implementation roots.
It reviews literal declaration removal, generated reference changes and an exact text
archive in `archived-workloads/<kind>/<id>/`; exclusive original source files are removed
only on Apply. Symlinks, env values, binary/large sets, dependencies and conflicting
archives are refused before writes. Archive source is excluded from active TypeScript
roots. Use Git to restore saved source. This never deletes already deployed infrastructure or data.

The VPC creator separates immutable `id` / `cloud.constructId` from its optional
display `name`. Changing a display name preserves deployed construct identity.
The form and server reject duplicate IDs, duplicate deployed identities, invalid
private `/16` ranges and overlapping ranges before source writes. The DSL still
permits intentionally overlapping independent VPCs; Studio refuses to introduce
one accidentally. An existing intentional overlap can keep its CIDR while other
settings change. A VPC can be removed only after workloads, the database and all
other source imports/re-exports have stopped using it. Removal reviews the registry,
import, exclusive declaration module and map descriptions together, and uses the
same conflict checks, guarded rollback as creation. Custom modules or computed
references stay source-owned and produce an actionable refusal.

Descriptions for every family use [framework-config/descriptions.ts](../../../framework-config/descriptions.ts), which the existing Inspector reads and edits. Optional input/secret consumer bindings reuse compatible catalog imports and the framework's ARN or startup-value delivery. Inputs/secrets share declarations across graphs; their authored values remain independent in each mode's protected input file. Creation refuses collisions, incompatible route reuse, nonliteral compositions and unknown references. Apply selects the created entity and saves the reviewed authored/generated artifacts; it does not deploy or start containers. Preview generation can fail when offline npm cache/workspace inputs are insufficient. Browser usability and live provisioned behavior require separate checks. The [capability matrix](../reference/capabilities.md) distinguishes implemented source paths from external validation.

Triggers are a separate change surface. [config/triggers.ts](../../../packages/framework/src/config/triggers.ts) defines `TriggerAdapterMetadata`, `defineTriggerAdapter`, `triggerAdapters`, trigger/failure-destination validation and normalization. [framework-triggers.ts](../../../cdk-app/lib/framework/framework-triggers.ts) and [framework-trigger-services.ts](../../../cdk-app/lib/framework/framework-trigger-services.ts) attach supported native integrations. Resource capabilities come from [type-aware discovery](source-indexing.md).

`validateTriggerBindings` / `planTriggers` in [edits/triggers.ts](../../../framework-studio/server/edits/triggers.ts) write declared event triggers. Failure destination and local replay changes share batch preflight; enabling replay also updates a supported handler wrapper through [local-replay.ts](../../../framework-studio/server/edits/local-replay.ts). Source-inferred native edges use `planNativeRemovals` in [native-triggers.ts](../../../framework-studio/server/edits/native-triggers.ts) only when a safe removal site is recognized. Unsupported native code is not a general CDK editor.

Validate using [creation](../../../framework-studio/test/creation.test.ts), [triggers](../../../framework-studio/test/triggers.test.ts), [removal](../../../framework-studio/test/trigger-removal.test.ts), [trigger services](../../../framework-studio/test/trigger-services.test.ts), [CDK triggers](../../../cdk-app/test/triggers.test.ts), and draft/recovery tests. Adding a resource family requires the [extension recipe](../guides/extensions.md) across framework, CDK, discovery and transformations.
