# AgentCore agents and tools

An agent is an application AgentCore Runtime hosts. A tool is a Lambda the agent calls through
an AgentCore Gateway. Both are declared like every other workload, in two sections, and the
framework derives the rest: each agent's Gateway, its IAM, its packaging, the browser route,
the local development lane and the types.

Read [Framework](FRAMEWORK.md) first; this guide assumes its declarations, resources and
deploy settings.

## Declaring them

```ts
// framework-config/tools/support.ts
import { startsWorkflow } from "@repo/framework/config";
import type { ToolsSection } from "../contracts";
import { resources } from "../resources";

const cognito = {
  USER_POOL_ID: resources.cognito.userPool.userPoolId,
  USER_POOL_CLIENT_ID: resources.cognito.userPoolClient.userPoolClientId,
};

export const supportTools = {
  "lookup-case": { directory: "/lambda_functions/tool_functions/lookup-case", auth: true, deploy: "both", environment: { ...cognito, DATABASE_SECRET_ARN: resources.rds.credentialsSecret.arn } },
  "start-review": { directory: "/lambda_functions/tool_functions/start-review", auth: true, deploy: "both", environment: { ...cognito }, cloud: { bindings: [startsWorkflow("case-review")] } },
} satisfies ToolsSection;
```

```ts
// framework-config/agents/support.ts
import type { AgentsSection } from "../contracts";
import { resources } from "../resources";

export const supportAgents = {
  "support-agent": {
    directory: "/agentcore/support-agent",
    auth: true,
    route: "/chat/support",
    tools: ["lookup-case", "start-review"],
    deploy: "both",
    environment: {
      USER_POOL_ID: resources.cognito.userPool.userPoolId,
      USER_POOL_CLIENT_ID: resources.cognito.userPoolClient.userPoolClientId,
      MODEL_ID: resources.models.supportModelId,
    },
    cloud: { access: [bedrockModels], idleSeconds: 900 },
  },
} satisfies AgentsSection;
```

Compose them in `framework.config.ts` as `tools: [supportTools]` and `agents: [supportAgents]`.

| Declaration | What it says |
| --- | --- |
| `tools.<id>` | A Lambda an agent may call. Lives in `/lambda_functions/tool_functions/<id>` unless it declares `directory`. Takes every Lambda setting, `defaults.tools`, environment, bindings and `deploy`. |
| `tools.<id>.auth: true` | The tool acts as the signed-in user, and its handler is written with `authenticatedTool`. |
| `agents.<id>` | An agent. Lives in `/agentcore/<id>` at the repository root unless it declares `directory`. |
| `agents.<id>.tools` | The tools it may call. They are its Gateway, and nothing else is. |
| `agents.<id>.auth: true` | Calls carry the user's session, and its tools may act as that user. Authentication alone does not expose a browser route. |
| `agents.<id>.route` | The exact same-origin browser path, e.g. `/chat/support`. No `/api` or `/agents` prefix is added. Requires `auth: true`; omit it for workload-only invocation. |
| `agents.<id>.cloud.idleSeconds`, `maxLifetimeSeconds` | Session lifetime, 60 to 28800 seconds. Both lanes apply it. |
| `invokesAgent("<id>")` | A workload's binding to call an agent, as `runsTask` is to run a task. |

There is no Gateway to declare. Each agent gets its own, holding exactly the tools it lists;
its Runtime role may invoke that Gateway and no other. An agent cannot reach a tool it did not
declare, whatever its model asks for — that is enforced by IAM, not by a list the agent is
trusted to respect.

`auth: true` needs `USER_POOL_ID` and `USER_POOL_CLIENT_ID` in the environment, as an
authenticated route does, because the same verifier reads them. A tool with `auth: true` may be
listed only by an agent with `auth: true`; only that agent has a user to act as. An agent with
`auth: true` may be invoked only by a caller that has a user to pass on: an `auth: true` route,
service, tool or agent.

Agent browser routes are exact literal paths and accept POST. Keep the agent id separate
from its route: changing `/chat/support` does not change the implementation directory,
invocation binding, Runtime or Gateway identity. Routes are compared across all declarations,
including disabled deployment lanes. Duplicate agent routes and overlap with HTTP routes or
service mounts are rejected with both owners named. HTTP/service keys still resolve under
`/api`: an agent at `/api/chat/support` conflicts with a service at `/chat/*`; an agent at
`/chat/support` does not. An agent cannot share an HTTP browser path on another method,
because CloudFront selects its origin by path. Existing HTTP-versus-service checks remain
method-aware. Generation, local startup, CDK synth and deployment share this validation;
deployment synthesizes before secret uploads or infrastructure changes.

