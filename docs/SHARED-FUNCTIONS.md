# Shared framework functions

The framework exposes configuration, backend runtime, and local execution through
explicit package entry points. Backend code imports the module it needs; there is
no `@repo/framework` package-root barrel. Browser code uses `@repo/api-contract`.

See [Framework](FRAMEWORK.md#package-boundaries) for the package boundaries and
[Shared AWS dependencies](SHARED-AWS-DEPENDENCIES.md) for what stays in AWS during
development.

## Backend runtime

All import suffixes below follow `@repo/framework/runtime/`. For example,
`invocation` means `@repo/framework/runtime/invocation`.

| Function | Purpose | Import suffix |
| --- | --- | --- |
| `runTask(id, input)` | Launch a declared ECS task; return a `runId` after submission is accepted. Local execution uses the invocation runner and Docker. | `invocation` |
| `startWorkflow(id, input)` | Start a declared workflow; return an `executionId` after acceptance. Local execution uses the workflow interpreter. | `invocation` |
| `invokeAgent(id, input, options)` | Call a declared agent and receive its JSON response. Options include `conversationId` and, for an agent with users, the caller's session. | `agentcore` |
| `webSocketConnections(event)` | Get `.send(connectionId, data)` and `.disconnect(connectionId)` for the WebSocket API that delivered the event. Uses the local management endpoint during development. | `websocket` |
| `authenticated(handler)` | Verify an HTTP caller and pass its session to the handler. Pair with `auth: true` in the route declaration. | `auth` |
| `getAuthenticatedSession`, `getAuthenticatedUser`, `getAuthenticatedSub` | Read a verified session, Cognito claims, or user ID when explicit handling is needed. | `auth` |
| `getDatabaseUrl()` | Resolve the primary database URL from supplied settings: local Postgres during development, or Secrets Manager credentials for a deployed database. | `database` |
| `completeCallback`, `failCallback`, `heartbeatCallback` | Report success, failure, or continued activity to a waiting workflow step. Delivery follows the callback handle and framework-issued environment. | `callbacks` |
| `taskCallback()` | Read the callback handle supplied to a container task launched in callback mode. | `callbacks` |
| `parseCallbackRequest()` | Read a messaging worker's `{ payload, callback }` envelope and validate its callback handle. It does not validate the application's payload schema. | `callbacks` |
| `withLocalReplay(handler)` | Capture an AWS invocation in a development deployment for local execution. Otherwise run the handler normally. Pair with `localReplay: true`. | `event-replay` |
| `jsonResponse()` | Create an HTTP JSON response. | `http` |
| `parseJsonBody()` | Parse a request body as JSON. Application schema validation remains explicit. | `http` |

Runtime `runTask` and `startWorkflow` acknowledge submission, not completion.
Callers declare `runsTask(id)` or `startsWorkflow(id)` in `cloud.bindings`;
agent callers declare `invokesAgent(id)`. These declarations supply descriptors,
permissions, and local invocation checks. Application code does not select local
versus AWS transport itself.

## Agent and tool implementations

| Function | Purpose | Entry point |
| --- | --- | --- |
| `agent(id, contract).respond(handler)` | Implement an agent with a JSON response contract. | `@repo/framework/runtime/agentcore` |
| `agent(id, contract).stream(handler)` | Implement an agent with a streaming event contract. | `@repo/framework/runtime/agentcore` |
| `tool(contract, handler)` | Implement a tool with service authority, validating its request and response. | `@repo/framework/runtime/tools` |
| `authenticatedTool(contract, handler)` | Implement a tool that receives a verified user session; pair with `auth: true`. Record authorization remains application logic. | `@repo/framework/runtime/tools` |

Browser agent calls use `streamAgent` from
[the client agent helper](../client-app/src/lib/agents.ts), with generated routes
and contracts from `@repo/api-contract`. Backend `invokeAgent` expects JSON rather
than an event stream. See [AgentCore](AGENTCORE.md).

## Database package

These exports belong to `@repo/database`, separate from the framework runtime:

| Function | Purpose |
| --- | --- |
| `getDatabase(databaseUrl)` | Obtain the typed repository registry and reuse its connection pool. The current registry contains `users` and `projects`. |
| `disconnectDatabase()` | Close the shared database connection. |
| `ensureCognitoUser()` | Provision or reconcile an application's user record from Cognito identity data. |

The registry and exports are in
[the database entry point](../packages/database/src/index.ts).

## Configuration and workflow declarations

These helpers are imported from `@repo/framework/config`. They describe resources,
permissions, or workflow graphs; they do not execute workload calls while the
configuration is being evaluated.

| Functions | Purpose |
| --- | --- |
| `defineFrameworkConfig()` | Compose the workload declarations. |
| `defineResources()`, `resource.stack<T>()`, `resource.secret()`, `resource.fromEnv()` | Declare the resource catalog, stack references, secrets, and authored inputs. |
| `runsTask()`, `startsWorkflow()`, `invokesAgent()` | Declare the workloads a caller may invoke. |
| `completesCallback()` | Declare that an AWS messaging worker completes callbacks from its bound queue. |
| `workflow()`, `sequence()`, `parallel()`, `map()`, `when()`, `choose()` | Build execution order, concurrency, iteration, and branching. |
| `retry()`, `attempt()`, `wait()` | Describe retries, error handling, and delays. |
| `transform()`, `expr.*`, condition helpers such as `eq()` | Describe data transformations and conditions evaluated when the workflow runs. |
| `succeed()`, `fail()` | Declare terminal workflow outcomes. |
| `invokeLambda()`, `runTask()`, `runWorkflow()`, `invokeAgent()` | Create steps that invoke declared workloads. |
| `dynamodb.*`, `sqs.*`, `sns.*`, `eventbridge.*` | Create managed-service integration steps against catalog constructs. |
| `http.connection()`, `http.request()` | Declare a connection reference and HTTPS request step. |
| `aws.operation()`, `aws.call()` | Declare a typed AWS service/action reference and call it as a workflow step. |

Runtime `runTask()` submits work immediately. DSL `runTask()` creates a step whose
completion behavior belongs to the workflow. Runtime and DSL `invokeAgent()` also
have different roles. Their import paths identify the version being used.

A step's `.output` is a typed reference, not an available JavaScript value. Use
DSL conditions and `expr` to compute with it.

## CDK resource linking

Application CDK uses these helpers from the repository's infrastructure modules:

- `linkResources(this, resources.myStack)` exposes a stack's public fields through
  the resource catalog.
- `bindWorkflowAwsOperation()` supplies explicit IAM grants and fixed parameters
  for an `aws.operation()` reference.
- `bindWorkflowHttpConnection()` binds an HTTP reference to an EventBridge
  Connection and a fixed endpoint.

See [resource linking](../cdk-app/lib/framework/framework-resources.ts),
[integration binding](../cdk-app/lib/framework/framework-integrations.ts), and
[the workflow builder](../packages/framework/src/config/workflow-builder.ts).
