---
id: reference.capabilities
summary: Implemented, bounded, manual, and externally unverified capability surfaces.
read_when:
  - Determining what Studio/framework actually supports before proposing a change
source:
  - framework-studio/src/views/AddMenu.tsx
  - framework-studio/server/edits/creation.ts
  - framework-studio/server/deploy/registry.ts
  - packages/framework/src/config/index.ts
related:
  - studio.creation-connections
  - deployment.operations
  - guides.maintenance
---
# Capability matrix

Source reviewed 2026-10-29, including existing working-tree input/client changes. **Implemented** describes a code path, not successful Docker/live-AWS validation. The [discovery record](../../framework-studio/discovery-2026-10-29.md) records this pass’s browser and documentation checks; dated campaign reports preserve earlier fixture/live evidence. Use linked pages for exact symbols/tests and current boundaries.

| Surface | Status | Boundary / canonical page |
| --- | --- | --- |
| Typed framework declarations, normalization, generation | Implemented | Literal sections; shared validation/identities; [configuration](../framework/configuration.md) |
| Native resource attributes/grants | Implemented | Public linked CDK fields; required references must resolve; [resources/CDK](../framework/resources-and-cdk.md) |
| Map / Isometric source graph | Implemented; Board is unrouted | Evaluated declarations plus bounded inference, not live topology; [graph](../studio/graph-model.md), [rendering](../studio/rendering.md) |
| Inspector settings/defaults/routes | Implemented, bounded | Recognized fields/source shapes; reviewed source transformations; [editing](../studio/editing.md) |
| Multi-file edit and recovery | Implemented, bounded | Batch source application has a durable recovery journal; saved-source history belongs to Git. Recovery preserves subsequent edits; specialized editors retain their own boundaries; [editing](../studio/editing.md) |
| General arbitrary code/CDK editing | Not implemented as a general UI editor | Narrow splices/native removals/creator scaffolds do not establish arbitrary editing |
| Add to Application / implementation repair | Implemented, bounded | Function, tool, stack, independent VPC, workflow, service, task, route, agent, input, secret and authentication-provider creators; configured paths, fixed runnable templates, missing-file repair and reviewed generated artifacts; [creation](../studio/creation-and-connections.md) |
| Workload connections / removal | Implemented for supported literal declarations | Database, user pool, task, workflow, agent, tool, input/secret and scoped bucket/queue adapters; removal checks consumers and reviews an implementation archive. Arbitrary code and native resource CRUD remain source-owned; [creation](../studio/creation-and-connections.md), [extensions](../guides/extensions.md) |
| Triggers/failure destinations/native edge removal | Implemented for supported adapters/source shapes | Capability/type compatibility and safe removal evidence required; [connections](../studio/creation-and-connections.md) |
| Database schema and migration workbench | Implemented, bounded | Schema source review, offline migration planning, explicit read-only inspection and separately authorized database application. Production requires a deployed protocol-capable private IAM migration task; [database workbench](../../framework-studio/database-workbench.md) |
| Standalone public source parameters | Implemented in current checkout | `resource.value` has no env override; reviewed conversion to/from linked inputs and derived client availability; [environment](../runtime/environment.md) |
| Input/secret declaration and protected value editing | Implemented, bounded | Fixed mode files/private details/redacted reviews; provisioning separate; [secrets](../deployment/secrets.md) |
| Unified Cognito workspace | Implemented | Nested User Pools, Identity Pools, Providers and Permissions routes; compatible identity-pool bookmarks, shared environment/inspection context and retained subsection state. Source-only, deployed, secret, provider-side, sign-in and simulation evidence stay distinct; [authentication](../studio/authentication.md) |
| Cognito federation and identity-pool source | Implemented, bounded | OIDC/SAML literal declarations and declared-secret references; authenticated-only identity-pool stack with constrained trust and optional explicit S3 object reads. Reviewed source uses existing batch/journal; custom policy editing and user/group membership remain source/operations work. [Identity guide](../../framework-studio/identity-and-domains.md) |
| Cognito/identity-pool deployed diagnostics | Implemented read-only; external behavior unverified | Owned-stack physical IDs, user paging/search, groups, app clients, provider metadata and role mappings. No secret-value reads; provider-side sign-in and effective IAM remain separate. [Identity guide](../../framework-studio/identity-and-domains.md) |
| Cognito user/group operations | Implemented, bounded; live destination unverified | Owned-pool review/apply for suppressed user creation, roleless group creation, membership and enable/disable. Exact operation/target approval plus separate production authorization, fingerprint recheck and redacted durable unknown outcomes; no password/reset/delete-user surface or automatic write retries. [Identity guide](../../framework-studio/identity-and-domains.md) |
| Production domain intent, live health and managed DNS | Implemented, bounded; live AWS write unverified | Existing `.env.prod` inputs; ACM metadata, DNS/TLS/HTTP/HTML observations with public-address pinning. Explicit owned deployed target/public delegated zone/simple non-apex CNAME review/apply, exact atomic replacement, drift checks and durable unconfirmed receipts without retries. Apex/alias/advanced records and certificate-validation writes remain manual. HTTP success and Route53 INSYNC do not prove application/sign-in health. [Identity guide](../../framework-studio/identity-and-domains.md) |
| Reviewed deployment, typed approval and ownership | Implemented | Saved assembly, fingerprints, account/identity and exact secret-write binding; [planning](../deployment/planning-and-safety.md) |
| Staging | Named target using dev/prod semantics | No third mode/promotion pipeline; Studio graph remains binary; [environments](../deployment/environments.md) |
| CF status/events/drift, synth inventory | Implemented | Observed vs synthesized vs source evidence kept separate; [operations](../deployment/operations.md) |
| Deployed-stack teardown | Implemented, guarded | Immutable deployed identities and reviewed template/import/protection evidence; unreadable evidence blocks. Rechecks between dependency phases; current declarations are not the deletion target; [planning](../deployment/planning-and-safety.md) |
| Source freshness and map discovery | Implemented | Visible watch degradation, polling fallback and manual reload; searchable resource navigator and source-artifact warnings. These are declaration checks, not running-service health; [snapshots](../studio/snapshots.md), [rendering](../studio/rendering.md) |
| Deployment/job logs and local Docker logs | Implemented | Job stream/replay and bounded per-container fetch; [operations](../deployment/operations.md) |
| CloudWatch application log/metric/trace explorer | Not implemented in Studio operational paths | CDK log groups and CloudFormation events are different capabilities; [operations](../deployment/operations.md) |
| Node zip / container Lambda / services / tasks locally | Implemented | Node workers or Docker; Python zip local lane not implied; local trust/credentials differ; [local](../runtime/local-execution.md) |
| Workflow compiler + local interpreter | Implemented for declared IR | Real service/bridge calls possible; no Step Functions durability locally; [workflows](../framework/workflows.md) |
| Agent Runtime/Gateway provisioning and local sessions | Implemented; external integration partly unverified | Shared contracts/local E2E; Runtime/Gateway/CloudFront behavior needs live evidence listed in existing guide; [agents](../framework/agents-and-tools.md) |
| Fully offline application emulation | Not provided | Cognito/replay/secrets/models/AWS integrations may be real services; [local](../runtime/local-execution.md) |

Do not infer capabilities from menu labels, CDK resource presence or local logs. Follow [maintenance](../guides/verification-and-maintenance.md) whenever support changes, and keep the implementation boundary separate from browser/live-service verification.