## Writing a tool

A tool's contract sits beside its handler, as an HTTP payload contract does:

```ts
// cdk-app/lambda_functions/tool_functions/lookup-case/contract.ts — Zod only
import { z } from "zod";

export const contract = {
  description: "Find one of the signed-in user's cases by its number.",
  request: z.object({ caseNumber: z.string().describe("For example 2024-CV-0012") }),
  response: z.object({ title: z.string(), status: z.enum(["open", "closed"]) }),
} as const;

// index.ts
import { authenticatedTool } from "@repo/framework/runtime/tools";
import { contract } from "./contract";

export const lambdaHandler = authenticatedTool(contract, async (input, session) => {
  return casesRepository.findOwned(session.payload.sub, input.caseNumber);
});
```

`tool(contract, async (input, context) => ...)` is the form for a tool with service authority.
`framework:check` refuses `auth: true` without `authenticatedTool`, `authenticatedTool` without
`auth: true`, and a tool handler with no wrapper.

The `description` and the schemas are what the model reads. `framework:generate` projects
them into `packages/framework/src/generated/agentcore.ts`, which is committed, so a change to a
tool's prompt is a reviewable diff. Gateway's schema has five keywords — type, description,
properties, required, items — so the projection writes everything else into the description:
an enum becomes "One of: …", a bound becomes "At most 2000 characters.", a default becomes
"Defaults to …". The wrapper still enforces every constraint with the real Zod schema, in both
lanes. A union, a nullable field or a record cannot be described at all and is refused at the
field that wrote it: make the field optional, or split the tool.

A wrapper validates the arguments and refuses bad ones with a message naming each field, which
reaches the model so it can correct the call. Anything the handler throws is logged with its
stack and reaches the model as "Tool execution failed." — a thrown error can carry a query, a
credential or a row.

**How a user tool knows the user.** The agent's adapter adds the verified ID token to every
call to an `auth: true` tool, in a reserved argument (`__framework_identity`) the model never
sees and cannot set: anything the model writes there is replaced. `authenticatedTool` verifies
the token against Cognito — the tool trusts neither the agent nor the Gateway for who the user
is — and removes it before the handler runs. Ownership checks stay in the handler, as they do in
a GraphQL resolver. Exposure is the HTTP API's: a Lambda's event already carries the bearer
token there. A turn that outlives the token's hour fails its user tools; give background work
a service tool.

Keep database and secret access in tools. An agent then needs no VPC and no database
credentials — it thinks, and its tools touch data.

## Writing an agent

```ts
// agentcore/support-agent/contract.ts
export const contract = {
  request: z.object({ message: z.string() }),
  event: z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("done") }),
  ]),
} as const;

// agentcore/support-agent/index.ts
import { agent } from "@repo/framework/runtime/agentcore";
import { contract } from "./contract";

export const handler = agent("support-agent", contract).stream(async function* (input, { tools, user, conversationId, signal }) {
  // Hand tools.specs to any model SDK; dispatch what it chooses with tools.call(name, args).
  const found = await tools.call("lookup-case", { caseNumber: input.message });
  yield { type: "text", text: `Case ${found.title} is ${found.status}.` };
  yield { type: "done" };
});
```

A contract has `request` and either `event` (the agent streams; write `.stream(async function* …)`)
or `response` (it answers once with JSON; write `.respond(async …)`). Only the matching method
exists, and each yield or return is typed by the contract. The adapter validates both directions. The id is the declaration's key; `framework:check`
refuses a mismatch, and `tools.call` with a literal id is typed by that tool's contract — calling
a tool the agent did not declare fails to compile.

The framework owns the boundary and nothing inside it. Use any agent library: give its model
`tools.specs` (name, description and JSON-schema input, the shape every model SDK takes) and
route the model's chosen calls through `tools.call`. The tool names are the tool ids; Gateway's
wire names are mapped for you.

`context.user` is the verified session of an `auth: true` agent. `conversationId` is the
caller's. `signal` aborts when the caller goes away; it does not undo a committed write.

AgentCore Memory, Browser and Code Interpreter need nothing new: declare them on an
application stack, expose them with `resource.stack<T>()` and `linkResources`, pass their ids
in `environment` and their native grants in `cloud.bindings`, as any resource. In development
they deploy like other resources and local agents use them with your profile.

## Calling an agent

