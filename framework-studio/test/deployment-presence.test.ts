import assert from "./support/assert";
import { test } from "node:test";
import { deploymentPresence } from "../src/deploy/presence";
import type { DeploymentScope } from "../src/deploy/context";
import type { StackView, StatusView } from "../shared/deploy";
import { discovery } from "./browser/support/scenarios";

const scope: DeploymentScope = { repository: "/fixture", sourceRevision: "one", generation: "0:0", profile: "dev", mode: "dev", deployment: "browser-dev" };
const target = { name: "browser-dev", mode: "dev" as const };
const stack: StackView = { name: "browser-dev-CognitoStack", status: "CREATE_COMPLETE", health: "complete", evidence: "tags", identity: { deployment: "browser-dev", mode: "dev", contract: 2 } };
const status: StatusView = { ...discovery(), context: { ...discovery().context, profile: "dev" }, deployment: "browser-dev",
  detail: { name: "browser-dev", mode: "dev", account: "123456789012", region: "us-east-1", contracts: [2], state: { kind: "ready", stacks: [stack] }, stacks: [stack], events: [], changeSets: [] } };
const input = { scope, target, status, availability: "available", retained: false, fetching: false };

test("only observed complete owned stacks make a mode deployment green", () => {
  assert.equal(deploymentPresence(input).state, "deployed");
  for (const detail of [
    { ...status.detail!, stacks: [] },
    { ...status.detail!, mode: "prod" as const },
    { ...status.detail!, stacks: [{ ...stack, evidence: "none" as const }] },
    { ...status.detail!, stacks: [{ ...stack, identity: { ...stack.identity!, mode: "prod" as const } }] },
    { ...status.detail!, state: { kind: "rolled-back" as const, stacks: [stack] } },
  ]) assert.notEqual(deploymentPresence({ ...input, status: { ...status, detail } }).state, "deployed");
  assert.equal(deploymentPresence({ ...input, target: { ...target, account: "999999999999" } }).state, "attention");
  assert.equal(deploymentPresence({ ...input, scope: { ...scope, profile: "other" } }).state, "attention");
});

test("mode indicators distinguish absence, pending, missing connection and stale evidence", () => {
  assert.equal(deploymentPresence({ ...input, status: { ...status, detail: undefined } }).state, "absent");
  assert.equal(deploymentPresence({ ...input, status: undefined }).state, "pending");
  assert.equal(deploymentPresence({ ...input, scope: { ...scope, profile: undefined } }).state, "unknown");
  assert.equal(deploymentPresence({ ...input, problem: { kind: "expired", message: "Sign in again." } }).state, "attention");
  const retained = deploymentPresence({ ...input, retained: true, fetching: true });
  assert.equal(retained.state, "deployed");
  assert.match(retained.description, /Last observed.*is deployed.*Refreshing/);
  assert.equal(deploymentPresence({ ...input, scope: { ...scope, mode: "prod" }, target: { ...target, mode: "prod" } }).state, "attention");
});
