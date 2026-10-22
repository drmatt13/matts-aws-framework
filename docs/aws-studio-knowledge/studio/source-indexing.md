---
id: studio.source-indexing
summary: Connect evaluated entities to editable TypeScript and conservatively inferred CDK evidence.
read_when:
  - Adding source transformations, source evidence, or resource discovery
  - Explaining a read-only field or missing inferred edge
source:
  - framework-studio/server/source/index.ts
  - framework-studio/server/source/capabilities.ts
  - framework-studio/server/source/cdk-links.ts
  - packages/framework/scripts/config-source.ts
related:
  - studio.editing
  - studio.graph-model
  - framework.resources-cdk
---
# Source locations, capability discovery and evidence

Catalog shorthand and named relative descriptor imports resolve to their owning const,
including cohesive one-level catalog namespaces. The default `workloads/<kind>.ts` layout is an
authoring convention, not a section-discovery or module-depth restriction. Independently
imported network/database literals remain source-located without using directory depth as
write authority. Tag writes remain restricted to the root and `framework-config` TypeScript.
Tag editability requires literal string maps and unambiguous ownership; computed values,
spreads and comment-sensitive replacements provide source links and corrective refusals.
Catalog members' source files identify where their descriptors were authored, not where
the composed `resources` catalog is exported. Trigger, failure-destination and requirement
edits derive catalog imports from the located root `resources` property; never infer that
module from the first member or its ordering.

Evaluation answers what a declaration means; the source index answers where it was authored and whether a narrow transformation is safe. `buildSourceIndex` / `SourceFiles` in [source/index.ts](../../../framework-studio/server/source/index.ts) combine normalized origins with parsed TypeScript and overlay contents. `locateConfigSource` in [config-source.ts](../../../packages/framework/scripts/config-source.ts) follows supported imports/aliases and literal section composition.

Per-entity tag editability reuses the current index's located configuration and catalog;
it must not rewalk and reparse the entire catalog for every member. These discovery
results live only for that index. Source planning resolves each changed overlay afresh,
so offsets and ownership never come from an earlier draft.

Native VPC evidence and VPC removal share relative-module matching in
[networks.ts](../../../framework-studio/server/source/networks.ts). It recognizes emitted
`.js` import paths that refer to TypeScript declarations, as well as extensionless imports.
The removal scan treats imports, re-exports and literal dynamic references as consumers;
disabled or source-only consumers still block deletion.
The framework's locator indexes only exported `const` VPC declarations calling the real
`defineNetwork` helper, including official import aliases and namespace imports. Custom
wrappers and unrelated same-named functions stay source-owned.

`fieldEditability` compares actual authored expressions against the evaluated setting. Computed expressions, ambiguous spreads, unsupported wrappers and comment-sensitive edits can be read-only even when their values normalize successfully. Do not replace a computed declaration merely because the Inspector can display its effective value.

| Source analysis | Owner / evidence strength |
| --- | --- |
| Catalog and public members | [catalog.ts](../../../framework-studio/server/source/catalog.ts): type-only stack imports, catalog paths, field declarations and native link sites |
| Trigger/resource capability | `discoverCapabilities` in [capabilities.ts](../../../framework-studio/server/source/capabilities.ts): TypeScript program resolves official CDK type symbols, inheritance and adapter metadata; not class-name string guessing |
| Stack instantiation | [stack-usage.ts](../../../framework-studio/server/source/stack-usage.ts): source evidence of application constructor usage; not CloudFormation observation |
| Native relationship inference | `scanCdkLinks` in [cdk-links.ts](../../../framework-studio/server/source/cdk-links.ts): supported direct constructors/aliases and native S3/SQS/SNS/DynamoDB/Cognito/EventBridge patterns |
| Safe evidence snippets | `sourceEvidence` in [evidence.ts](../../../framework-studio/server/source/evidence.ts): strips comments/redacts literal/template/regex contents while retaining structural names |

CDK inference deliberately skips unsupported loops, conditions, helper indirection and dynamic expressions. A missing edge is not proof of absence. A source-supported edge is not proof that its stack is constructed or deployed. Edges retain provenance and supported-removal metadata; arbitrary native statements must remain source-owned. [Graph model](graph-model.md) owns how those distinctions reach the UI.

Extend discovery when a real source shape/resource family is needed; add positive and refusal fixtures together. Do not broaden the writable-file allowlist to compensate for an unresolved source location. New native trigger semantics also need framework adapter/CDK support, not just an inferred visual wire; see [creation/connections](creation-and-connections.md).

Tests: [CDK links](../../../framework-studio/test/cdk-links.test.ts), [stack usage](../../../framework-studio/test/stack-usage.test.ts), [evidence](../../../framework-studio/test/evidence.test.ts), framework [config source](../../../packages/framework/test/config-source.test.ts). [Editing](editing.md) consumes locations; [snapshots](snapshots.md) consumes the index and exposes diagnostics.