From the browser, for an agent with `auth: true` and an explicit `route`:

```ts
import { streamAgent } from "#/lib/agents";

for await (const event of streamAgent("support-agent", { message }, { conversationId })) render(event);
```

The request and events are typed by the agent's contract, projected into `@repo/api-contract`.
The call goes to the exact declared path through the same authenticated fetch, refresh included.
It passes a same-origin URL so the HTTP helper does not add `/api`. Use a new
`crypto.randomUUID()` per conversation. The Runtime session it lands in is derived from the
conversation and the user, and the adapter recomputes it from the verified token, so a user can
never land in another user's session.

From a workload, declare `cloud: { bindings: [invokesAgent("support-agent")] }` and:

```ts
import { invokeAgent } from "@repo/framework/runtime/agentcore";

export const lambdaHandler = authenticated(async (event, session) => {
  const result = await invokeAgent("support-agent", { message: "…" }, { conversationId, session });
  return jsonResponse(200, result);
});
```

`invokeAgent` returns an agent's JSON `response`; a streaming agent is called from the browser.
An agent with users is called with the caller's `session` — its Runtime accepts only a user's
token, so no IAM grant is written. A service agent is called with the caller's role, which the
binding grants. The default timeout is 25 seconds, under the HTTP API's 30.

From a workflow, `invokeAgent` is a step like `runTask`, with no binding — the graph is the
declaration:

```ts
import { invokeAgent, invokeLambda, sequence, workflow } from "@repo/framework/config";

workflow<{ caseId: string }>(({ input }) => {
  const analysis = invokeAgent("case-analysis", { caseId: input.caseId }, { timeoutSeconds: 600 });
  return sequence(analysis, invokeLambda("store-analysis", { payload: analysis.output }));
}, { timeoutSeconds: 900 });
```

`.output` is the agent's `response`, typed by its contract. Only an agent without `auth` and with
a `response` contract can be a step: a workflow has no user's token to forward, and a step's
result is one document. Naming any other agent does not compile, and `framework:check` refuses it
too.

**Sessions belong to the execution.** Calls in one execution share its default Runtime session,
so a later step or a retry lands in the warm microVM the first call started; no two executions
ever share one. `session` names another session within the execution:

```ts
map(input.caseIds, ({ item }) => invokeAgent("case-analysis", { caseId: item }, { session: item }))
```

A call inside `map` (unless `maxConcurrency: 1`), or the same agent in two branches of one
`parallel`, must name its session: concurrent calls into one session race its provisioning —
Runtime answers `RetryableConflictException` while a session is being created — and share one
microVM's memory. Validation refuses the unnamed form. A Runtime session is compute affinity,
not memory: it ends after the agent's `idleSeconds` or `maxLifetimeSeconds`, so keep durable
state in AgentCore Memory or your database, keyed by your own ids.

**Limits.** The step waits at most 900 seconds, Runtime's fixed synchronous limit, which is also
its default; a longer `timeoutSeconds` is refused. A timed-out or stopped step does not stop the
agent in AWS. Input and result share Step Functions' 256 KiB state limit, measured on the raw
answer, in which the result is an escaped string. Each new session counts against Runtime's
25-per-second creation rate and 5,000 active sessions, and lives until the agent's
`idleSeconds` after its last call: a high-volume workflow wants a short `idleSeconds` on its
agent.

**Failures.** An agent that answers an error status fails the step with
`BedrockAgentCore.RuntimeClientErrorException`, and the cause carries only the status
("Received error (500) from runtime"); the body is in the agent's log. An answer that is not the
adapter's `{ result }` fails with `States.QueryEvaluationError`. Throttling and provisioning
races arrive as `BedrockAgentCore.ThrottlingException` and
`BedrockAgentCore.RetryableConflictException`; nothing is retried unless you say so, as with
every other step:

```ts
retry(invokeAgent("case-analysis", input), {
  retries: 3,
  on: ["BedrockAgentCore.ThrottlingException", "BedrockAgentCore.RetryableConflictException"],
});
```

A retried call sends the same input to the same session, and an express workflow started
asynchronously may run twice, so tools with side effects should be idempotent on your ids.

**In AWS** the step is Step Functions' SDK integration with AgentCore Runtime
(`aws-sdk:bedrockagentcore:invokeAgentRuntime`) under the workflow's role, granted
`InvokeAgentRuntime` on that Runtime only. (Step Functions' optimized AgentCore integration,
`invokeHarness`, is for managed harnesses, not code Runtimes.) Locally the runner calls the same
session process the browser reaches. Express workflows can use it.

