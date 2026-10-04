# Framework architecture — technical whitepaper style

Generated with the built-in image generation tool using rasterized renderings of `matts-aws-framework.svg` and `matts-aws-websocket-dev-kit.svg` as references. The original SVGs are unchanged. Current declarations and source take precedence over historical reference details.

This image describes source architecture and framework capabilities, not proof of a deployed system. Current LangGraph and echo-agent/echo-tool examples are local-only. Local workflow history is in memory; AWS execution uses Step Functions. Services are long-running; tasks run to completion.

## Generation prompt

+Use case: infographic-diagram.
Create a NEW technical whitepaper architecture infographic for "MATT'S AWS FRAMEWORK", using both supplied reference images as architecture references. Image 1 is a rasterized rendering of matts-aws-framework.svg; Image 2 is a rasterized rendering of matts-aws-websocket-dev-kit.svg. The references are historical architecture drawings, not definitive current specification. Update them to the accurate current architecture described below. Do not merely recolor or copy their tangled line layout. Preserve their useful semantics: hybrid local/AWS development, typed GraphQL chain, S3-to-SQS event replay, and SAME WebSocket authorizer/route handler source in both execution lanes.

Style: professional TECHNICAL WHITEPAPER figure, highest available resolution, large landscape architecture plate, about 16:10. Pure white background, generous margins, dark navy crisp sans serif text, thin slate orthogonal connectors, restrained blue/teal for runtime traffic, violet dashed arrows for generated wiring, small AWS orange accents. Matte white and pale slate panels, very subtle isometric component icons and shallow extruded platforms to preserve an elegant 3D architectural feel. Readable front-facing labels. Quiet precise engineering editorial style suitable for a printed enterprise whitepaper. No dark background, no neon, no dramatic lighting, no glowing wires, no decorative robot. Clearly numbered panels, meaningful hierarchy, aligned spacing, elegant concise wording. Use AWS-style icons where helpful and accurate generic symbols elsewhere. All labels must be legible, no tiny dense text, no unnecessary repeated blocks, no blurry text, no meaningless code. This is an informative accurate diagram, not marketing.

Title exact: "MATT'S AWS FRAMEWORK"
Subtitle exact: "One declaration graph. Two execution lanes. Typed application contracts."
Small figure caption: "Source architecture and deployment capabilities"

LAYOUT: top declaration/control band, middle two parallel runtime columns, lower focused detail insets, bottom slim typed-data ribbon. The entire diagram should be cleanly readable without a maze of crossing connectors. Inside the two middle columns use short local arrows. Detail insets elaborate architecture without connecting everything across the page.

Panel 01 top "AUTHORING & GENERATED WIRING"
Three prominent source tiles:
"framework.config.ts" smaller "Workload sections + defaults"
"resources.ts" smaller "Typed resources + bindings + secrets"
"contract.prisma" smaller "Storage contract"
Under first two show "Validate + generate", with dashed violet branches to three output tiles "AWS CDK", "Local adapters", "Typed API contracts". Label workload inventory as a single neat line "HTTP · WebSocket · Events · Services · Tasks · Workflows · Agents · Tools".
contract.prisma gets a separate dashed violet path to bottom data-feature ribbon, never a solid runtime path to CDK. Meaning: typed declarations drive infrastructure and local dispatch, not every detail of application business code.

Panel 02 middle-left "LOCAL DEVELOPMENT"
A compact browser tile "React + TanStack Query" → labeled "same-origin /api" → "Vite proxy" → "Local HTTP server". Local HTTP server then branches:
(a) "Lambda executor" smaller "Shared handler source" → "PostgreSQL container", labeled route "/graphql", tiny GraphQL label "Yoga + Pothos".
(b) "Service proxy" → "Compose services" smaller "Long-running servers".
(c) "Invocation runner" smaller "Tasks · Workflows · Agent sessions".
Under runner put three tidy short capability tiles, no diagram spaghetti:
"Task containers" subtitle "Build → run → exit"
"Workflow interpreter" subtitle "Shared graph · in-memory history"
"Agent sessions" subtitle "Per-conversation processes".
Side small separate tile "Local WebSocket server" beside "React WS tester"; connect bidirectionally with label "WebSocket". Both share route code detailed in bottom inset 05.
At the lower edge of local panel put concise badge "Current local-only examples: LangGraph · echo-agent / echo tool".
Do NOT call local Docker containers 'ECS' servers; ECS is the cloud implementation. Local run-to-completion tasks launch dynamically via runner; long-lived services run under Compose. Vite React runs separately from Compose.

