import type { Route } from "@playwright/test";
import type { DiscoveredDeploymentView, StatusView } from "../../../shared/deploy";
import type { StackInspectionSections } from "../../../shared/stack-inspection";
import { discoveryFor, NOW } from "./scenarios";

export const STACK_ACCOUNT = "123456789012";
export const STACK_NAME = "browser-dev-CognitoStack";
export const STACK_ID = `arn:aws:cloudformation:us-east-1:${STACK_ACCOUNT}:stack/${STACK_NAME}/fixture-stack-id`;
export const CHANGE_SET_ID = `arn:aws:cloudformation:us-east-1:${STACK_ACCOUNT}:changeSet/fixture-security-update/fixture-change-set-id`;
export type InspectionFixtures = { -readonly [S in keyof StackInspectionSections]: StackInspectionSections[S] };
interface FixtureStudio {
  reply(method: string, pathname: string, handler: (route: Route, url: URL) => Promise<void>): void;
}

export function inspectedDeployment(mode: "dev" | "prod" = "dev", account = STACK_ACCOUNT): DiscoveredDeploymentView {
  const name = `browser-${mode}`;
  const stacks = ["DevLambdaReplayStack", "AsynchronousLambdaFunctionsStack", "CognitoStack", "WebSocketLambdaFunctionsStack", "WebSocketApisStack"]
    .map(suffix => ({ name: `${name}-${suffix}`, status: "UPDATE_COMPLETE", health: "complete" as const,
      evidence: "tags" as const, identity: { deployment: name, mode, contract: 2 as const } }));
  return { name, mode, account, region: "us-east-1", contracts: [2], state: { kind: "ready", stacks }, stacks, lastUpdated: NOW };
}

export function inspectionStatus(url: URL, account = STACK_ACCOUNT): StatusView {
  const original = discoveryFor(url);
  const mode = url.searchParams.get("deployment") === "browser-prod" ? "prod" : "dev";
  const detail = inspectedDeployment(mode, account);
  return { ...original, deployment: detail.name,
    context: { ...original.context, account, arn: `arn:aws:iam::${account}:role/browser-fixture` },
    targets: original.targets.map(target => ({ ...target, status: target.name === detail.name ? "deployed" as const : "absent" as const })),
    deployments: [detail], detail: { ...detail, events: [], changeSets: [] } };
}

