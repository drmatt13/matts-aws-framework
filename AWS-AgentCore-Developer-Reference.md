# Amazon Bedrock AgentCore — Developer Reference

**Verified against current AWS documentation: October 1, 2026**

This is a developer-first reference for Amazon Bedrock AgentCore: CLI, local development, Runtime, LangGraph integration, Gateway/MCP, CDK, deployment, invocation, authentication, Cognito, sessions, and the boundary between your agent-framework code and AWS-managed infrastructure.

> **Core mental model:** your agent framework defines agent behavior; AgentCore provides the managed runtime, connectivity, security, and operational layer around it.

---

## 1. What AgentCore Is

Amazon Bedrock AgentCore is not a replacement for LangGraph, Strands, CrewAI, LlamaIndex, or custom agent code. It is an AWS platform for **running, connecting, securing, governing, observing, and operating agents**.

```text
YOUR AGENT FRAMEWORK
────────────────────────────────────
LangGraph / Strands / custom code

• graph nodes and edges
• prompts
• model selection
• tool decisions
• interrupts
• routing
• retries
• application state
• checkpointing
• business logic


AGENTCORE
────────────────────────────────────
AWS-managed agent infrastructure

• Runtime
• deployment
• session isolation
• endpoints
• Gateway / MCP connectivity
• Identity
• authentication
• authorization / Policy
• Memory
• Browser
• Code Interpreter
• observability
• evaluations
• optimization
```

For a LangGraph application, the simplest conceptual architecture is:

```text
Client
  │
  ▼
AgentCore Runtime
  │
  ▼
LangGraph
  │
  ├── model calls
  ├── local tools
  ├── checkpoint database
  ├── interrupts
  │
  └── MCP client
        │
        ▼
  AgentCore Gateway
        │
        ├── Lambda
        ├── REST / OpenAPI
        ├── API Gateway
        ├── Smithy service
        ├── remote MCP server
        └── other managed integrations
```

The important point is that **LangGraph is still LangGraph**. AgentCore does not require you to convert your graph into an AWS-specific graph format.

---

## 2. AgentCore Runtime

AgentCore Runtime is the managed compute environment in which an agent can execute. Think of it as **managed compute purpose-built for agent sessions**, not as an LLM service.

Runtime handles concerns such as:

- provisioning
- scaling
- session isolation
- runtime lifecycle
- inbound authentication
- managed endpoints
- versioning
- CloudWatch integration
- deployment artifacts
- networking configuration

For microVM-based Runtime, each session runs in an isolated execution environment with dedicated CPU, memory, and filesystem isolation.

Current default microVM lifecycle behavior:

- idle timeout: **15 minutes**
- maximum environment lifetime: **8 hours**
- both are configurable within service limits

AgentCore also has an Instances compute option for longer-lived managed compute, with lifecycle limits up to 14 days depending on configuration.

---

## 3. Runtime vs LangGraph

This separation is fundamental.

### LangGraph owns

```text
“What should the agent do?”
```

Examples:

- graph topology
- planner
- nodes
- conditional edges
- interrupts
- `Command(resume=...)`
- tool routing
- graph state
- checkpoints
- model invocation
- application logic

### AgentCore Runtime owns

```text
“Where and how should this agent execute?”
```

Examples:

- deployment
- endpoint
- compute environment
- scaling
- isolation
- execution lifecycle
- runtime authentication
- infrastructure management

So:

```text
LangGraph
    ↓
agent behavior

AgentCore Runtime
    ↓
agent hosting
```

---

## 4. The AgentCore CLI

AWS provides the AgentCore CLI as an npm package.

```bash
npm install -g @aws/agentcore
```

The CLI requires Node.js 20+.

Core commands:

```bash
agentcore create
agentcore dev
agentcore deploy
agentcore invoke
agentcore status
agentcore validate
```

| Command | Purpose |
|---|---|
| `agentcore create` | Scaffold a new AgentCore project |
| `agentcore dev` | Run the agent locally |
| `agentcore deploy` | Package and deploy AgentCore resources |
| `agentcore invoke` | Invoke a deployed agent |
| `agentcore status` | Inspect deployed resources and outputs |
| `agentcore validate` | Validate AgentCore configuration |

The CLI is not just a wrapper over one API. Under the hood it uses **AWS CDK and CloudFormation** to provision resources.

---

## 5. AgentCore CLI Project Structure

A CLI-created project generally contains an `agentcore/` configuration directory and your application code.

Representative TypeScript structure:

```text
MyProject/
│
├── AGENTS.md
├── README.md
│
├── agentcore/
│   ├── agentcore.json
│   ├── aws-targets.json
│   ├── .env.local
│   ├── .cli/
│   ├── .llm-context/
│   └── cdk/
│
└── app/
    └── MyAgent/
        ├── main.ts
        ├── model/
        ├── mcp_client/
        ├── package.json
        └── tsconfig.json
```

Conceptually:

```text
agentcore.json
    ↓
“What is this AgentCore application?”

aws-targets.json
    ↓
“Where should this project deploy in AWS?”

app/...
    ↓
“Here is my actual agent code.”

agentcore/cdk/
    ↓
“Generated/vended infrastructure project used by the CLI.”
```

---

## 6. What `agentcore create` Does

`agentcore create` scaffolds an AgentCore project. You can select things such as:

