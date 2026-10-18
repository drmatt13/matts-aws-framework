import type { ModelResource, ModelRoute, ModelTarget } from "../shared/model";

/** Shared by the DOM views and the canvas. Paths are local, versioned SVG assets. */
export const ICONS = {
  lambda: ["aws/lambda", "AWS Lambda"],
  gateway: ["aws/api-gateway", "Amazon API Gateway"],
  webSocket: ["generic/cable", "WebSocket"],
  event: ["generic/zap", "Event invocation"],
  internetGateway: ["aws/internet-gateway", "VPC internet gateway"],
  natGateway: ["aws/nat-gateway", "VPC NAT gateway"],
  endpoint: ["aws/vpc-endpoint", "VPC endpoint"],
  service: ["aws/ecs", "Amazon ECS"],
  task: ["aws/fargate", "AWS Fargate"],
  workflow: ["aws/step-functions", "AWS Step Functions"],
  agent: ["aws/agentcore", "Amazon Bedrock AgentCore"],
  stack: ["aws/cloudformation", "AWS CloudFormation stack"],
  unattached: ["generic/unplug", "Not added to CDK app"],
  managed: ["generic/lock-keyhole", "Framework managed"],
  table: ["aws/dynamodb", "Amazon DynamoDB"],
  bucket: ["aws/s3", "Amazon S3"],
  queue: ["aws/sqs", "Amazon SQS"],
  topic: ["aws/sns", "Amazon SNS"],
  bus: ["aws/eventbridge", "Amazon EventBridge"],
  userpool: ["aws/cognito", "Amazon Cognito"],
  database: ["aws/rds", "Amazon RDS"],
  postgres: ["generic/database", "Local PostgreSQL"],
  secret: ["aws/secrets-manager", "AWS Secrets Manager"],
  group: ["generic/folder-tree", "Resource group"],
  input: ["generic/sliders-horizontal", "Configuration input"],
  envFile: ["generic/file-code", "Deployment environment file"],
  value: ["generic/braces", "Stack value"],
  construct: ["generic/box", "CDK construct"],
  route: ["generic/route", "Framework route"],
} as const;

export type IconKey = keyof typeof ICONS;
export const iconUrl = (key: IconKey): string => `/icons/${ICONS[key][0]}.svg`;

/** Service badge on a VPC endpoint; reuse the same local service artwork as nodes. */
export function endpointServiceIcon(service: string): IconKey {
  const icons: Readonly<Record<string, IconKey>> = {
    s3: "bucket", dynamodb: "table", lambda: "lambda", ecs: "service",
    "ecs-agent": "service", "ecs-telemetry": "service",
    sqs: "queue", sns: "topic", events: "bus", states: "workflow",
    secretsmanager: "secret", rds: "database", "rds-data": "database",
    "cognito-idp": "userpool", "bedrock-agentcore": "agent",
  };
  return icons[service] ?? icons[service.split(".")[0]!] ?? "construct";
}

export function targetIcon(target: ModelTarget): IconKey {
  return target.kind;
}

export function routeIcon(_route: ModelRoute): IconKey {
  return "gateway";
}

export function resourceIcon(resource: ModelResource): IconKey {
  if (resource.kind !== "member") return resource.kind;
  const type = resource.typeText ?? "";
  if (/UserPool/.test(type)) return "userpool";
  if (/Table/.test(type)) return "table";
  if (/Bucket/.test(type)) return "bucket";
  if (/Queue/.test(type)) return "queue";
  if (/Topic/.test(type)) return "topic";
  if (/EventBus/.test(type)) return "bus";
  if (/Database|Cluster/.test(type)) return "database";
  if (/Secret/.test(type)) return "secret";
  if (type === "string") return "value";
  return "construct";
}

export function resourceBadge(resource: ModelResource): IconKey | undefined {
  if (resource.stackUsage?.status === "unreferenced") return "unattached";
  if (resource.frameworkManaged) return "managed";
  return undefined;
}
