---
id: reference.glossary
summary: Repository-specific architecture vocabulary and distinctions.
read_when:
  - Resolving overloaded terms such as mode, target, resource, plan, or graph
source:
  - packages/framework/src/config/index.ts
  - packages/framework/src/deploy/identity.ts
  - framework-studio/shared/model.ts
related:
  - framework.configuration
  - deployment.environments
  - studio.graph-model
---
# Glossary

| Term | Meaning here |
| --- | --- |
| Workload / target | Normalized executable Lambda, service, task, workflow or agent; canonical `kind:id` |
| Role | Invocation category within a target kind, e.g. HTTP/event/WebSocket/tool Lambda |
| Route | Public path/method or WebSocket key leading to a target; independent of target identity |
| Deploy lane | Local/cloud enablement from `deploy`; distinct from the AWS deployment mode |
| Mode | Dev or prod synthesis/execution policy; not an arbitrary environment name |
| Named deployment target | Name + mode + optional pinned account/region/custom inputs selected for a deployment |
| Deployment identity | Deployment, mode, account, region encoded in stack metadata/tags/outputs |
| Catalog | Typed resource descriptors in framework-config/resources.ts; not a list of already built stacks |
| Link / finalization | Bind a descriptor to a native construct/value, then resolve deferred attachments/grants |
| Binding | Declared invocation/resource capability; the injected descriptor conveys transport details |
| Secret binding | Private deployment-review record tying secret writes to reviewed values/versions; distinct from workload bindings |
| IR / symbolic value | Declarative workflow nodes/terms and references, compiled or interpreted later |
| Snapshot / revision | Studio serialized models + source facts at a generation/content identifier |
| Provenance | Declared, derived or source-inferred relationship evidence; not runtime tracing |
| Draft / review | Staged UI intent vs validated proposed source diff/plan; applying saves source |
| Cloud assembly / deployment plan | Synthesized templates/assets vs reviewed AWS changes and apply gates |
| Inventory | Explicitly source, synthesized or observed; always identify which one |
| Gateway | Derived AgentCore MCP tool gateway, emulated locally; not the HTTP API Gateway |

Canonical details: [configuration](../framework/configuration.md), [environments](../deployment/environments.md), [graph model](../studio/graph-model.md), [secrets](../deployment/secrets.md), [workflow semantics](../framework/workflows.md).