- language
- agent framework
- model provider
- memory configuration
- build mode

Conceptually:

```text
agentcore create
       ↓
choose language
choose framework
choose model
choose deployment model
       ↓
generate application
generate AgentCore config
generate CDK project
generate local environment
```

---

## 7. `agentcore dev`: Local Development

Run:

```bash
agentcore dev
```

For Python, AgentCore dev can:

- create/use a Python virtual environment
- install dependencies
- start a local development server
- hot reload code
- open Agent Inspector

For TypeScript, it can:

- install dependencies
- compile TypeScript
- start a local development server
- hot reload
- open Agent Inspector

Default local server:

```text
http://localhost:8080
```

Change the port:

```bash
agentcore dev --port 3000
```

Show logs:

```bash
agentcore dev --logs
```

---

## 8. What `agentcore dev` Actually Emulates

`agentcore dev` should be thought of as a **local Runtime-compatible development environment**.

```text
YOUR LAPTOP

localhost:8080
      │
      ▼
AgentCore local dev server
      │
      ▼
your agent application
      │
      ▼
LangGraph / Strands / custom framework
```

It does **not** mean every AgentCore managed service runs locally.

For example:

- Runtime-compatible server: local
- LangGraph graph: local
- code edits and hot reload: local
- Gateway: normally remote AWS-managed service
- Bedrock: real AWS service
- Lambda: real AWS service
- remote Postgres/Aurora: real AWS service
- Cognito: real AWS service

A useful development architecture is:

```text
LOCAL
────────────────────────────────────────

LangGraph
   │
   ├── local checkpointer
   │
   ├── local tools
   │
   └── MCP client
           │
           │ HTTPS
           ▼

AWS DEV ENVIRONMENT
────────────────────────────────────────

AgentCore Gateway
       │
       ├── Lambda
       ├── API Gateway
       ├── remote MCP
       └── SaaS / APIs
```

This gives you local iteration while still exercising real cloud integrations.

---

## 9. Invoking the Agent in Local Dev

After starting:

```bash
agentcore dev
```

you can send prompts to the local dev server through the AgentCore CLI. AWS also supports streaming-oriented local testing where applicable.

For Runtime HTTP applications, the important invocation path is:

```text
POST /invocations
```

So conceptually local HTTP testing is:

```text
POST http://localhost:8080/invocations
```

using whatever JSON payload contract your application defines.

Agent Inspector provides another local surface for:

- conversations
- traces
- tool calls
- state inspection
- debugging

---

## 10. Python: Wrapping Existing Framework Code

Python has a convenient AgentCore Runtime SDK abstraction.

```python
from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()
```

Then define the function AgentCore invokes:

```python
@app.entrypoint
def invoke(payload, context):
    ...
```

For LangGraph, the pattern is conceptually:

```python
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from my_graph import graph

app = BedrockAgentCoreApp()

@app.entrypoint
def invoke(payload, context):
    return graph.invoke(
        payload["input"],
        config={
            "configurable": {
                "thread_id": payload["thread_id"]
            }
        }
    )

app.run()
```

The important part is what **does not change**:

```python
builder = StateGraph(State)

builder.add_node(...)
builder.add_edge(...)
builder.add_conditional_edges(...)

graph = builder.compile(
    checkpointer=checkpointer
)
```

AgentCore wraps the invocation boundary. You do not rewrite every node using AgentCore classes.

---

## 11. TypeScript

AgentCore also supports TypeScript development.

The local CLI:

```bash
agentcore dev
```

handles TypeScript compilation for generated/scaffolded projects.

Production execution runs compiled JavaScript rather than raw TypeScript. The current direct-code Node runtime is Node.js 22.

```text
main.ts
   ↓
compile / bundle
   ↓
JavaScript
   ↓
AgentCore Runtime
```

For container deployments, your container build controls the runtime environment within AgentCore requirements.

The design principle is the same as Python:

```text
your framework code
      │
      ▼
Runtime-compatible entry boundary
      │
      ▼
AgentCore Runtime
```

---

## 12. AgentCore Runtime Protocol

At the platform level, Runtime has protocol contracts.

For traditional request/response HTTP workloads, the important endpoint is:

```text
POST /invocations
```

Containerized HTTP runtimes listen on the required Runtime port, typically:

```text
8080
```

AgentCore Runtime also supports additional agent-oriented interfaces such as WebSocket, MCP, and A2A scenarios.

The Python decorator is therefore best understood as an adapter:

```text
AgentCore invokes application
         ↓
Runtime protocol
         ↓
your entrypoint
         ↓
LangGraph
```

---

## 13. LangGraph Checkpointing

AgentCore Runtime sessions and LangGraph checkpoints solve different problems.

### Runtime session

Represents an AgentCore execution/session context.

### LangGraph thread

Represents a logical graph execution/conversation.

### LangGraph checkpoint

Stores durable graph state.

Example:

```text
AgentCore session
      │
      ▼
LangGraph thread_id = case-123
      │
      ▼
Postgres checkpointer
```

You control how Runtime session IDs and LangGraph thread IDs map to one another. They do not have to be the same identifier.

---

## 14. LangGraph Interrupts

LangGraph interrupts still belong to LangGraph.

```python
from langgraph.types import interrupt

def approval_node(state):
    approved = interrupt({
        "message": "Approve action?",
        "action": state["action"]
    })

    return {"approved": approved}
```

