# Framework architecture infographic

Generated with the built-in image generation tool. This is a conceptual illustration of the current source architecture; production capabilities are not evidence of deployed behavior.

## Initial generation prompt

+Use case: infographic-diagram.
Create a high-resolution 3D isometric technical infographic of the user's actual TypeScript AWS application framework, grounded in the architecture below. This is a polished enterprise architecture poster, not generic cloud clipart. Render at the highest available resolution, ideally 3840 x 2160 or larger, with a wide landscape 16:9 layout. Dark futuristic enterprise IT style: deep midnight navy background, subtle blueprint grid, smoked glass panels, graphite metal, precise beveled server blocks, cyan and teal light traces, violet control-plane traces, restrained amber AWS accents. Premium physically rendered isometric miniature architecture combined with crisp flat front-facing typography. All text large, sharp, spelled correctly, high contrast, uncluttered. Do not tilt labels into unreadability. Generous spacing and clean composition, no tiny paragraphs, no meaningless code, no watermarks.

TOP TITLE, exact: "MATT'S AWS FRAMEWORK"
Subtitle exact: "Typed declarations • AWS infrastructure • Local execution"
This is a conceptual source architecture, not a claim that these services have been deployed or live-tested.

Composition:
Top-center, a prominent luminous authoring/control platform with three clearly labeled modules:
"framework.config.ts" / smaller "Workloads + bindings"
"resources.ts" / smaller "Resources + grants + secrets"
"contract.prisma" / smaller "Storage contract"
The first two feed a small central violet node labeled "Validate + generate", branching with clearly directional dashed violet lines to "AWS CDK", "Local adapters", "Typed client contracts". contract.prisma has its own generation connection to the bottom typed data pipeline. Control-plane dashed lines should visibly differ from solid runtime arrows. The composition root describes HTTP, WebSocket, events, services, tasks, workflows, agents and tools; represent these as a neat thin labeled ribbon "HTTP · WebSocket · Events · Services · Tasks · Workflows · Agents · Tools" under the authoring platform, not eight huge repeated boxes.

Middle-left, a clearly bounded teal platform labeled "LOCAL DEVELOPMENT".
A React browser at the outer left, label "React + TanStack Query", routes via a clear solid cyan arrow labeled "same-origin /api" into "Vite proxy", then "Local API / WebSocket". Arrange local compute blocks behind it:
"Lambda processes"
"Container services"
"Invocation runner" with smaller label "Tasks · Workflows · Agent sessions"
A local database cylinder labeled "Local PostgreSQL".
Solid data connection from local API to Lambda processes to local PostgreSQL.
Beside container services, a small explicit badge "LangGraph: local-only".
Inside invocation runner show one compact agent session block → "Emulated Gateway" → "Tool handler", and one small badge "echo-agent: local-only".
Include a modest labeled developer-cloud side bridge along the bottom of the local platform: "Dev AWS: Cognito · Events · Replay · Resources". It connects via narrow cyan lines to the local platform; local development is hybrid with real AWS identity/resources, not entirely offline.

Middle-right, a clearly bounded amber-accent cloud platform labeled "AWS PRODUCTION TARGET".
At its front edge put "CloudFront + S3" connected to browser, a small browser-facing route label "same-origin /api".
Solid arrow from CloudFront to "HTTP API Gateway", then "Lambda / GraphQL" then database cylinder "RDS PostgreSQL".
Above or behind this standard API lane place "Cognito" as an identity shield, with thin teal auth connections to HTTP API Gateway and AgentCore; identity and authorization are explicit. A subtle small caption under shield: "Verified identity + application authorization".
Further back: "ECS services + tasks" and "Step Functions", connected by short solid runtime arrows showing declared orchestration. A separate small "WebSocket API" block with an optional badge "Optional", bidirectional connection to a browser.
A security/resource utility rail on far-right or behind: "IAM grants", "Secrets Manager", "AWS resources"; small resource caption "S3 · SQS · SNS · EventBridge · DynamoDB". These are shared declared resource capabilities, not implying all are application-critical. Runtime permissions originate from declared bindings. Keep utility rail visually secondary.
An AgentCore capability lane on the production platform: "AgentCore Runtime" → "Per-agent Gateway" → "Lambda tools". Route a distinct cyan solid line from CloudFront DIRECTLY to AgentCore Runtime labeled "/api/agents/* · stream". Do NOT route the agent stream through HTTP API Gateway or an intermediate Lambda. From Lambda tools connect to the resource rail/data access; do NOT show direct agent-to-database connection. Add concise badge "Cloud-enabled agents only" so the local-only echo example is not falsely depicted deployed. This lane illustrates framework capability. Agents get only tools they declare.
CloudFront same-origin API and agent routes apply to the configured frontend-domain path; show a small unobtrusive caption "Configured frontend domain" directly under CloudFront.
Label connection between local and AWS platforms with a clear concise central badge "One declaration graph · Two execution lanes". No promise of identical security or full deployment parity.

BOTTOM, a clean front-facing technical ribbon labeled "TYPED DATA FEATURE PIPELINE", with spaced arrow-connected tiles in EXACT order:
"Prisma contract" → "Repository" → "Pothos GraphQL" → "Generated operations" → "Query / mutation options" → "React"
Use a small under-caption "Public fields, validation and ownership stay explicit".
This ribbon represents development-time type propagation, not a runtime database request direction.

Footer legend compact:
violet dashed line: "Generated wiring"
cyan solid arrow: "Runtime traffic"
amber small badge: "AWS infrastructure"
small footer "Source architecture • Current examples marked local-only"

Composition priorities: largest visual emphasis on central declarations deriving two execution lanes, with clean readable runtime paths; second emphasis on GraphQL data path and agent/tools boundary. 3D depth should enhance hierarchical grouping, with a front-facing poster composition and beautiful dramatic lighting. Technical content is important: label correctness, arrow directions, service grouping and the distinction between local-only examples and production capability. Avoid impossible giant spaghetti of crossings; use neatly routed traces with intentional branches and tidy cable channels. Do not invent Kubernetes, Redis, AppSync, vector database, or external services. No UI screenshots, no decorative robot, no random numerical metrics, no security credentials.

## Refinement prompt

+Edit the previous generated infographic. Preserve its entire visual style, layout, resolution, labels and beautiful 3D architecture. Make ONLY these precise technical corrections:
1. Remove the vertical cyan arrow from the "HTTP API Gateway" block down into the AgentCore lane. There must be NO line from HTTP API Gateway to AgentCore Runtime.
2. The cyan line labeled "/api/agents/* · stream" must originate at the bottom edge of "CloudFront + S3", go down and bend right with arrowhead INTO "AgentCore Runtime". The browser only connects to CloudFront for that route. Remove the current lower direct Browser-to-AgentCore branch. Keep the browser-to-WebSocket bidirectional line.
3. Reverse the short arrow between "ECS services + tasks" and "Step Functions": arrow must point FROM Step Functions TO ECS services + tasks, since the workflow starts tasks.
4. On the local React browser illustration remove the invented "http://localhost:5173" tiny text; replace it with "React frontend".
5. Change the top-left control-plane caption from "TypeScript declarations define your entire application" to "Typed declarations derive infrastructure and routing". Change the AWS platform subtitle from "Deployed with the same declarations (conceptual architecture)" to "Cloud deployment capability from the same declarations". This image is a source architecture diagram, not a claim of actual deployment.
Keep all other objects, titles, exact filename labels, datatype pipeline, local-only badges, colors, arrows, grouping and overall composition unchanged. Maintain highest available output resolution, premium crisp text.