Panel 03 middle-right "AWS PRODUCTION CAPABILITIES"
At top show a small "Browser" → "CloudFront + S3" arrow labeled "same-origin /api"; small annotation "Configured frontend domain".
Below use clear separate rows:
Row A "CloudFront" → "HTTP API Gateway" → "Lambda / GraphQL" → "RDS PostgreSQL". Only short adjacent solid blue arrows.
Row B starts from HTTP API Gateway, label "Service route", → "VPC link" → "Internal ALB" → "ECS Fargate services". Subtitle under last "Long-running servers".
Row C "Declared caller" → "Step Functions" → fork to "Event Lambda" and "ECS Fargate tasks". Subtitle under tasks "Run to completion". A second distinct small arrow "Declared caller" → "ECS Fargate tasks" labeled "runTask"; workflow arrow labeled "startWorkflow". Since callers can start either tasks or workflows, never draw tasks as permanent services.
Include small "WebSocket API Gateway" badge "Optional deployment". Its connection is directly browser/WebSocket rather than through CloudFront HTTP routing.
At the top/right of cloud panel a small "Cognito" shield, connect identity using restrained thin gray lines to HTTP and WebSocket authorizers, and if not possible use caption instead of crossing arrows. Small caption "Verified identity; ownership enforced by application code".
At bottom show one neat resource rail "IAM grants · Secrets Manager · Declared AWS resources" smaller "S3 · SQS · SNS · EventBridge · DynamoDB".
Use an explicit small label "Only cloud-enabled workloads deploy" so LangGraph and echo-agent samples are not wrongly portrayed deployed. All production blocks describe framework capability, not existing deployment claims.

Panel 04 lower-left "HYBRID DEVELOPMENT & EVENT REPLAY"
Simple readable left-to-right flow:
"AWS event / Cognito trigger" → "Event Lambda capture" → "S3 captured events" → "SQS notification" → "Local dispatcher" → "Same event handler".
Put "withLocalReplay" beside capture, exact text.
Caption: "Replay-enabled events execute locally; replay infrastructure is development-only."
Below one quiet short sentence: "Cognito and declared AWS resources remain in AWS."
Extra very small compact capability callout: "Local workflow integrations: DynamoDB / SQS / SNS / EventBridge stay in AWS; explicit AWS calls and HTTPS connections use Express bridges."
Do not reuse obsolete "USE_LOCAL_IMPLEMENTATION?" from reference. No polling flow that conflates SQS notification with event storage.

Panel 05 lower-center "WEBSOCKET ROUTE PARITY"
This compact inset comes directly from second reference, updated:
"React WS tester" ↔ two parallel alternatives stacked:
"Local WS server"
"WebSocket API Gateway".
Both alternatives connect to one shared handler bundle labeled "Same authorizer + handler source".
Clearly readable route chips: "$connect", "customAction", "$default", "$disconnect".
Put "Cognito authorizer at $connect" next to the bundle.
Return/push line from handler bundle to both transport alternatives labeled "webSocketConnections(event).send".
Short caption: "Connection context travels to every route; transport selected by runtime."
This conveys code reuse, not deploying local servers to AWS. Direct WebSocket protocol, no same-origin /api label on WS.

Panel 06 lower-right "AGENTCORE & TOOL BOUNDARY"
Two simple stacked paths, clean alignment:
Cloud path: "CloudFront" → "AgentCore Runtime" → "Per-agent Gateway" → "Lambda tools".
Label first arrow "/api/agents/* · SSE".
Local path: "Local API server" → "Session process" → "Emulated Gateway" → "Tool handler".
Caption: "Agents call only declared tools. Tools validate identity and access data."
Small capability label: "Cloud-enabled agents only; echo example is local-only".
Absolutely NO agent connection via HTTP API Gateway, NO intermediary streaming Lambda, and NO direct agent-to-database arrow. The CloudFront → AgentCore path is direct. Service agents may use IAM; for concise figure keep authenticated browser lane.

Bottom ribbon "TYPED DATA FEATURE PIPELINE"
Exact development-time arrow order:
"Prisma contract" → "Repository" → "Pothos schema" → "GraphQL documents + Codegen" → "TanStack Query options" → "React".
Small subcaption: "Public fields, validation and ownership are explicit application source."
This is source/type propagation, not the runtime request direction. Yoga executes Pothos schema in Lambda, Prisma database adapter is Rust-free, but do not overcrowd this ribbon with extra optional details.

Footer compact legend with distinct line styles:
"Dashed violet: generated wiring"
"Solid blue: runtime calls"
"Gray: identity / resource context"
Final concise footnote: "Local execution shares contracts and handlers; it does not reproduce AWS durability or IAM isolation."

Accuracy constraints: Separate service lifecycle from task lifecycle. Step Functions compiles declared graph; local interpreter walks same graph but history is not durable. Task and workflow APIs acknowledge submission, do not promise completed results. Declared bindings derive invocation permissions and transport; not credential heuristics. Resource catalog derives native grants and secret delivery; no handwritten secret ARN tables. Data-schema evolution is source generation; migration application is separate and must not appear automatic. No invented Kubernetes, Redis, AppSync, vector database, metrics, or external services. Respect current local-only examples. Maintain all exact critical labels and only necessary connections. If space is tight, reduce decorative icons, never reduce critical label readability. Diagram must explain the real framework better than the references while preserving their factual relationships.