The graph pauses. The checkpoint records where execution stopped. Your AgentCore invocation returns application data indicating interaction is required.

Later, your application can resume the same graph thread:

```python
from langgraph.types import Command

graph.invoke(
    Command(resume=True),
    config={
        "configurable": {
            "thread_id": "case-123"
        }
    }
)
```

AgentCore does not need to own LangGraph's interrupt semantics.

---

## 15. Why a Durable Checkpointer Matters

An in-memory checkpointer is fine for development. It is not sufficient if graph state must survive Runtime-environment termination.

```text
AgentCore Runtime execution environment
            ≠
durable workflow database
```

If:

```text
graph interrupt()
      ↓
user disappears
      ↓
runtime environment terminates
      ↓
later user resumes
```

then state must exist somewhere durable.

Typical production pattern:

```text
LangGraph
   ↓
Postgres / Aurora
   ↓
durable checkpoint
```

A newly provisioned Runtime environment can then reload the same `thread_id`.

---

## 16. AgentCore Gateway

AgentCore Gateway is the managed connectivity/control layer through which agents can discover and invoke tools, agents, and model endpoints.

Current Gateway target categories include:

```text
MCP
HTTP
Inference
```

---

## 17. MCP Gateway Targets

MCP targets are aggregated into a unified virtual MCP server.

A Gateway can expose capabilities backed by:

- Lambda functions
- API Gateway REST API stages
- OpenAPI-described REST APIs
- Smithy-modeled services
- remote MCP servers
- built-in integrations
- built-in connectors

```text
Agent
  │
  │ MCP
  ▼
AgentCore Gateway
  │
  ├── Lambda A
  ├── Lambda B
  ├── REST API
  ├── MCP server
  └── connector
```

From the agent's perspective, it interacts with one MCP endpoint.

---

## 18. Gateway as an MCP Server

For MCP targets, AgentCore Gateway acts as an MCP server.

The agent can perform operations such as:

```text
tools/list
tools/call
```

according to the configured MCP protocol version.

Current Gateway support includes multiple MCP protocol revisions, including the newer stateless 2026-07-28 revision.

A direct tool invocation conceptually looks like:

```text
POST https://<gateway>/mcp

MCP method:
tools/call

tool:
search_case

arguments:
{
  "caseId": "...",
  "query": "..."
}
```

Gateway invokes the configured backend and returns the result through MCP.

---

## 19. Gateway Target Example: Lambda

A Lambda target requires:

```text
Lambda ARN
+
tool schema
+
Gateway target
+
permissions
```

The schema defines the MCP-facing tool interface.

```text
search_case(caseId, query)
          ↓
Gateway target
          ↓
Lambda
          ↓
result
```

Gateway translates between MCP and Lambda invocation.

---

## 20. Using Gateway from LangGraph

You do not need to replace LangGraph tools with an AgentCore-specific tool abstraction. Your LangGraph application can use a normal MCP client.

Conceptually:

```python
gateway_tools = await mcp_client.get_tools()
model = model.bind_tools(gateway_tools)
```

Then:

```text
LangGraph ToolNode
       │
       ▼
MCP client
       │
       ▼
AgentCore Gateway
       │
       ▼
Lambda / API / MCP target
```

From LangGraph's perspective, Gateway tools are remotely available tools.

---

## 21. Mixing Local and Gateway Tools

There is no requirement that every tool go through Gateway.

You can combine:

```text
local Python/TypeScript tool
+
Gateway MCP tool
+
Code Interpreter
+
Browser
```

Conceptually:

```python
tools = [
    *local_tools,
    *gateway_tools
]
```

Gateway is most useful for capabilities that benefit from central discovery, authentication, credential management, policy enforcement, and organizational reuse.

---

## 22. Using a Real Gateway While Running Locally

This is a major developer workflow.

You can run:

```bash
agentcore dev
```

locally while the agent connects to a Gateway already deployed into a development AWS account.

```text
Developer laptop
────────────────────────────────

AgentCore dev
   │
   ▼
LangGraph
   │
   ▼
MCP Client
   │
   │ HTTPS
   ▼

AWS
────────────────────────────────

AgentCore Gateway
   │
   ▼
Lambda
```

Your edit/test cycle can therefore be:

```text
edit graph
   ↓
hot reload
   ↓
invoke localhost
   ↓
LangGraph calls real Gateway
   ↓
Gateway calls real dev Lambda
```

You do not need to redeploy Runtime for every graph-code edit.

---

## 23. Local-Only Tool Development

If you want completely local tool development, your application can point to local implementations or a local MCP server.

```text
TOOLS_MODE=local
    ↓
local MCP server

TOOLS_MODE=aws
    ↓
AgentCore Gateway
```

This switch is your application architecture. `agentcore dev` primarily gives you the local Runtime-oriented development experience; Gateway itself is still a managed service.

---

## 24. Creating Gateway with the AgentCore CLI

You can configure Gateway resources through the CLI.

A simple development Gateway can use no inbound auth:

```bash
agentcore add gateway \
  --name TestGateway \
  --authorizer-type NONE
```

A Lambda target can be added with:

```bash
agentcore add gateway-target \
  --name TestLambdaTarget \
  --type lambda-function-arn \
  --lambda-arn arn:aws:lambda:us-east-1:123456789012:function:MyFunction \
  --tool-schema-file tools.json \
  --gateway TestGateway
```