export function inspectionFixtures(): InspectionFixtures {
  const base = { stackId: STACK_ID, observedAt: NOW };
  const summary = { id: CHANGE_SET_ID, name: "fixture-security-update", status: "CREATE_COMPLETE", executionStatus: "AVAILABLE",
    createdAt: NOW, description: "Reviewed fixture pool update", type: "UPDATE", includeNestedStacks: true };
  return {
    overview: { ...base, name: STACK_NAME, status: "UPDATE_COMPLETE", statusReason: "Fixture deployment finished",
      description: "Authentication resources managed by the fixture framework", createdAt: "2026-10-27T09:00:00.000Z", updatedAt: NOW,
      roleArn: `arn:aws:iam::${STACK_ACCOUNT}:role/fixture-cloudformation`, parentId: "fixture-parent-stack", rootId: "fixture-root-stack",
      terminationProtection: true, disableRollback: false, timeoutMinutes: 60, capabilities: ["CAPABILITY_NAMED_IAM"],
      notificationArns: [`arn:aws:sns:us-east-1:${STACK_ACCOUNT}:fixture-stack-notifications`],
      rollback: { monitoringMinutes: 5, triggers: [{ arn: `arn:aws:cloudwatch:us-east-1:${STACK_ACCOUNT}:alarm:fixture-rollback`, type: "AWS::CloudWatch::Alarm" }] },
      drift: { status: "IN_SYNC", lastCheckedAt: NOW },
      policy: { ok: true, value: { body: JSON.stringify({ Statement: [{ Effect: "Allow", Action: "Update:*", Principal: "*", Resource: "*" }] }, null, 2) } } },
    resources: { ...base, items: [{ logicalId: "FixtureUserPool", physicalId: "us-east-1_fixturePool", type: "AWS::Cognito::UserPool",
      status: "UPDATE_COMPLETE", statusReason: "Fixture pool is ready", updatedAt: NOW,
      drift: { status: "IN_SYNC", lastCheckedAt: NOW }, module: { logicalIdHierarchy: "Authentication/FixtureUserPool", typeHierarchy: "Fixture::Authentication::MODULE" } }], nextCursor: "fixture-resource-page-2" },
    events: { ...base, items: [{ id: "fixture-event-1", time: NOW, logicalId: "FixtureUserPool", physicalId: "us-east-1_fixturePool",
      type: "AWS::Cognito::UserPool", status: "UPDATE_COMPLETE", reason: "Fixture resource update completed", clientRequestToken: "fixture-client-request", detailedStatus: "CONFIGURATION_COMPLETE" }], nextCursor: "fixture-event-page-2" },
    outputs: { ...base, items: [{ key: "UserPoolId", value: "us-east-1_fixturePool", description: "Pool used by the fixture application", exportName: "browser-dev:UserPoolId" }] },
    parameters: { ...base, items: [{ key: "DeploymentStage", value: "dev", type: "String", description: "Selected framework mode", masked: false },
      { key: "AdminPassword", value: "****", type: "String", description: "A NoEcho CloudFormation parameter", masked: true, usePreviousValue: true }] },
    template: { ...base, stage: "Original", availableStages: ["Original", "Processed"], format: "json",
      body: JSON.stringify({ Description: "Fixture original deployed template", Parameters: { AdminPassword: { Type: "String", NoEcho: true, Default: "****" } },
        Resources: { FixtureUserPool: { Type: "AWS::Cognito::UserPool" } } }, null, 2), redactedDefaults: ["AdminPassword"] },
    tags: { ...base, items: [{ key: "framework:deployment", value: "browser-dev" }, { key: "framework:mode", value: "dev" }, { key: "Owner", value: "Fixture team" }] },
    "change-sets": { ...base, items: [summary] },
    "change-set": { ...base, summary, items: [{ Type: "Resource", ResourceChange: { Action: "Modify", LogicalResourceId: "FixtureUserPool", ResourceType: "AWS::Cognito::UserPool", Replacement: "False",
      Details: [{ Target: { Attribute: "Properties", Name: "UserPoolName", RequiresRecreation: "Never" }, Evaluation: "Static", ChangeSource: "DirectModification" }] } }],
      parameters: [{ key: "AdminPassword", value: "****", masked: true }], capabilities: ["CAPABILITY_NAMED_IAM"], notificationArns: [], tags: [{ key: "Owner", value: "Fixture team" }], rollback: { triggers: [] } },
    dependencies: { ...base, exports: [{ name: "browser-dev:UserPoolId", value: "us-east-1_fixturePool" }],
      imports: ["browser-dev:ReplayQueueArn"], importsNote: "Imports are inferred from the deployed template." },
    "export-imports": { ...base, items: ["browser-dev-WebSocketApisStack"] },
  };
}

export async function replyInspection(route: Route, url: URL, fixtures: InspectionFixtures) {
  const section = url.searchParams.get("section") as keyof StackInspectionSections;
  let value = fixtures[section];
  if (section === "resources" && url.searchParams.get("cursor") === "fixture-resource-page-2") value = {
    ...fixtures.resources, nextCursor: undefined, items: [{ logicalId: "FixturePoolPolicy", physicalId: "fixture-pool-policy", type: "AWS::IAM::Policy", status: "CREATE_COMPLETE", updatedAt: NOW }],
  };
  if (section === "events" && url.searchParams.get("cursor") === "fixture-event-page-2") value = {
    ...fixtures.events, nextCursor: undefined, items: [{ id: "fixture-event-2", time: "2026-10-27T09:00:00.000Z", logicalId: "FixturePoolPolicy", type: "AWS::IAM::Policy", status: "CREATE_COMPLETE", reason: "Earlier fixture policy event" }],
  };
  if (section === "template" && url.searchParams.get("stage") === "Processed") value = {
    ...fixtures.template, stage: "Processed", body: JSON.stringify({ Description: "Fixture processed deployed template", Resources: { FixtureUserPool: { Type: "AWS::Cognito::UserPool" } } }, null, 2),
  };
  await route.fulfill({ json: { ok: true, value } });
}

export function installInspectionFixtures(studio: FixtureStudio, fixtures = inspectionFixtures()) {
  studio.reply("GET", "/api/deploy/status", (route, url) => route.fulfill({ json: { ok: true, value: inspectionStatus(url) } }));
  studio.reply("GET", "/api/deploy/stack", (route, url) => replyInspection(route, url, fixtures));
  return fixtures;
}
