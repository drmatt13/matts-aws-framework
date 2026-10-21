/**
 * Descriptions shown in Framework Studio's node and island inspectors.
 * Keys are canonical map entity IDs, shared by Development and Production.
 * Edit here or select an item in /isometric and review/apply its Description.
 * Documentation only: this file does not configure or deploy infrastructure.
 */
export const descriptions = {
  // HTTP handlers
  "lambda:sign-in": "Signs users in with Cognito and establishes their browser session. Handles password authentication and sign-in challenges.",
  "lambda:sign-out": "Ends the browser session, clears session cookies and revokes the refresh token with Cognito.",
  "lambda:oauth-callback": "Exchanges the hosted sign-in authorization code for Cognito tokens and establishes the browser session.",
  "lambda:verify-session": "Checks the current Cognito ID token and returns a success response when the session is valid.",
  "lambda:refresh": "Uses the browser's refresh cookie to obtain a fresh Cognito ID token while retaining the selected session mode.",
  "lambda:mfa": "Manages authenticator-based two-step verification for the signed-in user, including setup and verification.",
  "lambda:graphql-api": "Serves the application's GraphQL schema. Resolvers use the authenticated session and database repositories to enforce access to application data.",
  "lambda:python-example": "Demonstrates a Python HTTP Lambda handler and its declared route. Python ZIP handlers require AWS execution.",
  "lambda:test-start-workflow": "Authenticated example endpoint that starts the declared invocation test workflow and returns its execution identifier.",
  "lambda:test-run-task": "Authenticated example endpoint that submits the invocation test container task and returns its run identifier.",

  // WebSocket and event handlers
  "lambda:ws-connect-route": "Accepts an authorized WebSocket connection and logs its connection identifier and authorizer principal.",
  "lambda:ws-authorizer": "Authorizes the WebSocket connection request before the $connect handler runs.",
  "lambda:ws-default-route": "Handles WebSocket messages whose action does not match a declared route key.",
  "lambda:ws-disconnect-route": "Handles a WebSocket disconnect and logs the connection identifier. This example provides a place to add application cleanup.",
  "lambda:ws-custom-action-route": "Demonstrates a custom WebSocket action by parsing its message and returning a JSON response containing the message and connection identifier.",
  "lambda:cognito-pre-signup-trigger": "Processes Cognito pre-sign-up events, including the application's account-linking and development verification rules.",
  "lambda:cognito-custom-message": "Customizes Cognito's verification and account-related messages before delivery.",
  "lambda:cognito-post-confirmation-trigger": "Processes confirmed Cognito accounts and synchronizes application user data through the database. Development uses local event replay.",
  "lambda:invocation-test-step": "Validates the invocation test workflow's input before it runs the example container task.",

  // Agents, tools, containers and orchestration
  "lambda:add-numbers": "AgentCore example tool that adds numbers supplied through its typed tool contract.",
  "lambda:multiply-numbers": "AgentCore example tool that multiplies numbers supplied through its typed tool contract.",
  "agent:example-agent": "Example conversational agent running on AgentCore Runtime in AWS or the local agent lane. Uses the declared model provider and arithmetic tools.",
  "service:example-service": "Example long-running container service reached through the /api/example-service mount. Its declaration controls local and AWS availability.",
  "task:invocation-test-task": "Run-to-completion container used by the task and workflow invocation examples. Its terminal result is tracked by the invocation runner or ECS.",
  "task:db-migrate": "Runs the database migration container against the selected environment using the framework's database access. Executing migrations is a separate authorized action.",
  "workflow:invocation-test-workflow": "Example workflow that validates input with a Lambda, runs the invocation test task to completion and returns the validation result. Runs locally through the workflow interpreter or in AWS Step Functions.",

  // Public entry points (separate identities from their implementations)
  "route:http:/sign-in": "Browser sign-in endpoint at /api/sign-in, routed to the sign-in Lambda.",
  "route:http:/sign-out": "Browser sign-out endpoint at /api/sign-out, routed to the sign-out Lambda.",
  "route:http:/oauth/callback": "Hosted sign-in code exchange endpoint at /api/oauth/callback, routed to the OAuth callback Lambda.",
  "route:http:/verify-session": "Session inspection endpoint at /api/verify-session, routed to the session verification Lambda.",
  "route:http:/refresh": "Session refresh endpoint at /api/refresh, routed to the refresh Lambda.",
  "route:http:/mfa": "Two-step verification management endpoint at /api/mfa, routed to the MFA Lambda.",
  "route:http:/graphql": "Application GraphQL entry point at /api/graphql, routed to the GraphQL API Lambda.",
  "route:http:/examples/python": "Example Python endpoint at /api/examples/python, routed to the Python Lambda.",
  "route:http:/test/start-workflow": "Authenticated example route at /api/test/start-workflow for starting the invocation test workflow.",
  "route:http:/test/run-task": "Authenticated example route at /api/test/run-task for submitting the invocation test task.",
  "route:service:/example-service/*": "Routes /api/example-service and its descendants to the example container service. The proxy strips the mount before forwarding.",
  "route:ws:$connect": "WebSocket connection entry point. Runs the declared authorizer before reaching the connection handler.",
  "route:ws:$default": "Fallback WebSocket route for messages without a matching declared action.",
  "route:ws:$disconnect": "WebSocket lifecycle route invoked when a connection closes.",
  "route:ws:customAction": "WebSocket action route that dispatches customAction messages to the example action handler.",
  "route:agent:/chat/example": "Authenticated browser entry point for the example agent at /chat/example, using the same declared path locally and in AWS.",

  // Catalog stacks and their public fields
  "resource:referenceExamples": "Reference stack demonstrating typed S3, DynamoDB, SNS and SQS resources and their CDK relationships. Studio reports whether the CDK app references its constructor.",
  "resource:referenceExamples.documentsBucket": "Example S3 document bucket with EventBridge notifications connected to the reference notification flow.",
  "resource:referenceExamples.recordsTable": "Example DynamoDB table exposed as a typed resource for application and workflow integrations.",
  "resource:referenceExamples.notificationsTopic": "Example SNS notification topic subscribed to by the reference processing queue.",
  "resource:referenceExamples.processingQueue": "Example SQS processing queue receiving notifications and forwarding exhausted messages to the dead-letter queue.",
  "resource:referenceExamples.deadLetterQueue": "Example SQS dead-letter queue retaining messages that exhaust the processing queue's delivery attempts.",
  "resource:cognito": "Application identity stack containing the Cognito user pool, app client and resolved browser authentication settings.",
  "resource:cognito.userPool": "Cognito user directory used for application authentication and API authorization.",
  "resource:cognito.userPoolClient": "Cognito app client used by the browser session and sign-in handlers.",
  "resource:cognito.trustedOriginsCsv": "Resolved browser origins accepted by cookie-bearing authentication endpoints.",
  "resource:cognito.userPoolDomainUrl": "Resolved Cognito hosted sign-in domain URL supplied to the authentication flow.",
  "resource:cognito.skipEmailVerification": "Resolved development email-verification setting exposed by the Cognito stack. Production validation restricts development-only behavior.",
  "resource:cognito.frontendUrl": "Resolved frontend origin used for authentication redirects and browser configuration.",
  "resource:cognito.oauthProviderRedirectUri": "Cognito identity-provider callback URI used when configuring an external OAuth provider.",
  "resource:rds": "Framework-managed production database stack. Development workloads use local PostgreSQL instead of building this stack.",
  "resource:rds.database": "Production PostgreSQL database on its declared VPC subnet. Workloads opt in with database: true and connect using IAM authentication.",
  "framework-stack:FrontendWebsiteS3Stack": "Hosts the built frontend with S3 and CloudFront and publishes the website outputs used by local export and frontend publishing.",
  "framework-stack:DevLambdaReplayStack": "Development infrastructure that captures opted-in AWS event Lambda invocations for replay against local handlers.",
  "framework-stack:HttpApiGatewayStack": "Framework HTTP API infrastructure derived from declared HTTP routes and service mounts. Publishes the API endpoint for the frontend and local export.",
  "framework-stack:WebSocketApiStack": "Framework WebSocket API infrastructure derived from declared route keys and their connection authorizer. Availability follows the WebSocket deployment flag.",

  // Authored inputs and secrets: descriptions contain no values
  "resource:openaiApiKey": "OpenAI provider credential supplied through the OPENAI_API_KEY secret declaration. Author its value only in the selected CDK inputs file.",
  "resource:googleClientSecret": "Google OAuth client credential supplied through the GOOGLE_CLIENT_SECRET secret declaration. Author its value only in the selected CDK inputs file.",
  "resource:langgraph": "Groups the model provider and model identifier inputs shared by the example agent's model configuration.",
  "resource:langgraph.modelProvider": "Selects the agent model provider: Bedrock Mantle, Bedrock or OpenAI. Provider selection determines which model identifier and credentials are used.",
  "resource:langgraph.bedrockModelId": "Model identifier used when the shared model provider is Bedrock.",
  "resource:langgraph.bedrockMantleModelId": "Model identifier used when the shared model provider is Bedrock Mantle.",
  "resource:langgraph.openaiModelId": "Model identifier used when the shared model provider is OpenAI.",
  "envfile:dev": "Development CDK input file editor. Stages variable changes for review and writes only the selected development file; values stay outside map data.",
  "envfile:prod": "Production CDK input file editor. Stages variable changes for review and writes only the selected production file. Saving does not deploy infrastructure.",
  "client-envfile": "Client-app environment variable mappings. Local endpoints reference the selected CDK inputs, while identity and deployed endpoint settings reference public stack outputs. Inspect each variable's source without loading values.",
  "local:postgres": "Local PostgreSQL service declared in docker-compose.yml. Development workloads share the application schema with production RDS; named Compose storage preserves local data.",

  // Network fixtures
  "prop:vpc:application:internet-gateway": "Connects the VPC's public subnets to the internet for IPv4 and IPv6 traffic. Network settings are declared in framework-config/networks/application/index.ts.",
  "prop:vpc:application:egress-only-gateway": "Allows outbound IPv6 traffic from private subnets while preventing unsolicited inbound connections.",
  "prop:vpc:application:nat-gateway": "Optional outbound IPv4 path for private subnets. Appears when NAT is enabled in the network declaration.",
  "prop:vpc:application:endpoint:s3": "S3 gateway endpoint attached to the VPC route tables so S3 traffic stays on the AWS network.",
  "prop:vpc:application:endpoint:dynamodb": "DynamoDB gateway endpoint attached to the VPC route tables so DynamoDB traffic stays on the AWS network.",

  // Selectable terrain
  "island:apis": "Public HTTP routes, container service mounts, WebSocket route keys and agent browser paths. Each entry has its own identity and declared target.",
  "island:lambda": "Lambda compute outside the VPC, grouped across HTTP, WebSocket, events and agent tools. Shared defaults apply by service type; individual workload overrides take precedence.",
  "island:vpc:application": "Application VPC with public, private and isolated subnet terraces. Production workloads follow their declared placement; gateway and endpoint settings control egress.",
  "island:agentcore": "Conversational agents running on AgentCore Runtime or the local agent lane. Declared tool bindings determine which Lambda tools each agent can call.",
  "island:orchestration": "Declared workflow graphs interpreted locally or compiled to AWS Step Functions. Steps invoke only the targets and integrations declared by the workflow.",
  "island:stacks": "Application catalog stacks and framework output stacks. Inspect a stack to see public fields, source relationships and mapped CloudFormation outputs.",
  "island:inputs": "Input parameters and secrets declared in framework-config/resources.ts, with links to their consumers and supplying environment files.",
  "island:environment": "Development and production CDK input files. Inspect a file to edit variables through draft review; map links show assignment and requirement metadata.",
  "island:client-environment": "Client-app environment file and its variable mappings, linked to development or production CDK inputs and public stack outputs. File generation is a separate step.",
} satisfies Record<string, string>;