Then deploy:

```bash
agentcore deploy
```

A remote MCP server can be added similarly:

```bash
agentcore add gateway-target \
  --name MyMCPTarget \
  --type mcp-server \
  --endpoint https://example.com/mcp \
  --gateway TestGateway
```

OpenAPI targets are also supported through the CLI.

---

## 25. Gateway Must Exist Before an Agent Uses It

A Gateway is an AWS resource. The normal lifecycle is:

```text
define Gateway
      ↓
define Gateway targets
      ↓
deploy Gateway
      ↓
obtain Gateway endpoint
      ↓
configure MCP client
      ↓
agent invokes tools
```

Gateway can be created through:

- AgentCore CLI
- AWS SDK
- CloudFormation
- AWS CDK
- AWS console where supported

---

## 26. Gateway Authentication

Gateway has its own inbound authentication configuration.

Current inbound options include:

- JWT / OAuth
- IAM / SigV4
- authenticate-only modes
- no auth for development/testing scenarios

This is independent from Runtime's inbound auth boundary.

```text
User
 │
 ▼
Runtime auth
 │
 ▼
Agent
 │
 ▼
Gateway auth
 │
 ▼
Tool
```

---

## 27. Gateway Outbound Credentials

Gateway also needs a way to authenticate **to the target**.

```text
Gateway
   │
   ├── IAM role → Lambda / AWS
   ├── OAuth → SaaS
   ├── API key → external API
   └── SigV4 → AWS-hosted endpoint
```

This is distinct from inbound Gateway authentication.

```text
Who can call Gateway?
```

is different from:

```text
What credentials does Gateway use against the target?
```

---

## 28. AgentCore Gateway and Cognito

Cognito can be used as an OAuth/OIDC identity provider for Gateway and Runtime.

Typical discovery URL:

```text
https://cognito-idp.<region>.amazonaws.com/<user-pool-id>/.well-known/openid-configuration
```

You configure AgentCore with:

- discovery URL
- allowed client IDs
- optionally expected audiences / authorization constraints

Then:

```text
User authenticates with Cognito
        ↓
receives JWT
        ↓
calls AgentCore
        ↓
AgentCore validates JWT
        ↓
request reaches Runtime/Gateway
```

AgentCore can consume an **existing Cognito User Pool**. When you explicitly configure an existing OIDC/Cognito provider, AgentCore does not require that it own that identity system.

---

## 29. Runtime Authentication

AgentCore Runtime supports inbound authentication models including:

```text
IAM / SigV4
OAuth 2.0 / JWT
```

JWT validation uses identity-provider discovery metadata.

Typical Cognito flow:

```text
React / client
      │
      ▼
Cognito
      │
      ▼
JWT access token
      │
      ▼
AgentCore Runtime
      │
JWT validation
      ▼
agent invocation
```

For service-to-service invocation inside AWS, IAM/SigV4 is often the cleaner model.

---

## 30. AgentCore CLI Deployment

The normal deployment command is:

```bash
agentcore deploy
```

The CLI performs roughly this flow:

```text
read project configuration
        ↓
validate
        ↓
package code
        ↓
synthesize CDK
        ↓
CloudFormation
        ↓
provision/update AWS resources
        ↓
create/update Runtime endpoint
        ↓
configure logging / outputs
```

Preview changes with:

```bash
agentcore deploy --dry-run
```

---

## 31. No Hand-Written CDK Is Required for the Standard CLI Flow

You do **not** need to manually write a CDK stack just to deploy an AgentCore application.

```text
agentcore deploy
      │
      ▼
AgentCore CLI
      │
      ▼
@aws/agentcore-cdk
      │
      ▼
CDK synthesis
      │
      ▼
CloudFormation
      │
      ▼
AWS resources
```

The generated project contains an `agentcore/cdk/` directory because this infrastructure layer actually exists; the CLI manages it for you.

---

## 32. CDK Bootstrapping

Because the CLI uses CDK, the target account/region must be bootstrapped.

The CLI normally handles initial bootstrapping where permissions allow it.

The standard CDK bootstrap stack supplies roles for:

- deployment
- CloudFormation execution
- file publishing
- image publishing
- lookups

In restrictive enterprise environments, an administrator may need to handle bootstrapping explicitly.

---

## 33. CodeZip Deployment

AgentCore supports direct code deployment.

```text
source code
    ↓
package dependencies
    ↓
ZIP
    ↓
S3
    ↓
AgentCore Runtime
```

Advantages:

- no Dockerfile required
- no manual ECR workflow
- faster iteration
- less container plumbing

For supported Python and Node configurations, this is usually the simplest deployment path.

---

## 34. Container Deployment

AgentCore also supports container artifacts.

```text
source
   ↓
Docker build
   ↓
ARM64-compatible image
   ↓
ECR
   ↓
AgentCore Runtime
```

Container deployment is valuable when you require:

- custom system dependencies
- OS packages
- controlled container environment
- existing Docker workflows
- unusual native dependencies
- custom build behavior

The AgentCore CLI can build and publish the image when configured for Container build mode.

---

## 35. CodeZip vs Container

### Use CodeZip when

- standard Python/Node environment is enough
- rapid iteration matters
- no special OS packages
- no unusual native requirements

### Use Container when

