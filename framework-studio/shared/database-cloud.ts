import type { DatabaseCloudReview, DatabaseCloudIdentity } from "../../packages/database/scripts/studio-migrations-types";
export type { DatabaseCloudReview };
export interface DatabaseCloudDestination { readonly id: string; readonly expiresAt: string; readonly identity: DatabaseCloudIdentity; readonly profile: string; readonly protocol: 1; readonly effects: readonly string[]; readonly binding: string; readonly launch: { readonly cluster: string; readonly containerName: string; readonly launchType: string; readonly platformVersion: string; readonly subnets: readonly string[]; readonly securityGroups: readonly string[]; readonly assignPublicIp: boolean }; readonly logs: { readonly group: string; readonly streamPrefix: string } }
export interface DatabaseCloudApproval {
  readonly id: string;
  readonly profile: string;
  readonly review: DatabaseCloudReview;
  readonly expiresAt: string;
  readonly confirmation: string;
  readonly destination: DatabaseCloudDestination;
}
