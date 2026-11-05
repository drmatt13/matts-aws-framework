import type { AwsProblem, DeployMode } from "./deploy";

/** Read-only CloudFormation details, always bound to a verified deployment and stack ARN. */
export interface StackInspectionRequest {
  readonly profile: string;
  readonly deployment: string;
  readonly mode: DeployMode;
  readonly account: string;
  readonly region: string;
  readonly stack: string;
  /** Omitted only for the initial overview that resolves this immutable identity. */
  readonly stackId?: string;
  readonly section: StackInspectionSection;
  readonly cursor?: string;
  readonly changeSetId?: string;
  readonly exportName?: string;
  readonly stage?: "Original" | "Processed";
}
export type StackInspectionSection = keyof StackInspectionSections;
export type InspectionResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: AwsProblem };
export interface StackInspectionBase { readonly stackId: string; readonly observedAt: string }
export interface StackInspectionPage<T> extends StackInspectionBase { readonly items: readonly T[]; readonly nextCursor?: string }
export interface StackDriftInfo { readonly status: string; readonly lastCheckedAt?: string }
export interface StackOverview extends StackInspectionBase {
  readonly name: string;
  readonly status: string;
  readonly statusReason?: string;
  readonly detailedStatus?: string;
  readonly retainExceptOnCreate?: boolean;
  readonly deletionMode?: string;
  readonly description?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly deletedAt?: string;
  readonly parentId?: string;
  readonly rootId?: string;
  readonly roleArn?: string;
  readonly terminationProtection: boolean;
  readonly disableRollback: boolean;
  readonly timeoutMinutes?: number;
  readonly capabilities: readonly string[];
  readonly notificationArns: readonly string[];
  readonly rollback: { readonly monitoringMinutes?: number; readonly triggers: readonly { readonly arn: string; readonly type: string }[] };
  readonly drift: StackDriftInfo;
  readonly policy: InspectionResult<{ readonly body?: string }>;
}
export interface StackResource {
  readonly logicalId: string;
  readonly physicalId?: string;
  readonly type: string;
  readonly status: string;
  readonly statusReason?: string;
  readonly updatedAt?: string;
  readonly drift?: StackDriftInfo;
  readonly module?: { readonly logicalIdHierarchy?: string; readonly typeHierarchy?: string };
}
export interface InspectedStackEvent {
  readonly id: string;
  readonly time: string;
  readonly logicalId: string;
  readonly physicalId?: string;
  readonly type: string;
  readonly status: string;
  readonly reason?: string;
  readonly clientRequestToken?: string;
  readonly detailedStatus?: string;
}
export interface StackOutput { readonly key: string; readonly value: string; readonly description?: string; readonly exportName?: string }
export interface StackParameter {
  readonly key: string;
  readonly value: string;
  readonly resolvedValue?: string;
  readonly type?: string;
  readonly description?: string;
  readonly masked: boolean;
  readonly usePreviousValue?: boolean;
}
export interface StackParameters extends StackInspectionPage<StackParameter> { readonly maskingProblem?: AwsProblem }
export interface StackTemplate extends StackInspectionBase {
  readonly stage: "Original" | "Processed";
  readonly availableStages: readonly string[];
  readonly body: string;
  readonly format: "json" | "yaml";
  readonly redactedDefaults: readonly string[];
}
export interface StackTag { readonly key: string; readonly value: string }
export interface StackChangeSetSummary {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly executionStatus?: string;
  readonly statusReason?: string;
  readonly description?: string;
  readonly createdAt?: string;
  readonly type?: string;
  readonly includeNestedStacks?: boolean;
  readonly parentId?: string;
  readonly rootId?: string;
}
/** AWS's property-level changes are retained without credential resolution. */
export type InspectionJson = null | boolean | number | string | readonly InspectionJson[] | { readonly [key: string]: InspectionJson };
export interface StackChangeSet extends StackInspectionPage<InspectionJson> {
  readonly summary: StackChangeSetSummary;
  readonly parameters: readonly StackParameter[];
  readonly maskingProblem?: AwsProblem;
  readonly capabilities: readonly string[];
  readonly notificationArns: readonly string[];
  readonly tags: readonly StackTag[];
  readonly rollback: StackOverview["rollback"];
  readonly onStackFailure?: string;
  readonly importExistingResources?: boolean;
}
export interface StackDependencies extends StackInspectionBase {
  readonly exports: readonly { readonly name: string; readonly value: string }[];
  readonly imports: readonly string[];
  readonly importsNote?: string;
}
export interface StackInspectionSections {
  readonly overview: StackOverview;
  readonly resources: StackInspectionPage<StackResource>;
  readonly events: StackInspectionPage<InspectedStackEvent>;
  readonly outputs: StackInspectionPage<StackOutput>;
  readonly parameters: StackParameters;
  readonly template: StackTemplate;
  readonly tags: StackInspectionPage<StackTag>;
  readonly "change-sets": StackInspectionPage<StackChangeSetSummary>;
  readonly "change-set": StackChangeSet;
  readonly dependencies: StackDependencies;
  readonly "export-imports": StackInspectionPage<string>;
}