- you already maintain container workflows
- native dependencies matter
- OS-level packages are required
- deterministic container parity matters
- you need more artifact control

Both ultimately run in:

```text
AgentCore Runtime
```

The difference is how the executable artifact is delivered.

---

## 36. What Deployment Creates

After deployment, use:

```bash
agentcore status
```

Important outputs can include:

- Runtime ARN
- Runtime endpoint information
- Gateway URL
- Gateway identifiers
- deployment status
- resource details

Runtime resources have AWS ARNs, conceptually:

```text
arn:aws:bedrock-agentcore:<region>:<account>:runtime/<runtime-id>
```

---

## 37. Invoking a Deployed Agent from the CLI

The simplest deployed test is:

```bash
agentcore invoke --prompt "Hello, what can you do?"
```

So:

```text
LOCAL TEST

agentcore dev
    ↓
localhost


DEPLOYED TEST

agentcore deploy
    ↓
agentcore invoke
    ↓
AWS Runtime
```

---

## 38. Programmatic Runtime Invocation

Backend applications can use the AWS SDK.

Python conceptually:

```python
import boto3
import json

client = boto3.client("bedrock-agentcore")

response = client.invoke_agent_runtime(
    agentRuntimeArn=runtime_arn,
    payload=json.dumps({
        "prompt": "Hello"
    }).encode()
)
```

Exact response handling depends on streaming/non-streaming behavior and your application protocol.

Using the AWS SDK is usually easier than manually constructing SigV4 HTTP requests for backend-to-AgentCore communication.

---

## 39. Direct HTTP Runtime Invocation

AgentCore also exposes Runtime through service endpoints.

For JWT-authenticated client scenarios, the request conceptually looks like:

```text
POST AgentCore Runtime invocation URL

Authorization: Bearer <JWT>
Content-Type: application/json

{
  ...
}
```

AgentCore validates the token before your application receives the payload.

For IAM-authenticated invocation, requests use SigV4 signing.

---

## 40. Dev Invocation vs Production Invocation

```text
DEV
──────────────────────────

agentcore dev
     ↓
localhost:8080
     ↓
your code


PRODUCTION
──────────────────────────

agentcore deploy
     ↓
AgentCore Runtime ARN
     ↓
managed Runtime endpoint
     ↓
your deployed code
```

The local server is designed to make the application boundary closely resemble Runtime behavior.

---

## 41. CDK Support

You are not limited to the AgentCore CLI.

AgentCore has CloudFormation resources and CDK constructs.

As of October 2026, most major AgentCore constructs have graduated into the stable CDK library:

```typescript
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
```

Stable areas include constructs for:

- Runtime
- Runtime Endpoint
- Gateway
- Gateway Target
- Memory
- Browser
- Code Interpreter
- Evaluation
- Identity credential providers

Policy remains one of the notable areas where CDK support is still partially experimental/alpha.

---

## 42. Stable CDK Gateway Example

At a high level:

```typescript
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
```

Create a Gateway:

```typescript
const gateway = new agentcore.Gateway(this, "Gateway", {
  gatewayName: "my-gateway",
});
```

The stable `GatewayTarget` construct includes convenience methods for target types such as:

```text
forLambda(...)
forOpenApi(...)
forSmithy(...)
forMcpServer(...)
forApiGateway(...)
```

A conceptual Lambda target is:

```typescript
agentcore.GatewayTarget.forLambda(this, "SearchTarget", {
  gateway,
  lambdaFunction: searchFunction,
  toolSchema,
});
```

The exact `toolSchema` value uses AgentCore's CDK schema abstraction.

The important relationship is:

```text
Lambda
   +
tool schema
   +
Gateway
   ↓
GatewayTarget
```

---

## 43. CDK Runtime

Runtime can also be defined directly using stable CDK constructs.

The Runtime construct accepts concepts including:

- runtime artifact
- authorizer configuration
- environment variables
- execution role
- lifecycle configuration
- logging
- network configuration
- protocol configuration
- request-header configuration
- runtime name
- tracing

This means AgentCore infrastructure can be managed completely through IaC if you do not want the AgentCore CLI to own deployment.

---

## 44. CLI CDK vs Direct CDK

There are effectively two infrastructure-development modes.

### Mode A: AgentCore CLI

```text
agentcore.json
       ↓
AgentCore CLI
       ↓
@aws/agentcore-cdk L3
       ↓
CDK
       ↓
CloudFormation
```

Advantages:

- fast onboarding
- generated project
- local dev integration
- standardized deployment workflow
- less infrastructure code

### Mode B: Direct CDK

```text
your CDK application
       ↓
aws-cdk-lib/aws-bedrockagentcore
       ↓
CloudFormation
```

Advantages:

- resources stay in your own CDK graph
- direct references to existing AWS resources
- explicit dependency control
- direct environment-variable propagation
- standard IaC lifecycle

Both ultimately create AgentCore AWS resources.

---

## 45. `@aws/agentcore-cdk`

AWS also publishes:

```text
@aws/agentcore-cdk
```

This is the higher-level L3 construct package used by the AgentCore CLI.

It includes abstractions such as:

```text
AgentCoreApplication
AgentCoreMcp
AgentCoreProjectSpec
```

It is currently published as an early/alpha-versioned package.

The CLI generates/vends a CDK project that uses these L3 constructs.

