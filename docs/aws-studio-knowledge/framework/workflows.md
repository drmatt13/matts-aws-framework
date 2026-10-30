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

Built-in integrations include Lambda, ECS tasks, nested workflows, agents, DynamoDB, SQS, SNS, EventBridge, HTTP and generic AWS operations. [workflow-integrations.ts](../../../packages/framework/src/local/workflow-integrations.ts) calls real AWS for managed-service steps. Some HTTP/generic AWS operations use synthesized development Express bridges from [workflow-bridges-stack.ts](../../../cdk-app/lib/framework/workflow-bridges-stack.ts). Ordinary DynamoDB/SQS/SNS/EventBridge steps resolve the catalog construct through its existing `linkResources` link; no second application registry is needed. HTTP connection and explicit AWS-operation references require their own native binding because they also carry endpoint/authentication or fixed parameters/grant behavior. Those links/bindings must exist before workflow construction; see [resources/CDK](resources-and-cdk.md).

Local execution shares declared semantics, not Step Functions durability or exact service failure behavior. Runner restart discards in-flight runs/callbacks; task submission is not terminal success. Retryable side effects need application idempotency. [Local execution](../runtime/local-execution.md) owns process/container lifecycle; [agents/tools](agents-and-tools.md) owns agent sessions.

For a new operation follow [extensions](../guides/extensions.md). Test builder/reference errors, ASL structure, local success/failure and service bridging: [workflow graph](../../../packages/framework/test/workflow-graph.test.ts), [ASL](../../../packages/framework/test/workflow-asl.test.ts), [interpreter](../../../packages/framework/test/workflow-interpreter.test.ts), [service steps](../../../packages/framework/test/workflow-service-steps.test.ts), [runner engine](../../../local-invocation-runner/test/workflow-engine.test.ts). `workflows:inspect` shows normalized declarations; synth and authorized AWS checks establish different properties.

## Service operation boundary

[workflow-integrations.ts](../../../packages/framework/src/config/workflow-integrations.ts)
is the closed operation vocabulary, not a promise to wrap every AWS SDK operation:

| Resource/operation | Declared semantics |
| --- | --- |
| DynamoDB `get`, `put`, `update`, `delete` | JSON-document item access; explicit write conditions; no binary/set/precision-sensitive document API |
| SQS `send`, SNS `publish`, EventBridge `put` | Service acceptance; a message/event ID is not downstream processing success |
| SQS/SNS/EventBridge `request` | Send a callback envelope and wait for a separately authorized worker to complete it |
| HTTP `request` | Bound HTTPS endpoint plus EventBridge Connection; result carries status, headers and body |
| Generic AWS `call` | Explicitly named service/action with application-bound grants and fixed parameters; no guessed IAM |

[framework-integrations.ts](../../../cdk-app/lib/framework/framework-integrations.ts)
aggregates the operations used against each resource, applies native grants and publishes
non-secret identifiers for local SDK calls. HTTP/generic bridge provisioning remains
separate from those direct SDK adapters. Development can therefore exercise real side
effects despite interpreting the control flow locally.

`completesCallback(queue)` opts a worker into Step Functions callback actions. Those
actions use `Resource: "*"`; the named integration is not an IAM resource scope because
task tokens are not resource ARNs. Use the runtime callback helpers; task tokens are execution-specific values rather than
source configuration. The runner's callback broker provides local correlation and timeout
behavior without durable recovery. The detailed authoring guide covers
[callbacks](../../FRAMEWORK.md#callbacks) and [AWS release-check gaps](../../FRAMEWORK.md#verifying-task-and-workflow-invocation).
