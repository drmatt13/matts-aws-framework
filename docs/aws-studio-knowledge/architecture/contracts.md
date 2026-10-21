---
id: architecture.contracts
summary: Authority, derived representations, execution boundaries, and authentication boundaries.
read_when:
  - Deciding which representation to change or trust
source:
  - framework.config.ts
  - framework-studio/shared/model.ts
  - packages/framework/package.json
related:
  - framework.configuration
  - studio.graph-model
  - reference.invariants
---
# Sources of truth and boundaries

| Representation | Owns | Does not establish |
| --- | --- | --- |
| `framework-config/` + root composition | Workload declarations, bindings, shared defaults and resource references | Whether a referenced application stack was instantiated |
| Application CDK + framework factories | Native constructs, linked catalog members, generated CloudFormation | Actual deployed state or external service success |
| `contract.prisma`, handlers, tool/agent contracts | Storage and executable application behavior/payloads | Automatic GraphQL exposure or record authorization |
| Generated contracts/Compose projections | Consumer-specific views of authored declarations | Independent editable configuration |
| Studio `Snapshot` / source index | Evaluated dev/prod graphs, source locations, evidence and diagnostics | Complete IAM policy, arbitrary CDK execution, live AWS topology |
| Saved deployment assembly/plan | The exact synthesized templates reviewed for an apply | Drift-free infrastructure or predictable custom-resource side effects |
| CloudFormation observation/export | Observed stack identity/status and published runtime values | A replacement for authored source |

The central path is **declaration → normalize/validate → consumer projection**. [Configuration](../framework/configuration.md) owns normalization; [graph model](../studio/graph-model.md) owns Studio's serialized view. Update the producer and run its generator instead of patching a generated consumer.

`@repo/framework` has explicit config, runtime, local and source-discovery entry points with no package-root barrel. Config remains browser-safe; CDK types enter catalog/contracts through `import type`. Backend runtime helpers must not import the entire configuration machinery. Browser application code consumes `@repo/api-contract`, not local/runtime modules. See [package exports](../../../packages/framework/package.json) and [entry-point tests](../../../packages/framework/test/entry-points.test.ts).

Studio's loopback/token guard protects a trusted local editing tool. Application authentication is a different boundary: shared Cognito ID-token verification, route/agent authorizers, and explicit per-record authorization in GraphQL. An HTTP handler requiring a session uses `authenticated(...)` and declares `userPool: true`; route `auth` and record access still need their own checks. Consult the [auth checklist](../../playbooks/auth.md) before changing any coupled surface.

Local child processes/evaluators share host trust and credentials; they isolate module state/lifecycle, not hostile code. Local managed-service integrations can call AWS. [Local execution](../runtime/local-execution.md) and [environment delivery](../runtime/environment.md) define those limits.

For changes crossing representations, follow [change impact](../reference/change-impact.md) and preserve the [invariants](../reference/invariants.md). Source inspection proves an implementation path; focused tests prove selected behavior; live integrations require separate evidence.