Workflows may invoke agents while tools and agents start workflows, in one application, as long
as the calls never lead back to where they started: `review` → `case-analysis` →
`open-review` → `intake` deploys, while a tool that starts `review` itself is refused, naming the
edges of the cycle.

## Development

`npm run dev`. Nothing AgentCore-specific deploys in development:

- Each conversation runs in its own agent process in the invocation runner, as each Runtime
  session runs in its own microVM, and is released after the agent's idle time or lifetime.
  Editing the agent restarts an idle session on its next turn.
- Each agent's Gateway is emulated by the runner: the same tool names and schemas, and tools
  invoked as a Gateway Lambda target is — the argument map as the event, Gateway's metadata as
  `context.clientContext.custom`. Tools run through the local Lambda executor, cold, against
  local Postgres and your AWS profile.
- Tool contracts are read live. Edit a description or a field and the next call lists it —
  no generate step. `framework:check` keeps the committed projection equal to the source before
  you deploy.
- The browser reaches the declared agent path through an exact-match Vite proxy; the local API dev server
  verifies the user, as AgentCore's authorizer does in AWS, and streams the agent through the
  runner.

The local API server preserves browser paths: regular HTTP/service routes are mounted at
`/api`, while agent routes are mounted at their declared paths before that mount. Direct
requests to the API server therefore include `/api` for HTTP/services. `dev:request` adds it
for you; continue passing the declaration key, e.g. `/graphql`, to that command.

`npm run agents:inspect` prints each agent: where it runs, who may call it, its session
lifetime, and the Gateway derived from its tools.

## Deployment

`npm run deploy` with `PROD_DEPLOYMENT=true` builds, beside the workflows:

| Resource | From |
| --- | --- |
| A Lambda per tool | `tools`, built like any framework Lambda |
| A Gateway per agent with tools, IAM inbound | the agent's `tools` and the committed contract projection |
| A Runtime per agent, Node code from S3 | the agent's directory, bundled with esbuild with the framework's adapter |
| A Cognito JWT authorizer, `Authorization` allowlisted | an agent's `auth: true`, from the app's user pool |
| An exact CloudFront behavior per declared agent route, ahead of `/api/*` | agents with `auth: true` and `route`, when `FRONTEND_URL` is configured |

Agent route behaviors forward only `Authorization`, `Content-Type`, `Accept`, the session header and
`?qualifier`. It never forwards cookies, so the refresh cookie scoped to `/api` stays between the
browser and the HTTP API. Replies are never cached or compressed.

Agent browser routing follows `/api/*`'s domain requirement: both exist only with a configured frontend domain. On a
generated CloudFront domain, Cognito's callback URLs depend on the distribution, and an
agent's authorizer depends on Cognito, so the distribution cannot route to agents without a
dependency cycle. That is the same limitation the HTTP API has today (see Framework).

Agents deploy as code, not images: no Docker, no registry, no ARM64 cross-build. They run on
AgentCore's Node 22 runtime and are bundled for it; Lambdas run Node 24. Agents are TypeScript
modules today — a Python agent would need its own adapter and local lane.

Every name AgentCore requires is derived from the stack and construct path, so two
deployments in one account do not collide.

AgentCore refuses to invoke a Runtime without MMDSv2 since June 30, 2026, and CloudFormation
cannot set it yet. A custom resource per Runtime turns it on after each Runtime update, through
one provider shared by every agent and granted each Runtime and its execution role by ARN
(`cdk-app/lib/framework/agentcore-metadata.ts`). Delete it once
`AWS::BedrockAgentCore::Runtime` accepts `MetadataConfiguration`.

### Where it deploys

Agents, their Gateways and tools share one CloudFormation stack with the workflows — the
orchestration stack, whose deployed name stays `WorkflowsStack` (`cdk-app/lib/framework/orchestration-stack.ts`).
They share it because they call each other: a state machine references a Runtime, and a tool or
Runtime references a state machine. In two stacks those are opposite dependencies CloudFormation
cannot order; in one, only resources are ordered, and their graph is the invocation graph that
validation proves acyclic. The two are still built apart — `framework-workflows.ts` builds state
machines at the stack's top level, where their logical ids have always been, and
`framework-agentcore.ts` builds everything AgentCore under one `AgentCore` construct — so a
workflow may not be named `agent-core`, and an agent and a tool may not share an output id.

CloudFormation allows 500 resources per stack. Measured, in resources:

