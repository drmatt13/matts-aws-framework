---
id: framework.agents-tools
summary: Agent/tool contracts, derived Gateways, cloud provisioning, and local sessions.
read_when:
  - Implementing agents or tool integrations
  - Changing session, auth, Gateway, or agent workflow behavior
source:
  - framework-config/agents/example.ts
  - framework-config/tools/example.ts
  - packages/framework/src/runtime/agentcore.ts
  - packages/framework/src/runtime/tools.ts
  - cdk-app/lib/framework/framework-agentcore.ts
  - local-invocation-runner/src/agents.ts
related:
  - framework.workflows
  - runtime.local-execution
  - deployment.secrets
---
# Agents and tools

The complete authoring/API guide is [AgentCore](../../AGENTCORE.md). Agent declarations name an implementation directory, tool IDs, lanes, auth, optional exact browser route, environment and permissions. Tools are Lambda targets with neighboring contracts; their lanes derive from all consuming agents. An unused tool has neither lane. An agent's browser path is separate from `/api` HTTP/service paths.

`agent(...).respond(...)` / invocation helpers in [runtime/agentcore.ts](../../../packages/framework/src/runtime/agentcore.ts) and `tool` / `authenticatedTool` in [runtime/tools.ts](../../../packages/framework/src/runtime/tools.ts) validate payloads and propagate supported identity. Contract modules use Zod and feed generated Gateway schema projections. Keep them self-contained. `auth: true` tools/agents get pool bindings without an extra `userPool: true`; session ownership is verified by the shared adapter.

| Lane | Implementation |
| --- | --- |
| Prod CDK | `FrameworkAgentCore` in [framework-agentcore.ts](../../../cdk-app/lib/framework/framework-agentcore.ts) builds Node code Runtimes, an IAM-inbound Gateway per agent with tools, Lambda targets, narrow invoke grants and Cognito authorizers/routes |
| Orchestration | [orchestration-stack.ts](../../../cdk-app/lib/framework/orchestration-stack.ts) keeps workflows/agents/tools in deployed `WorkflowsStack`; validated acyclic invocation edges let one stack order mutually referencing resource kinds |
| Runtime metadata | [agentcore-metadata.ts](../../../cdk-app/lib/framework/agentcore-metadata.ts) provisions the implementation's MMDSv2 custom-resource shim; revisit when changing the pinned CDK/CloudFormation model |
| Local agent | `LocalAgentSupervisor` in [agents.ts](../../../local-invocation-runner/src/agents.ts): one fork per session, bounded capacity, idle/lifetime eviction, source/environment fingerprints and restart of idle edited sessions |
| Local Gateway | [agent-routes.ts](../../../local-invocation-runner/src/agent-routes.ts): lists live contracts and invokes tools through `LocalLambdaExecutor` cold, with Gateway-shaped metadata |
| Caller | Declared workload `invokeAgent` binding, browser route through authenticated local proxy, or [workflow agent step](workflows.md) |

Local model calls use the configured provider and can incur real external requests. Node processes share host trust; they do not reproduce Runtime microVM isolation or IAM. Tool wrappers and contracts are shared, but Gateway's deployed schema/error behavior, streaming, MMDSv2 and actual Step Functions/AgentCore integration require live evidence. The existing AgentCore guide explicitly records those unverified surfaces; do not infer production readiness from local tests.

Add a tool by implementing its contract/handler, declaring it under `tools`, referencing its ID from an agent, regenerating and checking projections. Add only the necessary native grants/secret references. [Local E2E](../../../local-invocation-runner/test/agent-e2e.test.ts) exercises workload → session → emulated Gateway → tool without a live model; [agentcore tests](../../../cdk-app/test/agentcore.test.ts) cover provisioning, and [tool runtime tests](../../../packages/framework/test/agentcore-tools.test.ts) cover wrappers. See [walkthroughs](../guides/workflows.md) and [extensions](../guides/extensions.md).