For lower-level stable resource composition, the standard stable module is:

```text
aws-cdk-lib/aws-bedrockagentcore
```

for most non-Policy AgentCore constructs.

---

## 46. AgentCore Gateway Through CDK

You can create all of the following as IaC:

```text
Gateway
   │
   ├── authorizer
   ├── execution role
   ├── protocol configuration
   │
   └── Gateway Targets
          │
          ├── Lambda
          ├── OpenAPI
          ├── API Gateway
          ├── Smithy
          └── remote MCP
```

Gateway therefore does not require one-time manual console setup. It can participate normally in CloudFormation/CDK deployments.

---

## 47. Environment Variables and Endpoint Injection

Runtime supports environment variables.

A normal pattern is:

```text
Gateway deployed
     ↓
Gateway URL
     ↓
Runtime environment variable
     ↓
agent reads configuration
     ↓
MCP client connects
```

For example, application code may simply read:

```text
AGENTCORE_GATEWAY_URL
```

The application does not have to know how that value was created.

---

## 48. Gateway Sessions

Gateway MCP sessions can be enabled when stateful MCP behavior is needed.

Sessions can support advanced features such as:

- elicitation
- sampling
- multi-request state

For authenticated Gateways, sessions are scoped to the verified identity/principal.

Unauthenticated Gateway sessions are appropriate only for development/testing because leaked session IDs are not user-bound.

---

## 49. Runtime Sessions vs Gateway Sessions vs LangGraph Threads

These are separate concepts.

```text
AgentCore Runtime Session
─────────────────────────
compute/execution session


Gateway MCP Session
─────────────────────────
MCP protocol session


LangGraph Thread
─────────────────────────
logical graph/conversation execution
```

Do not automatically use one identifier for all three unless that mapping is deliberate.

---

## 50. Gateway HTTP and Inference Targets

Gateway now does more than MCP aggregation.

### MCP target

Aggregates tool capabilities into a unified MCP surface.

### HTTP target

Proxies HTTP traffic directly to a target such as:

- AgentCore Runtime
- A2A agent
- external HTTP service

HTTP targets are addressed directly rather than merged into a `tools/list` surface.

### Inference target

Routes model/inference traffic through a unified interface across supported providers.

```text
AgentCore Gateway

├── MCP plane
│   └── tools / prompts / resources
│
├── HTTP plane
│   └── agents / endpoints
│
└── inference plane
    └── model providers
```

---

## 51. Gateway Capability Synchronization

For MCP server targets, Gateway can synchronize advertised capabilities.

Remote MCP servers may expose:

- tools
- prompts
- resources

Gateway can discover and index those capabilities.

For larger tool ecosystems, Gateway also supports semantic tool discovery/search rather than requiring every tool schema to be blindly included in every model context.

---

## 52. Security Mental Model

A useful security model is:

```text
USER
 │
 │ identity token / IAM
 ▼
RUNTIME
 │
 │ agent execution
 ▼
AGENT
 │
 │ tool request
 ▼
GATEWAY
 │
 │ policy + outbound credentials
 ▼
TARGET
```

Each arrow can have its own trust and authorization model.

Never treat:

```text
“The model selected this tool.”
```

as equivalent to:

```text
“The caller is authorized to perform this action.”
```

---

## 53. Runtime + Cognito Example

Suppose you already have:

```text
Cognito User Pool
+
App Client
```

The client authenticates normally.

```text
Client
  │
  │ Bearer JWT
  ▼
AgentCore Runtime
  │
  │ validates token using Cognito OIDC discovery
  ▼
LangGraph
```

Your AgentCore configuration contains the identity-provider discovery URL and allowed client/audience configuration.

---

## 54. Gateway + Cognito Example

Gateway can independently use Cognito JWT authorization.

Conceptual CLI configuration:

```bash
agentcore add gateway \
  --name MyGateway \
  --protocol-type MCP \
  --authorizer-type CUSTOM_JWT \
  --discovery-url \
    https://cognito-idp.us-east-1.amazonaws.com/<POOL_ID>/.well-known/openid-configuration \
  --allowed-clients <CLIENT_ID>
```

Then:

```text
MCP client
   │
Authorization: Bearer JWT
   ▼
Gateway
   │
JWT validated
   ▼
tools available
```

---

## 55. What Happens to Existing Agent Code

If you already have a LangGraph server with:

- graph
- checkpointing
- interrupts
- tools
- model configuration

then you normally do **not** rebuild those concepts using AgentCore.

The integration boundary is:

```text
existing graph
      │
      ▼
AgentCore-compatible entrypoint
      │
      ▼
Runtime
```

Then optionally:

```text
graph tool layer
      │
      ▼
MCP client
      │
      ▼
Gateway
```

---

## 56. Minimal LangGraph + AgentCore Concept

Representative application structure:

```text
agent/
│
├── main.py
├── graph.py
├── nodes.py
├── tools.py
└── requirements
```

Graph:

```python
# graph.py

builder = StateGraph(State)

builder.add_node("reason", reason)
builder.add_node("tools", tools)
builder.add_node("approval", approval)

# edges...

graph = builder.compile(
    checkpointer=checkpointer
)
```

AgentCore boundary:

