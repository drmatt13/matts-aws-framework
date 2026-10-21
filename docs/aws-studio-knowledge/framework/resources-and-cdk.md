---
id: framework.resources-cdk
summary: Typed catalog descriptors resolve against native constructs at CDK finalization.
read_when:
  - Adding catalog members, native grants, resources, or bindings
  - Changing framework/application CDK boundaries
source:
  - framework-config/resources.ts
  - packages/framework/src/config/resources.ts
  - packages/framework/src/config/cdk-resources.ts
  - cdk-app/lib/framework/framework-resources.ts
  - cdk-app/bin/cdk-app.ts
related:
  - framework.configuration
  - runtime.environment
  - studio.source-indexing
---
# Resource catalog, permissions and CDK

The catalog describes what consumers need without constructing CDK or reading secret values. [resources.ts](../../../framework-config/resources.ts) uses `defineResources`, `resource.fromEnv`, `resource.secret`, and `resource.stack<T>()`. A mode-absent entry remains a typed reference but resolves to nothing; consumers must respect required/optional semantics.

| Abstraction | Implementation contract |
| --- | --- |
| `ResourceReference` | [resources.ts](../../../packages/framework/src/config/resources.ts): branded catalog path, kind, absence, fromEnv/default/required and attribute/secret projections |
| `CdkResourceGroup`, `CdkResource`, `NativeGrantBinding` | [cdk-resources.ts](../../../packages/framework/src/config/cdk-resources.ts): public stack fields project native string attributes and typed grant methods; inherited Stack fields are excluded |
| `SecretProjections` | `.arn`, `.value`, `.field(key)` distinguish ARN delivery from injected contents; [secrets](../deployment/secrets.md) owns storage/synchronization |
| Invocation bindings | `runsTask`, `startsWorkflow`, agent references declare capabilities; runtime descriptors are generated/injected, never handwritten |

In [framework-resources.ts](../../../cdk-app/lib/framework/framework-resources.ts), `initializeFrameworkResources` sets readers/identity; `linkResource` registers one native value; `linkResources(this, resources.group)` walks a stack's public fields/getters. Consumers defer attachment until `finalizeFrameworkResources`, which resolves queued references, applies native grants/triggers, and publishes metadata/resource outputs. `applyNativeGrant` invokes the native CDK grant method with the workload grantee. This is narrower and more faithful than a duplicate application permission registry.

Application stacks own native constructors/options and expose public constructs/strings/ISecret fields. The framework owns shared workload factories, reference resolution, grants, network/database attachment and runtime descriptors. [cdk-app.ts](../../../cdk-app/bin/cdk-app.ts) orders foundation/tasks/events/Cognito → custom application stacks → orchestration → routed workloads → finalization. Bind workflow integrations beside constructs before orchestration builds them. Preserve the historical `AsynchronousLambdaFunctionsStack` deployed identity.

**A catalog declaration does not instantiate a stack.** `ReferenceExampleStack` is declared in the catalog but is not instantiated in the current entry point. Source-derived members can therefore appear without deployed infrastructure. Use [synth inventory](../deployment/operations.md), not the source graph, to establish assembly contents.

`frameworkLambda` in [framework-lambda.ts](../../../cdk-app/lib/framework/framework-lambda.ts) resolves packaging/runtime and denies manual VPC/subnet/security-group options. `database: true` gives IAM database access and placement; use [network.ts](../../../framework-config/network.ts) for NAT/endpoints. Native grants and explicit IAM requirements are inputs to role construction, not a complete effective-permission viewer.

For a new family: expose/link a native public member first; add explicit framework semantics only when needed; separately extend [Studio discovery/trigger adapters](../studio/source-indexing.md). Validate with [native resource](../../../cdk-app/test/native-resources.test.ts), [stack resource](../../../cdk-app/test/stack-resources.test.ts), network/trigger tests and both synth modes. See the [extension recipe](../guides/extensions.md).
