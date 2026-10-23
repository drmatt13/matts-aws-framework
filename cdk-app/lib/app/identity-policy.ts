/** Literal reader-role policy data shared by native CDK and Studio. No credentials or executable expressions. */
export interface IdentityPolicyStatement { readonly Effect: "Allow" | "Deny"; readonly Action: readonly string[]; readonly Resource: readonly string[] }
const ALLOW: Readonly<Record<string, readonly string[]>> = {
  s3: ["GetObject", "PutObject", "DeleteObject", "ListBucket"],
  dynamodb: ["GetItem", "PutItem", "UpdateItem", "DeleteItem", "Query", "Scan", "BatchGetItem", "BatchWriteItem"],
  sqs: ["SendMessage", "ReceiveMessage", "DeleteMessage", "GetQueueAttributes", "ChangeMessageVisibility"],
  sns: ["Publish"], lambda: ["InvokeFunction"], states: ["StartExecution"], events: ["PutEvents"],
};
const RESOURCE: Readonly<Record<string, RegExp>> = {
  dynamodb: /^table\/[A-Za-z0-9_.-]+(?:\/index\/[A-Za-z0-9_.-]+)?(?:\/\*)?$/,
  sqs: /^[A-Za-z0-9_-]+(?:\.fifo)?$/, sns: /^[A-Za-z0-9_-]+(?:\.fifo)?$/,
  lambda: /^function:[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)?$/, states: /^stateMachine:[A-Za-z0-9_-]+$/,
  events: /^event-bus\/[A-Za-z0-9_.-]+$/,
};
export function identityPolicyStatements(value: unknown): readonly IdentityPolicyStatement[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error("Use at most 20 explicit reader-role policy statements.");
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !["Effect", "Action", "Resource"].includes(key)) || !["Allow", "Deny"].includes(raw.Effect) || !Array.isArray(raw.Action) || !raw.Action.length || raw.Action.length > 30 || !Array.isArray(raw.Resource) || !raw.Resource.length || raw.Resource.length > 30) throw new Error("Each statement needs Effect Allow or Deny, explicit Action and Resource arrays. Conditions, principals, NotAction and NotResource require native source review.");
    for (const action of raw.Action) {
      if (typeof action !== "string" || !/^[a-z0-9-]+:[A-Za-z][A-Za-z0-9]{1,100}$/.test(action)) throw new Error("Name concrete IAM actions without wildcards, for example s3:GetObject.");
      const [service, operation] = action.split(":");
      if (raw.Effect === "Allow" && !ALLOW[service!]?.includes(operation!)) throw new Error("Allow policies support explicit data operations on S3, DynamoDB, SQS, SNS, Lambda, Step Functions and EventBridge. Administrative, secret, credential and wildcard grants require native source review.");
    }
    for (const resource of raw.Resource) {
      if (typeof resource !== "string" || resource.length > 1024 || /[\s\x00-\x1f?${}]/.test(resource) || !/^arn:(?:aws|aws-us-gov|aws-cn):[a-z0-9-]+:[a-z0-9-]*:[0-9]*:.+$/.test(resource) || (resource.includes("*") && (!resource.endsWith("/*") || resource.slice(0, -1).includes("*")))) throw new Error("Use concrete resource ARNs; only a final /* beneath an explicit resource/prefix is supported. Global resources and wildcard accounts/regions are refused.");
      const [, , service, region, account, ...rest] = resource.split(":"); const identifier = rest.join(":");
      if (service === "s3") {
        if (region || account || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9](?:\/[^*]*)?(?:\*)?$/.test(identifier)) throw new Error("S3 policy resources require one explicit bucket name and optional object prefix.");
      } else if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region!) || !/^\d{12}$/.test(account!)) throw new Error("Non-S3 resources must pin an AWS account and region.");
      if (raw.Effect === "Allow" && raw.Action.some((action: string) => action.split(":")[0] !== service)) throw new Error("Each Allow statement must use resource ARNs for its action's AWS service.");
      if (raw.Effect === "Allow" && service !== "s3" && !RESOURCE[service!]?.test(identifier)) throw new Error("Allow resources must identify a concrete table, queue, topic, function, state machine or event bus; resource-class wildcards are refused.");
      if (raw.Effect === "Allow" && service === "s3" && raw.Action.some((action: string) => action === "s3:ListBucket" ? identifier.includes("/") : !identifier.includes("/"))) throw new Error("ListBucket needs the bucket ARN; object actions need a bucket/object ARN. Put them in separate statements.");
    }
  }
  if (JSON.stringify(value).length > 6000) throw new Error("Keep the reader policy below 6,000 characters; split larger policies deliberately in native CDK.");
  return value as readonly IdentityPolicyStatement[];
}