```python
# main.py

from bedrock_agentcore.runtime import BedrockAgentCoreApp
from graph import graph
from langgraph.types import Command

app = BedrockAgentCoreApp()

@app.entrypoint
def invoke(payload, context):
    thread_id = payload["thread_id"]

    config = {
        "configurable": {
            "thread_id": thread_id
        }
    }

    if "resume" in payload:
        input_value = Command(
            resume=payload["resume"]
        )
    else:
        input_value = payload["input"]

    return graph.invoke(
        input_value,
        config=config
    )

app.run()
```

This is illustrative; define your payload contract deliberately.

---

## 57. Adding Gateway to That Agent

The graph can build tools from multiple sources:

```python
local_tools = [...]
gateway_tools = await load_mcp_tools(...)

all_tools = [
    *local_tools,
    *gateway_tools
]
```

Then:

```text
LangGraph
  │
  ├── local tool
  │
  └── MCP tool
        │
        ▼
      Gateway
```

Runtime and Gateway are independent AgentCore services. You can use one without the other.

---

## 58. Runtime Without Gateway

Perfectly valid:

```text
AgentCore Runtime
      │
      ▼
LangGraph
      │
      ├── direct AWS SDK calls
      ├── direct database calls
      ├── local tools
      └── direct APIs
```

Gateway is not mandatory.

---

## 59. Gateway Without Runtime

Also valid:

```text
ECS-hosted LangGraph
      │
      ▼
MCP client
      │
      ▼
AgentCore Gateway
```

The agent does not need to execute in AgentCore Runtime to use Gateway.

This modularity is one of AgentCore's most important properties.

---

## 60. A Useful Development Workflow

### One-time / occasional cloud setup

```text
deploy dev Gateway
deploy dev targets
deploy supporting AWS services
```

### Daily development

```bash
agentcore dev
```

Then:

```text
edit code
  ↓
hot reload
  ↓
invoke locally
  ↓
LangGraph
  ↓
real dev Gateway
  ↓
real dev Lambda/APIs
```

### When ready

```bash
agentcore deploy
```

Then:

```bash
agentcore invoke --prompt "..."
```

or invoke from your application/backend.

---

## 61. A Useful Production Workflow

```text
source code
   ↓
tests
   ↓
agentcore deploy
   ↓
CodeZip → S3
       OR
Container → ECR
   ↓
CDK / CloudFormation
   ↓
Runtime version
   ↓
Runtime endpoint
   ↓
application invokes Runtime
```

Gateway resources may be deployed in the same AgentCore project or managed separately.

---

## 62. What You Manage vs What AWS Manages

### You manage

```text
agent behavior
prompts
graph
tool semantics
domain model
checkpoint model
application APIs
authorization rules
RAG strategy
business data
payload contracts
```

### AgentCore can manage

```text
agent compute
runtime lifecycle
deployment
endpoint
session isolation
Gateway
tool aggregation
credential integration
identity integration
browser sandbox
code sandbox
telemetry
evaluation
optimization
```

---

## 63. When the AgentCore CLI Is the Right Interface

Use the CLI when you want:

- fastest AgentCore onboarding
- standard project structure
- managed local dev workflow
- automatic CDK generation
- automatic artifact packaging
- simplified Gateway configuration
- CLI-driven deployment
- fast experimentation

---

## 64. When Direct CDK Is the Right Interface

Use direct CDK when you need:

- AgentCore resources inside a larger CDK application
- direct references to existing AWS resources
- explicit dependency control
- one CloudFormation/IaC graph
- sophisticated environment wiring
- custom IAM
- custom networking
- centralized infrastructure conventions

Neither approach is inherently “more AgentCore.” They are different management interfaces for the same AWS resources.

---

## 65. Current CDK Packaging Summary

As of this document's verification date:

### Stable CDK

```text
aws-cdk-lib/aws-bedrockagentcore
```

Includes most major L2 constructs.

### AgentCore CLI L3 package

```text
@aws/agentcore-cdk
```

Used by the CLI's generated/vended CDK project.

### Legacy / remaining alpha areas

```text
@aws-cdk/aws-bedrock-agentcore-alpha
```

Most constructs have graduated from this module to stable. Policy is the major area still documented as experimental/alpha in the construct library.

---

## 66. Debugging Mental Checklist

### Can't start locally

Look at:

```text
agentcore dev
dependency installation
port 8080
TypeScript compilation
Python environment
```

### Local agent runs but tools fail

Look at:

```text
Gateway endpoint
MCP auth
Gateway target status
Gateway outbound credentials
Lambda permissions
tool schema
network path
```

### Deployed Runtime fails

Look at:

```text
artifact
runtime logs
environment variables
IAM role
network configuration
Runtime lifecycle
architecture compatibility
```

### Cognito JWT fails

Look at:

```text
discovery URL
issuer
client ID
audience
token type
token expiry
allowed claims
```

### LangGraph resume fails

Look at:

```text
thread_id
durable checkpoint
Command(resume=...)
checkpoint database availability
```

---

## 67. Fast Cheat Sheet

