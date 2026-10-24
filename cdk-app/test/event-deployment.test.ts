import assert from "node:assert/strict";
import test from "node:test";
import { App, Stack } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import type * as sqs from "aws-cdk-lib/aws-sqs";
import { Template } from "aws-cdk-lib/assertions";
import { defineFrameworkConfig, defineResources, deployInputsFrom, resource, trigger } from "@repo/framework/config";
import { defaults } from "../../framework-config/defaults";
import { buildEventLambdas, eventFunction } from "../lib/framework/framework-events";
import { FrameworkTargetRegistry } from "../lib/framework/framework-target-registry";
import { attachFrameworkTriggers } from "../lib/framework/framework-triggers";

test("disabled events omit native hooks, descriptors and functions in both AWS modes", () => {
  const resources = defineResources({ flag: resource.fromEnv("EVENT_FLAG").enum("on", "off"), deadLetters: resource.cdk<sqs.IQueue>() });
  for (const mode of ["dev", "prod"] as const) for (const deploy of ["none", "local-only", { when: { resource: resources.flag, equals: "on" } }] as const) {
    const config = defineFrameworkConfig({ defaults, resources, http: [], webSocket: [], services: [], events: [{ disabled: { deploy, onFailure: { destination: resources.deadLetters }, triggers: [trigger.schedule({ id: "clock", expression: "rate(1 hour)", accepts: "schedule" })] } }] });
    const app = new App(), stack = new Stack(app, "Events");
    buildEventLambdas(stack, { config, targets: new FrameworkTargetRegistry(), cloud: { mode, inputs: deployInputsFrom({ env: { EVENT_FLAG: "off" } }) } }, ["disabled"]);
    assert.equal(eventFunction(stack, "disabled", { optional: true }), undefined);
    assert.throws(() => eventFunction(stack, "disabled"), /disabled/);
    assert.throws(() => eventFunction(stack, "typo", { optional: true }), /not built/);
    new cognito.UserPool(stack, "Pool", { lambdaTriggers: { preSignUp: eventFunction(stack, "disabled", { optional: true }) } });
    attachFrameworkTriggers(stack, config);
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::Lambda::Function", 0);
    template.resourceCountIs("AWS::Scheduler::Schedule", 0);
    template.resourceCountIs("AWS::Lambda::EventInvokeConfig", 0);
    assert.deepEqual(Object.values(template.findResources("AWS::Cognito::UserPool"))[0]!.Properties.LambdaConfig ?? {}, {});
  }
});
