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

`resources.ts` explicitly composes imported descriptor constants from cohesive modules
under `framework-config/resources/`. Source indexing follows those constants to their
owning declarations; public catalog names and native link sites remain stable. Type-only
stack imports still keep evaluation browser-safe.

Tags follow ownership rather than consumer traversal. Stack descriptors carry `tags` and
typed `members: { field: { tags } }` overrides; references and public string values retain
metadata without independent AWS tagging. Imported constructs are not retagged. Owned
compute/network/native subtrees use CDK tagging, preserving deployment ownership keys.
The database declaration owns final overrides on its primary resource. Conflicting aliases
must fail instead of choosing import order. The
[tag guide](../../framework-studio/declarations-and-tags.md) describes limits and unsupported
cases; saving tags never calls AWS or deploys.

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

`frameworkLambda` in [framework-lambda.ts](../../../cdk-app/lib/framework/framework-lambda.ts) resolves packaging/runtime and denies manual VPC/subnet/security-group options. `database: true` gives IAM database access and placement; use [network declarations](../../../framework-config/networks/application/index.ts) for NAT/endpoints. Native grants and explicit IAM requirements are inputs to role construction, not a complete effective-permission viewer.

When no VPC placement is selected, the factory explicitly synthesizes empty
subnet/security-group lists and `Ipv6AllowedForDualStack: false`. This clears
previously enabled IPv6 when the same function moves to `subnet: "none"`;
omitting `VpcConfig` can fail that update. The common factory covers Node/Python
zip and container packaging without changing construct identities or adding VPC
permissions. Application declarations still own placement; no application-level
CDK override is required. AWS documents detachment with empty lists and limits
outbound IPv6 to VPC functions in its [Lambda VPC guide](https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc.html).

Detachment does not synchronously remove Hyperplane ENIs. AWS uses the creator
function's execution-role permissions for cleanup; deleting that role too early
can leave unused interfaces behind. The Lambda VPC guide above describes manual
removal in this case. Studio's stack teardown does not automatically remove these
orphan interfaces. Job 3 observed this after a VPC-to-none update followed by
teardown; interface cleanup requires separate verification of exact ownership,
remaining function/version/mapping use and released interface state, rather than
name-prefix deletion or forced detachment.

For a new family: expose/link a native public member first; add explicit framework semantics only when needed; separately extend [Studio discovery/trigger adapters](../studio/source-indexing.md). Validate with [native resource](../../../cdk-app/test/native-resources.test.ts), [stack resource](../../../cdk-app/test/stack-resources.test.ts), network/trigger tests and both synth modes. See the [extension recipe](../guides/extensions.md).

Native VPC-backed resources use `frameworkVpc(this, importedVpc)`. Network state,
security groups, ECS clusters and API VPC links are per VPC. `NetworkStack` retains
historical scopes; other construct identities get stable namespaces. Unused declarations
build nothing. CDK checks actual database placement against its declared VPC.

`defineDatabase` owns primary PostgreSQL placement and default infrastructure policy,
while `RdsStack` preserves all native construct scopes and resource links. Optional
replicas, Multi-AZ and Proxy remain settings rather than new identity schemes. Complete
template comparisons in [database-topology.test.ts](../../../cdk-app/test/database-topology.test.ts)
protect the writer, replicas, Proxy, bootstrap and output identities. Studio edits typed
declaration settings through [database.ts](../../../framework-studio/server/edits/database.ts).
Its separate placement operation edits the literal database and all normalized framework
consumer VPC references together, retaining subnet tiers and native CDK identities.
It never moves data or deploys RDS; deployed moves require migration/cutover planning.
IAM-only workload login, local Compose parity and `database: true` are unchanged.
