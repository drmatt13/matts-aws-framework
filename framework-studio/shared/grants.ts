/** Native helpers selected from source-discovered CDK types, shared by UI and writer. */
const GRANTS = [
  { type: /^aws-s3:I?Bucket$/, method: "grantRead", label: "Read bucket objects", scope: true },
  { type: /^aws-s3:I?Bucket$/, method: "grantWrite", label: "Write bucket objects", scope: true },
  { type: /^aws-s3:I?Bucket$/, method: "grantReadWrite", label: "Read and write bucket objects", scope: true },
  { type: /^aws-sqs:I?Queue$/, method: "grantSendMessages", label: "Send queue messages", scope: false },
  { type: /^aws-sqs:I?Queue$/, method: "grantConsumeMessages", label: "Consume queue messages", scope: false },
  { type: /^aws-dynamodb:I?Table(?:V2)?$/, method: "grantReadData", label: "Read table data", scope: false },
  { type: /^aws-dynamodb:I?Table(?:V2)?$/, method: "grantWriteData", label: "Write table data", scope: false },
  { type: /^aws-dynamodb:I?Table(?:V2)?$/, method: "grantReadWriteData", label: "Read and write table data", scope: false },
  { type: /^aws-sns:I?Topic$/, method: "grantPublish", label: "Publish topic messages", scope: false },
  { type: /^aws-events:I?EventBus$/, method: "grantPutEventsTo", label: "Publish events", scope: false },
] as const;
export type NativeGrantMethod = typeof GRANTS[number]["method"];
export const grantOptions = (types: readonly string[]) => GRANTS.filter(grant => types.some(type => grant.type.test(type)));
export const nativeGrantLabels: Readonly<Record<NativeGrantMethod, string>> = Object.fromEntries(GRANTS.map(grant => [grant.method, grant.label])) as Record<NativeGrantMethod, string>;
