import * as cdk from "aws-cdk-lib";
import { INFRASTRUCTURE_OWNER, type InfrastructureOwner } from "../../../scripts/infrastructure-types";

/** Assembly metadata only: no tags, CloudFormation properties, scopes or logical IDs change. */
export function markInfrastructure(value: unknown, entity: string, role: InfrastructureOwner["role"] = "primary"): void {
  const construct = value as cdk.Resource | undefined;
  if (!construct?.node || typeof construct.node.addMetadata !== "function") return;
  const external = cdk.Resource.isResource(construct) && !cdk.Resource.isOwnedResource(construct) && !construct.node.findAll().some(cdk.CfnResource.isCfnResource);
  const data: InfrastructureOwner = { entity, role, ...(external ? { external: true } : {}), ...(cdk.Stack.isStack(construct) ? { stack: true } : {}) };
  if (!construct.node.metadata.some((entry) => entry.type === INFRASTRUCTURE_OWNER && JSON.stringify(entry.data) === JSON.stringify(data))) construct.node.addMetadata(INFRASTRUCTURE_OWNER, data);
}