```text
I want to scaffold an AgentCore app
→ agentcore create

I want to run locally
→ agentcore dev

I want to check config
→ agentcore validate

I want to deploy
→ agentcore deploy

I want to preview deployment
→ agentcore deploy --dry-run

I want deployed resource info
→ agentcore status

I want to test deployed Runtime
→ agentcore invoke

I want my LangGraph code hosted
→ AgentCore Runtime

I want Lambda/API tools exposed through MCP
→ AgentCore Gateway

I want my local agent to test real Gateway tools
→ agentcore dev + MCP client pointed at deployed dev Gateway

I want existing Cognito users to call Runtime/Gateway
→ configure CUSTOM_JWT with Cognito OIDC discovery

I want graph interrupts to survive Runtime termination
→ durable LangGraph checkpointer

I want no Docker
→ CodeZip

I need custom OS/native dependencies
→ Container / ECR

I do not want to write CDK
→ AgentCore CLI

I do want full IaC control
→ aws-cdk-lib/aws-bedrockagentcore
```

---

## 68. Complete Mental Model

```text
                         DEVELOPMENT

Developer
   │
   ├── edit LangGraph / agent code
   │
   ▼
agentcore dev
   │
   ▼
Local Runtime-compatible server
   │
   ▼
LangGraph
   │
   ├── local tools
   ├── local/remote checkpoint DB
   ├── Bedrock / model provider
   │
   └── MCP client
           │
           ▼
      Dev AgentCore Gateway
           │
           ├── Lambda
           ├── API Gateway
           ├── REST/OpenAPI
           ├── remote MCP
           └── SaaS


                         DEPLOYMENT

source
  │
  ▼
agentcore deploy
  │
  ├── CodeZip → S3
  │
  └── Container → ECR
  │
  ▼
CDK / CloudFormation
  │
  ▼
AgentCore Runtime
  │
  ▼
Runtime ARN / endpoint


                         PRODUCTION

Client
  │
  │ JWT / IAM
  ▼
AgentCore Runtime
  │
  ▼
LangGraph
  │
  ├── durable checkpointer
  ├── local tools
  │
  └── MCP client
          │
          ▼
     AgentCore Gateway
          │
          ├── Identity / credentials
          ├── policy / authorization
          │
          ├── Lambda
          ├── APIs
          ├── MCP
          └── other services
```

---

## 69. The Five Concepts to Remember

### 1. LangGraph is still your agent logic

AgentCore does not replace nodes, edges, interrupts, tools, or checkpoints.

### 2. Runtime is where the agent executes

It replaces much of the infrastructure work you would otherwise do with ECS/EKS/custom hosting.

### 3. `agentcore dev` is the local Runtime-oriented development loop

Your code is local, but it can still talk to real AWS resources.

### 4. Gateway is a separate managed connectivity plane

Your agent reaches it like an MCP/HTTP client. Gateway does not need to live inside Runtime.

### 5. The CLI is an abstraction over CDK/CloudFormation

You can use the CLI and write no CDK, or use AgentCore CDK constructs directly when you want explicit IaC control.

---

## 70. Official AWS References

Primary sources used to verify this document:

- Amazon Bedrock AgentCore overview  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html

- AgentCore interfaces and CLI  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/develop-agents.html

- AgentCore CLI getting started  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-cli.html

- TypeScript AgentCore CLI  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-cli-typescript.html

- Use any agent framework / LangGraph  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/using-any-agent-framework.html

- AgentCore Runtime architecture  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-how-it-works.html

- Runtime lifecycle  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-lifecycle-settings.html

- Runtime HTTP protocol  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html

- Direct code deployment for Python  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-code-deploy-python.html

- Gateway concepts  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-core-concepts.html

- Gateway setup workflow  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-building.html

- Gateway usage / MCP  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-using.html

- Gateway tool invocation  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-using-mcp-call.html

- Lambda Gateway targets  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-add-target-lambda.html

- Gateway target CLI  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-add-target-cli.html

- Gateway inbound authentication  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-inbound-auth.html

- AgentCore inbound JWT authorization  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/inbound-jwt-authorizer.html

- Cognito integration  
  https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity-idp-cognito.html

- Stable AgentCore CDK module  
  https://docs.aws.amazon.com/cdk/api/v2/python/aws_cdk.aws_bedrockagentcore.html

- AgentCore CDK Runtime  
  https://docs.aws.amazon.com/cdk/api/v2/python/aws_cdk.aws_bedrockagentcore/Runtime.html

- AgentCore CDK Gateway Target  
  https://docs.aws.amazon.com/cdk/api/v2/python/aws_cdk.aws_bedrockagentcore/GatewayTarget.html

- AgentCore CDK migration / alpha status  
  https://docs.aws.amazon.com/cdk/api/v2/python/aws_cdk.aws_bedrock_agentcore_alpha/README.html

- AgentCore L3 CDK package  
  https://www.npmjs.com/package/@aws/agentcore-cdk

---

## Final Summary

AgentCore is easiest to understand when you stop treating it as an agent framework.

Your code still defines the agent:

```text
LangGraph / Strands / custom framework
```

AgentCore gives that code an AWS-native production environment:

```text
local dev
deployment
managed Runtime
secure endpoint
session isolation
Gateway/MCP
Identity
Cognito/JWT
tool credentials
CDK/CloudFormation
observability
evaluation
```

The practical lifecycle is:

```text
write agent
    ↓
agentcore dev
    ↓
test locally
    ↓
connect to dev Gateway if needed
    ↓
agentcore deploy
    ↓
CodeZip/S3 or Container/ECR
    ↓
AgentCore Runtime
    ↓
Runtime ARN / endpoint
    ↓
invoke through CLI, SDK, or authenticated client
```

That is the developer-level model to keep in your head.
