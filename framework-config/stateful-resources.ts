import type { StatefulResourcesConfiguration } from "../cdk-app/stateful-resources";

/** Missing policies inherit RETAIN_STATEFUL_RESOURCES from each target's inputs.
 * Choose retention independently, or explicitly reference a compatible retained resource.
 * Source review does not deploy these changes or transfer CloudFormation ownership.
 */
export const statefulResources = {
  dev: {},
  prod: {},
} satisfies StatefulResourcesConfiguration;
