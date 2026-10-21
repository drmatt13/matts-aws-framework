---
id: framework.workflows
summary: One declarative workflow IR feeds ASL/JSONata compilation and local interpretation.
read_when:
  - Authoring workflows or extending supported operations
  - Debugging local/cloud workflow differences
source:
  - packages/framework/src/config/workflow-builder.ts
  - packages/framework/src/config/workflow-ast.ts
  - packages/framework/src/config/workflow-asl.ts
  - packages/framework/src/local/workflow-interpreter.ts
  - local-invocation-runner/src/workflows.ts
related:
  - framework.resources-cdk
  - runtime.local-execution
  - guides.extensions
---
# Workflow semantics and execution

`workflow(...)` in [workflow-builder.ts](../../../packages/framework/src/config/workflow-builder.ts) executes an authoring callback to build an IR. It is not an arbitrary asynchronous JavaScript compiler. Proxy-backed symbolic values record input/output/property references. `sequence`, `parallel`, `when`, `choose`, `map`, `wait`, `retry`, `attempt`, `transform`, `succeed`, `fail` and `expr` construct supported semantics.

**Step outputs are references, not values.** JavaScript `if`, ternaries, truthiness, template strings, spread and `await` cannot decide runtime state. Use the DSL's conditions and expressions. Static authoring checks catch forbidden source patterns; proxy coercion guards alone cannot detect every JavaScript use.

| Phase | Owner / contract |
| --- | --- |
| Build and normalize | [builder](../../../packages/framework/src/config/workflow-builder.ts), [AST](../../../packages/framework/src/config/workflow-ast.ts), [normalization](../../../packages/framework/src/config/workflow-normalize.ts): typed terms, nodes and references |
| Validate | [workflow-validate.ts](../../../packages/framework/src/config/workflow-validate.ts), [semantics](../../../packages/framework/src/config/workflow-semantics.ts): lexical reference scopes, targets, capabilities, graph/cycle and Standard/Express restrictions |
| Compile | `compileWorkflowToAsl` in [workflow-asl.ts](../../../packages/framework/src/config/workflow-asl.ts): Step Functions ASL using JSONata expressions |
| Provision | [framework-workflows.ts](../../../cdk-app/lib/framework/framework-workflows.ts): dependency order, state machines, IAM/integrations and pinned task revisions |
| Interpret | `runWorkflow` in [workflow-interpreter.ts](../../../packages/framework/src/local/workflow-interpreter.ts): evaluate the structured terms and nodes directly; no local JSONata evaluator |
| Execute local steps | `LocalWorkflowEngine` in [runner/workflows.ts](../../../local-invocation-runner/src/workflows.ts): Lambda/task/nested workflow/agent calls, timeouts, callbacks and bounded in-memory history |

Built-in integrations include Lambda, ECS tasks, nested workflows, agents, DynamoDB, SQS, SNS, EventBridge, HTTP and generic AWS operations. [workflow-integrations.ts](../../../packages/framework/src/local/workflow-integrations.ts) calls real AWS for managed-service steps. Some HTTP/generic AWS operations use synthesized development Express bridges from [workflow-bridges-stack.ts](../../../cdk-app/lib/framework/workflow-bridges-stack.ts). Bind integration references beside their native construct before workflow construction; see [resources/CDK](resources-and-cdk.md).

Local execution shares declared semantics, not Step Functions durability or exact service failure behavior. Runner restart discards in-flight runs/callbacks; task submission is not terminal success. Retryable side effects need application idempotency. [Local execution](../runtime/local-execution.md) owns process/container lifecycle; [agents/tools](agents-and-tools.md) owns agent sessions.

For a new operation follow [extensions](../guides/extensions.md). Test builder/reference errors, ASL structure, local success/failure and service bridging: [workflow graph](../../../packages/framework/test/workflow-graph.test.ts), [ASL](../../../packages/framework/test/workflow-asl.test.ts), [interpreter](../../../packages/framework/test/workflow-interpreter.test.ts), [service steps](../../../packages/framework/test/workflow-service-steps.test.ts), [runner engine](../../../local-invocation-runner/test/workflow-engine.test.ts). `workflows:inspect` shows normalized declarations; synth and authorized AWS checks establish different properties.
