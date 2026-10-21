---
id: runtime.environment
summary: Declared resource references become scoped workload environment values and invocation descriptors.
read_when:
  - Changing workload environment injection or local/cloud parity
source:
  - packages/framework/src/local/environment.ts
  - packages/framework/src/runtime/database.ts
  - packages/framework/src/runtime/invocation.ts
  - cdk-app/lib/framework/framework-cloud.ts
  - local-invocation-runner/src/tasks.ts
related:
  - deployment.secrets
  - deployment.environments
  - framework.resources-cdk
---
# Workload environment resolution

The catalog defines references; an execution lane supplies their values. [Secrets/input storage](../deployment/secrets.md) owns authored files and deployment synchronization; this page owns delivery to a workload.

`resolveLocalWorkloadEnvironment` in [local/environment.ts](../../../packages/framework/src/local/environment.ts) finds the normalized target, starts from an allowlisted platform environment, loads selected authored local inputs and a development resource manifest, then resolves the target's declared environment/secrets/requirements. It runs before application modules read `process.env`.

| Declaration | Local delivery | Cloud delivery |
| --- | --- | --- |
| Literal or `resource.fromEnv` | Literal / selected authored input with enum/default/required rules | Deployment readers resolve selected target inputs |
| Native string attribute | Manifest keyed by canonical resource attribute; missing nonoptional reference fails | Linked native construct attribute/token |
| Secret `.arn` in Lambda environment | Manifest ARN; runtime secret reader may call AWS | Secrets Manager ARN plus read grant; contents are not embedded in the template |
| Secret `.value` / `.field` in container secrets | Raw authored secret for fromEnv; stack secret fetched once per resolution, optionally JSON field extracted | ECS secret injection from declared native/imported secret |
| `database: true` | Compose database URL and pool settings only for declared consumers | IAM database token/permissions and framework-owned VPC placement |
| Task/workflow/agent binding | Local runner descriptors with declared caller/target | AWS descriptors and narrowly derived invoke permissions |
| User-pool binding | Declared application pool references | Same application pool supplied by CDK; never paste pool IDs |

`readLocalResourceManifest` checks the exported resource document; absent/optional resources are handled deliberately. Conditional `cloud.requirements` are evaluated using the same declared references. `TRUSTED_FRONTEND_ORIGINS` has a deliberate local-browser-origin override. Dual-stack endpoint behavior derives from framework network/placement, not ad hoc application environment branches.

A task calling AWS locally declares `local: { resources: ["awsCredentials"] }`; [tasks.ts](../../../local-invocation-runner/src/tasks.ts) mounts the discovered profile directory read-only only for that local resource. [docker.ts](../../../local-invocation-runner/src/docker.ts) passes resolved environment values through the Docker CLI environment rather than value-bearing argv. The runner's Docker socket/profile mounts in [Compose](../../../docker-compose.yml) make it a trusted developer process, not a hostile-workload isolation boundary.

[runtime/database.ts](../../../packages/framework/src/runtime/database.ts) resolves IAM credentials in deployed workloads. Never deliver the database master password to a framework workload. Networking remains [framework-owned](../framework/resources-and-cdk.md); an SDK custom endpoint inside a VPC Lambda needs `useDualstackEndpoint: false` as required by the framework guide.

Common failures: stale/wrong-identity manifest, absent required catalog field, invalid enum/default, missing local secret field, unauthorized stack-secret read, undeclared invocation capability, or missing dev AWS bridge. Debug names, presence and identity first; do not print resolved environment objects or credential values.

Validate changes through framework environment/resource/runtime tests, [database runtime tests](../../../packages/framework/test/database-runtime.test.ts), [export tests](../../../cdk-app/test/environment-export.test.ts), [resource deployment tests](../../../cdk-app/test/resource-deployment.test.ts), and local worker/runner tests. Cloud grants, SDK endpoint behavior and real IAM remain separate synth/live checks.
