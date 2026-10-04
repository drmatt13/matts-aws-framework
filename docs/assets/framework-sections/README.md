# Framework section diagrams

Seven technical whitepaper figures generated with the built-in image tool, checked against current repository source. Each PNG is independent. The original reference SVGs are unchanged.

The figures distinguish development-time generation, runtime calls, and identity/resource context. They describe source architecture and capabilities, not proof of deployment. Use the connection specifications below when redrawing.

## 1. Authoring and contract generation

- Framework configuration plus resources feed framework generation.
- contract.prisma feeds database contract emission inside the coordinated contract pipeline.
- Authored GraphQL schema and documents feed GraphQL Codegen.
- npm run contract runs framework generation, database emission, GraphQL Codegen, then consumer typechecking.
- Generated artifacts have development-time relationships to consumers, not runtime network calls.
- CDK builders and local adapters read the workload declarations and resource catalog directly.
- Application CDK constructs are linked to the resource catalog with linkResources.
- Generators do not infer public exposure or authorization, apply migrations, or deploy AWS.

## 2. Local development

- React → Vite /api proxy → local HTTP server.
- Local HTTP → Lambda executor → shared handler → local PostgreSQL.
- Local HTTP → service proxy → persistent Compose service.
- Local HTTP → invocation runner → task containers / workflow interpreter / agent sessions.
- Browser WS client ↔ local WS server → WS executor; it is a separate transport.
- HTTP and WS identity verification use Cognito ID-token signing keys.
- Manifest and authored inputs independently feed local environment resolution; it supplies local compute.
- Local permitted compute accesses declared development AWS resources using development credentials.
- Local workflow/callback state is in memory; local-only examples include LangGraph and echo-agent/echo tool.

## 3. AWS production capabilities

- Browser → CloudFront; static assets → S3; /api/* → HTTP API Gateway.
- HTTP gateway → GraphQL Lambda → RDS PostgreSQL.
- HTTP gateway → VPC link → internal ALB → ECS Fargate service.
- Caller → startWorkflow → Step Functions → event Lambda / ECS task / declared integration.
- Caller → runTask → ECS task; returned identifiers acknowledge submission.
- CloudFront → AgentCore Runtime → per-agent Gateway → Lambda tools; agent streaming bypasses HTTP API Gateway.
- Browser WS client ↔ WebSocket API Gateway → route Lambdas.
- Cognito is identity context for authenticated boundaries; CloudFront forwards requests.
- IAM applies to Secrets Manager and other resources independently; Secrets Manager is not a hop to all AWS resources.
- Current Lambdas are outside a VPC and RDS is publicly accessible; service ALB is internal. Task and service clusters are separate.
- Only enabled workloads deploy. HTTP/agent same-origin routing requires the configured frontend-domain path.

## 4. Hybrid development and event replay

- AWS event → replay-enabled capture wrapper → S3 event envelope → SQS object-created notification.
- Local dispatcher polls SQS, fetches the event envelope from S3, and invokes the shared handler through local executor.
- Delete notification only after successful handler execution; failures can retry/redrive.
- Replay is development-only. Production wrapper invokes handler directly.
- Synchronous Cognito capture returns expected trigger response; replayed side effects are asynchronous.
- Local workflow → AWS development Express bridge → bound AWS operation / credentialed HTTPS call.
- Direct managed resource integrations remain in AWS; bridges are not required for every AWS call.

## 5. WebSocket route parity

- Local and cloud instantiate the same authorizer and handler source independently.
- Connect → $connect authorizer → allowed $connect handler.
- Messages select a named action or $default; connection close invokes $disconnect.
- Cognito ID-token verification establishes connection principal/context; route events carry it.
- Message-handler reply → transport → connected browser.
- Explicit push is separate: handler → webSocketConnections(event).send → local internal management endpoint OR AWS Management API → browser.
- Push requires cloud.manageConnections; the current sample declarations do not enable the grant.

## 6. AgentCore and tool boundary

- Cloud browser → CloudFront → AgentCore Runtime → per-agent Gateway → Lambda tool → resource.
- Stream events return Runtime → CloudFront → browser.
- Local browser → Vite → local API → runner session → emulated Gateway → tool executor → resource.
- The Gateway derives exactly the agent's declared tools; hosted runtime-to-Gateway calls use IAM.
- Authenticated tools verify forwarded identity and validate arguments; application authorization remains explicit.
- Backend invokeAgent returns non-streaming responses; user agents require caller session, service agents use IAM.
- Agents deploy as Node code from S3; local sessions are processes, hosted sessions use AgentCore isolation.

## 7. Typed data feature pipeline

- Authored storage contract → emitted contract JSON/types → derived records and explicit write inputs → repositories → explicit Pothos schema/resolvers → GraphQL documents → Codegen → typed results/variables → query/mutation options → React.
- Generated artifacts are distinct from authored application source; a column is not automatically public or writable.
- Runtime: React → authenticated GraphQL endpoint → Yoga → Pothos resolver → repository → Rust-free Prisma PostgreSQL runtime → PostgreSQL.
- Yoga, resolvers, repositories and database runtime execute in the GraphQL handler process. PostgreSQL is the separate database.
- Migration planning is offline; applying reviewed migration SQL is a separate database action.
- Typechecking checks compatibility; executable tests verify behavior and authorization.

## Source anchors

- [Framework](../../FRAMEWORK.md)
- [AgentCore](../../AGENTCORE.md)
- [Data features](../../DATA-FEATURES.md)
- [Database](../../DATABASE.md)
- [Composition root](../../../framework.config.ts)
- [Resource catalog](../../../framework-config/resources.ts)
- [Current RDS implementation](../../../cdk-app/lib/app/rds-stack.ts)

## Generation

prompts.json records all initial prompts and targeted correction prompts. PNG filenames are numbered to match sections 1–7.

## Editable redraw sources and artwork limitations

Each numbered .mmd file is an independent editable Mermaid diagram. Use these sources and the connection specifications above as the authority for connector topology. The PNGs supply the visual layout and whitepaper style.

- Figure 1: explicitly connect both framework configuration and resource catalog to both CDK builders and local adapters; the lower framework-config tile's connection is visually understated.
- Figure 5: the illustrated reply trace passes alongside/behind the disconnect handler. Only customAction and $default produce the shown route replies; $disconnect has no reply edge. The Mermaid source separates these relationships.
- Figure 6: response traces originate at the agent Runtime/session and return through the browser-facing adapters. The local trace's source-end arrowhead should not be read as a response entering the session. The Mermaid source gives the correct request and response directions separately.

These figures describe current source architecture, not a claim that all capabilities have been deployed or live-tested. No application source or original SVG reference was changed for this set.

## Validation

All seven selected PNGs were opened/visually inspected through the image tool output and their dimensions checked: 1536 × 1024. Source relationships were reviewed against the guides and declarations. npm run verify passed during this task. The Mermaid sources are supplied as editable topology specifications; a Mermaid renderer was not run.