| Each | Adds |
| --- | --- |
| Agent with tools (Runtime, role, policy, Gateway, role, policy, target, MMDSv2 resource) | 8 |
| Agent without tools | 4 |
| Tool | 3, or 4 once it is granted anything |
| Workflow | 4 |
| First agent (the shared MMDSv2 provider) | 23 |

So about 29 agents, each with a tool and a workflow calling it, or about 115 workflows alone, fit
in one stack. Synthesis refuses a stack over 500 rather than letting the deploy fail. Beyond that
an application splits into deployments; the framework does not shard the stack.

## Smoke test in AWS

`npm run agents:smoke` checks the example agent in a disposable deployment, and only one whose
`CDK_APP_NAME` contains `smoke`:

```sh
# a separate checkout or worktree, so the main cdk-app/.env is untouched
# cdk-app/.env: PROD_DEPLOYMENT=true, CDK_APP_NAME=agents-smoke-<you>,
#   DATABASE_BACKUP_RETENTION_DAYS=0, optionally FRONTEND_URL + certificate
# framework-config/agents/example.ts: the agent deploys "both"
# framework-config/tools/example.ts: both tools deploy "both"
npm run deploy -- --all -c useLocalDevStack=false --profile <PROFILE>
npm run agents:smoke -- --app agents-smoke-<you> --profile <PROFILE> [--frontend <FRONTEND_URL>] [--include-expiry]
```

It creates two users in that deployment's pool and deletes them on exit. It checks:

- the Runtime is ready with MMDSv2 required;
- Gateway lists each tool's committed schema, answers through each tool, and refuses contract-violating input;
- one model turn streams to user A and calls the tools from Runtime through the agent's own Gateway;
- user B, with the same conversation id, lands in B's own empty session, and cannot enter A's;
- the Runtime rejects every bad credential and malformed request;
- with `--frontend`, the same path through CloudFront;
- no token it minted appears in the Runtime's or the tools' logs.

The model turn needs access to the model `LANGGRAPH_MODEL_PROVIDER` selects in the smoke
deployment's account; every other check reads the conversation's history and calls no model.
The tools are service tools, so a user's identity reaching a tool through Gateway
(`authenticatedTool`) is covered only by the local tests, not by this run.

It prints statuses only, with JWT-shaped text redacted. `--include-expiry` waits out the ID token's hour
to check expiry. After editing a tool description or the agent, redeploy and rerun it: the schema
check compares Gateway with the committed projection, and the MMDSv2 check proves the shim ran after
the update.

## What local proves, and what it does not

| Property | Proven locally | Proven only in AWS |
| --- | --- | --- |
| The whole call path | A workload's `invokeAgent` → runner → session process → emulated Gateway → the tool's Lambda, with its contract enforced (`local-invocation-runner/test/agent-e2e.test.ts`) | The same path through Runtime and Gateway |
| Tool contracts, validation, naming, identity handling | Same wrappers, same projection, same adapter | Gateway's own schema enforcement and error text |
| Session ownership | The adapter's check, in both lanes | Runtime microVM isolation |
| Who may call what | Edges and the runner's caller check | IAM: Gateway and Runtime grants |
| Packaging | The adapter and handler code | The Node 22 code artifact starting in Runtime |
| Streaming | Server-sent events end to end | CloudFront → AgentCore streaming |

A local process is not a microVM: the host's filesystem, profile and network are shared, and
your profile can exceed the deployed roles. These AWS behaviours have not yet been exercised
against a live account and need a dev-account spike before production use: a Node code
Runtime starting with entry point `index.js` and the MMDSv2 update completing; the Runtime
accepting Cognito ID tokens by audience and passing `Authorization` to the adapter (whose
verifier takes the pool's region from its id when the Runtime sets no `AWS_REGION`); CloudFront forwarding to the AgentCore data
plane and streaming past 60 seconds with keepalives; Gateway passing the identity argument to
the Lambda, mapping a Lambda error to a tool error, and what it logs of arguments; and, for a
workflow's `invokeAgent` step, a real invocation: the error Step Functions raises when the agent
answers an error status, and how Runtime treats concurrent calls into one established session.
The step's definition itself is checked against AWS without deploying: Step Functions'
ValidateStateMachineDefinition accepts it, and TestState with a mocked result evaluates its
JSONata as AWS does — `$hash` answers lowercase hex, the session id is the one the adapter
derives, `Response` is a string, and a malformed answer fails with `States.QueryEvaluationError`.
