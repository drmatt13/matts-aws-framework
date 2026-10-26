---
id: guides.extensions
summary: Safe extension recipes for Inspector fields, workflow operations, resource families and creators.
read_when:
  - Implementing a framework or Studio capability beyond current contracts
source:
  - framework-studio/server/edits/fields.ts
  - framework-studio/server/model/preflight.ts
  - packages/framework/src/config/workflow-builder.ts
  - packages/framework/src/config/triggers.ts
  - framework-studio/shared/creation.ts
related:
  - studio.editing
  - framework.workflows
  - framework.resources-cdk
---
# Extension recipes

Extend an existing producer/consumer chain instead of adding a parallel registry. Start with [change impact](../reference/change-impact.md); each recipe names its canonical contract and test surface.

## Inspector-editable property

1. Read [editing](../studio/editing.md), `FIELDS`/`FieldDefinition` in [fields.ts](../../../framework-studio/server/edits/fields.ts), `FieldFact` in [model.ts](../../../framework-studio/shared/model.ts), and the existing Inspector control in [Inspector.tsx](../../../framework-studio/src/views/Inspector.tsx).
2. If new to the framework, add its declared/normalized type, defaults/domain, local behavior and CDK behavior first. If already implemented, reuse its resolved value.
3. Add field parse/validation, source path, semantic patch and inherited/default facts. Check [preflight.ts](../../../framework-studio/server/model/preflight.ts), [source field editability](../../../framework-studio/server/source/index.ts), and [planEdit](../../../framework-studio/server/edits/plan.ts). Preserve absence/reset semantics and supported literal shapes.
4. Reuse `InspectorDraft` and batch review/apply; add a control only if existing generic controls cannot express the domain.
5. Test valid/invalid/reset/inherited values, unsafe expression refusal, both-mode differences, exact diff, stale-source zero writes, apply and undo. Use Studio plan/splice/transaction/draft suites plus framework/CDK tests if execution changes.

## Workflow DSL operation

Read [workflow semantics](../framework/workflows.md). Add the builder API and structured AST/terms; update normalization, validation/scoping and supported documents/inspection. Compile ASL/JSONata in [workflow-asl.ts](../../../packages/framework/src/config/workflow-asl.ts), interpret the same semantics in [workflow-interpreter.ts](../../../packages/framework/src/local/workflow-interpreter.ts), and add runner/integration execution only when needed. Update CDK binding/IAM derivation and development bridges for service integrations. Project new graph edges/Inspector steps as applicable. Test authoring errors, ASL, local success/failure/retry/callback semantics and packaging/synth; don't implement only one lane or evaluate arbitrary JavaScript locally.

## Resource family / native grant / trigger

Read [resources/CDK](../framework/resources-and-cdk.md). Public native stack members already derive attributes and grant methods; a catalog/link addition often needs no framework family enumeration. For new event semantics extend `defineTriggerAdapter` metadata/validation in [config/triggers.ts](../../../packages/framework/src/config/triggers.ts), native attachment in [framework-triggers.ts](../../../cdk-app/lib/framework/framework-triggers.ts) / service helpers, and [Studio capability discovery](../studio/source-indexing.md). Add safe source transformations/removal evidence only for recognized shapes. Include incompatible-resource, ambiguous/dynamic-source and unchanged-logical-ID fixtures. Do not equate native type discovery with generic CRUD support.

## Add to Application creator

Read [creation/connections](../studio/creation-and-connections.md). Extend `CreationRequest`, `CREATORS` and `readCreationRequest` in [shared/creation.ts](../../../framework-studio/shared/creation.ts), menu/wizard fields, and `planCreation` in [edits/creation.ts](../../../framework-studio/server/edits/creation.ts). Return fixed-destination overrides and expected identities; preserve the existing batch authority/preflight/history. Proposed modules must evaluate without writing into the authored checkout. Run required generators in the private preview and include their allowlisted artifacts in review/rollback; extend [creation-generation.ts](../../../framework-studio/server/edits/creation-generation.ts) only for actual generator-owned outputs. Test collisions, path/symlink refusal, dual-mode additions, existing identities, generation/input hashes, diff/apply/undo/reapply, concurrent file creation and failed post-write verification. Provisioning/secret values remain separate. Arbitrary code editing is outside this creator contract.

After implementing, update [capabilities](../reference/capabilities.md), affected [invariants](../reference/invariants.md), and canonical pages using [maintenance](verification-and-maintenance.md). Follow the existing required generators and verify sequence; no generated file hand edits.
