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

Source inspected 2026-10-20. **Implemented** describes a code path, not successful browser/Docker/live-AWS validation in this documentation task. Use linked pages for exact symbols/tests and current boundaries.

| Surface | Status | Boundary / canonical page |
| --- | --- | --- |
| Typed framework declarations, normalization, generation | Implemented | Literal sections; shared validation/identities; [configuration](../framework/configuration.md) |
| Native resource attributes/grants | Implemented | Public linked CDK fields; required references must resolve; [resources/CDK](../framework/resources-and-cdk.md) |
| Board / Isometric source graph | Implemented | Evaluated declarations plus bounded inference, not live topology; [graph](../studio/graph-model.md), [rendering](../studio/rendering.md) |
| Inspector settings/defaults/routes | Implemented, bounded | Recognized fields/source shapes; reviewed source transformations; [editing](../studio/editing.md) |
| Multi-file edit, undo/redo | Implemented, bounded | In-memory history; guarded restoration, no crash-atomic/durable transaction; [editing](../studio/editing.md) |
| General arbitrary code/CDK editing | Not implemented as a general UI editor | Narrow splices/native removals/creator scaffolds do not establish arbitrary editing |
| Add to Application | Implemented in current source | Function, stack, shared VPC, workflow, service, task, route, agent, input, secret wizards; fixed templates/options and reviewed batch; [creation](../studio/creation-and-connections.md) |
| Arbitrary resource CRUD / new tool wizard | Not provided by current creators | Native family support/handwritten tools may exist independently of creator UI; [extensions](../guides/extensions.md) |
| Triggers/failure destinations/native edge removal | Implemented for supported adapters/source shapes | Capability/type compatibility and safe removal evidence required; [connections](../studio/creation-and-connections.md) |
| Database schema visualization | Implemented read-only | Parses contract/Compose; no live introspection/migration editor; [graph](../studio/graph-model.md) |
| Input/secret declaration and protected value editing | Implemented, bounded | Fixed mode files/private details/redacted reviews; provisioning separate; [secrets](../deployment/secrets.md) |
| Reviewed deployment, typed approval and ownership | Implemented | Saved assembly, fingerprints, account/identity and exact secret-write binding; [planning](../deployment/planning-and-safety.md) |
| Staging | Named target using dev/prod semantics | No third mode/promotion pipeline; Studio graph remains binary; [environments](../deployment/environments.md) |
| CF status/events/drift, synth inventory | Implemented | Observed vs synthesized vs source evidence kept separate; [operations](../deployment/operations.md) |
| Deployment/job logs and local Docker logs | Implemented | Job stream/replay and bounded per-container fetch; [operations](../deployment/operations.md) |
| CloudWatch application log/metric/trace explorer | Not implemented in Studio operational paths | CDK log groups and CloudFormation events are different capabilities; [operations](../deployment/operations.md) |
| Node zip / container Lambda / services / tasks locally | Implemented | Node workers or Docker; Python zip local lane not implied; local trust/credentials differ; [local](../runtime/local-execution.md) |
| Workflow compiler + local interpreter | Implemented for declared IR | Real service/bridge calls possible; no Step Functions durability locally; [workflows](../framework/workflows.md) |
| Agent Runtime/Gateway provisioning and local sessions | Implemented; external integration partly unverified | Shared contracts/local E2E; Runtime/Gateway/CloudFront behavior needs live evidence listed in existing guide; [agents](../framework/agents-and-tools.md) |
| Fully offline application emulation | Not provided | Cognito/replay/secrets/models/AWS integrations may be real services; [local](../runtime/local-execution.md) |

Do not infer capabilities from menu labels, CDK resource presence or local logs. Follow [maintenance](../guides/verification-and-maintenance.md) whenever support changes, and keep the implementation boundary separate from browser/live-service verification.
