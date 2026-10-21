---
id: reference.invariants
summary: Engineering invariants with enforcement locations and explicit limits.
read_when:
  - Assessing a change to identity, source authority, security or execution contracts
source:
  - AGENTS.md
  - packages/framework/src/config/index.ts
  - framework-studio/server/edits/batch.ts
  - scripts/deployment-guard.ts
  - scripts/deployment-secrets.ts
related:
  - architecture.contracts
  - reference.change-impact
  - guides.maintenance
---
# Architectural invariants

**Enforced** means the named implementation checks the supported path. **Rule** requires author discipline/review as well. **Partial** names a deliberate boundary, not a global guarantee.

| Property | Enforcement / rule | Limit and canonical context |
| --- | --- | --- |
| Authored source is authoritative | Enforced path: evaluation/projection from config; visual apply writes source. Rule: regenerate projections, never hand-edit them | Source graph is not live AWS truth; [authority](../architecture/contracts.md) |
| Literal sections retain duplicate evidence | Enforced normalization/source checks; rule: compose arrays, type-only catalog/contract imports | Executable computed config may display while remaining uneditable; [configuration](../framework/configuration.md) |
| Routes, target IDs and construct identity are distinct | Normal edit preflight preserves targets/construct IDs; creation checks expected additions and existing identities | Source/CDK moves also require logical-ID comparison; preserving target ID alone is insufficient; [resources/CDK](../framework/resources-and-cdk.md) |
| Visual edits validate and review before write | `InspectorDraft`, `EditService`, `BatchEditor`, field domains, dual-mode evaluator, relevant TS checks | Not a general TypeScript editor or proof of deployability; [editing](../studio/editing.md) |
| Stale drafts/reviews do not silently overwrite | Revision/hash checks, expected per-file contents, exclusive creation, guarded restoration/undo | Partial: no crash-atomic multi-file transaction or external-editor compare-and-swap rename; history is in memory; [editing](../studio/editing.md) |
| Evidence strength survives visualization | `ModelEdge.provenance`, snippets/removal facts, connection member aggregation | Inference is conservative; no edge is not proof of no dependency; [source indexing](../studio/source-indexing.md), [graph](../studio/graph-model.md) |
| Required catalog references resolve in relevant lanes | Normalization/cloud-edge checks, resource finalization and local manifest/requirement checks | Catalog-only stack can remain uninstantiated until referenced/synthesized; [resources/CDK](../framework/resources-and-cdk.md) |
| Environment/ownership boundaries precede cloud writes | Target-mode agreement, assembly identity, STS account, `assertDeploymentAllowed`, secret ownership checks | Local locks do not coordinate machines; wrapper bypass is outside enforcement; [planning/safety](../deployment/planning-and-safety.md) |
| Apply uses reviewed deployment artifacts | Saved assembly digest, stack fingerprints, available change sets, expiry/confirmation and private secret binding | Partial: no complete drift proof, conditional secret put or CloudFormation/secret atomicity; [planning](../deployment/planning-and-safety.md), [secrets](../deployment/secrets.md) |
| Public metadata excludes resolved secret values | Input metadata projection, redacted reviews/evidence, private plan/value handling and binding storage | Rule: never author secrets into literals/public stack strings. Protected selected-detail APIs intentionally return values; no hostile-repo isolation guarantee; [secrets](../deployment/secrets.md) |
| Database/network access is declarative | `database: true` → IAM/placement, framework Lambda option restrictions, network catalog and local scoped injection | Rule: no manually supplied DB password/VPC overrides. Local egress guards are not IAM/firewall isolation; [environment](../runtime/environment.md) |
| Runtime invocation follows declared capabilities | Injected runTask/startWorkflow/invokeAgent descriptors; local caller checks and derived cloud IAM | Accepted request is not terminal success; local profile can exceed role permissions; [local execution](../runtime/local-execution.md) |
| Workflow values remain symbolic | Builder/validator/static authoring checks; shared IR compiler/interpreter | Rule: no JavaScript control/coercion/await on outputs. Shared IR does not reproduce cloud durability; [workflows](../framework/workflows.md) |
| Agent contracts and session ownership are shared | Contract wrappers, generated projection, adapter, local Gateway/session checks | IAM, Runtime isolation and actual managed-service integration need live evidence; [agents/tools](../framework/agents-and-tools.md) |
| Docker cleanup preserves current/in-use/data | Label-scoped image janitors and unforced removal; rule: preserve postgres_data and image-owned deps | Never broad system/image/builder prune or forced image removal; [local execution](../runtime/local-execution.md) |
| Browser/build contracts stay compatible | Rule: same-origin `/api`, Vite `base=/`, Rust-free Prisma runtime and root esbuild pin | Follow [Framework](../../FRAMEWORK.md) before changing transport/bundling; these are not Studio-only preferences |
| Workspaces/generated/native bindings stay coherent | `verify`, generator checks and lockfile platform checks; rule: npm 11 for lock changes | Offline verification doesn't establish browser/Docker/AWS behavior; [maintenance](../guides/verification-and-maintenance.md) |

For changes, trace [change impact](change-impact.md), then update the specific canonical contract and its refusal tests. Do not weaken an enforcement gate to make a fixture pass without addressing the property it protects.
