import assert from "node:assert/strict";
import test from "node:test";
import { defineFrameworkConfig, defineResources, deployInputsFrom, resource, succeed, workflow } from "@repo/framework/config";
import { applicationVpc } from "../../framework-config/networks/application";
import { defaults } from "../../framework-config/defaults";
import { assertFrameworkTargetsComplete, FrameworkTargetRegistry } from "../lib/framework/framework-target-registry";

const resources = defineResources({ enabled: resource.fromEnv("ENABLED") });
const config = () => defineFrameworkConfig({
  defaults, resources, http: [{
    "/second": { directory: "/functions/second", methods: ["GET"], deploy: "none" },
    "/first": { directory: "/functions/first", methods: ["GET"], deploy: "local-only" },
    "/conditional": { directory: "/functions/conditional", methods: ["GET"], deploy: { when: { resource: resources.enabled, equals: "yes" } } },
    "/cloud": { directory: "/functions/cloud", methods: ["GET"] },
  }], webSocket: [], events: [], services: [],
});
const options = { mode: "dev" as const, inputs: deployInputsFrom({ env: { ENABLED: "no" } }) };

test("registration checks preserve declaration order and distinguish disabled, conditional and other-mode targets", () => {
  assert.deepEqual(assertFrameworkTargetsComplete(config(), new FrameworkTargetRegistry(), options), {
    disabled: ["lambda:second", "lambda:first"], conditionNotMet: ["lambda:conditional"], notInThisDeployment: ["lambda:cloud"],
  });
});

test("registration checks rebuild availability and declarations between calls", () => {
  const built = config();
  const registry = new FrameworkTargetRegistry();
  const first = assertFrameworkTargetsComplete(built, registry, options);
  Object.assign(built.http["/cloud"]!, { deploy: "none" });
  const second = assertFrameworkTargetsComplete(built, registry, options);
  assert.deepEqual(second.disabled, ["lambda:second", "lambda:first", "lambda:cloud"]);
  assert.deepEqual(second.notInThisDeployment, []);
  assert.deepEqual(first.notInThisDeployment, ["lambda:cloud"]);
  Object.assign(built.http, { "/added": { directory: "/functions/added", methods: ["GET"], deploy: "none" } });
  assert.deepEqual(assertFrameworkTargetsComplete(built, registry, options).disabled, ["lambda:second", "lambda:first", "lambda:cloud", "lambda:added"]);
  registry.service("extra", "http://fixture");
  assert.throws(() => assertFrameworkTargetsComplete(built, registry, options), {
    message: 'Framework target "service:extra" is registered in CDK but is not declared in framework.config.ts.',
  });
});

test("the first missing registration retains its exact diagnostic", () => {
  assert.throws(() => assertFrameworkTargetsComplete(config(), new FrameworkTargetRegistry(), { ...options, mode: "prod" }), {
    message: 'Framework target "lambda:cloud" is declared in framework.config.ts but no stack registered it.',
  });
});


test("mixed target kinds retain fixed kind order and per-kind declaration order", () => {
  const built = defineFrameworkConfig({ ...config(), networks: [applicationVpc],
    services: [{ "/zulu": { directory: "/services/zulu", port: 8000, methods: ["GET"], deploy: "none", cloud: { vpc: applicationVpc } }, "/alpha": { directory: "/services/alpha", port: 8001, methods: ["GET"], deploy: "none", cloud: { vpc: applicationVpc } } }],
    tasks: [{ worker: { deploy: "none", cloud: { vpc: applicationVpc } } }],
    workflows: [{ flow: workflow(() => succeed(), { deploy: "none", timeoutSeconds: 60 }) }],
    agents: [{ assistant: { directory: "/agents/assistant", deploy: "none" } }],
  } as never);
  assert.deepEqual(assertFrameworkTargetsComplete(built, new FrameworkTargetRegistry(), options).disabled,
    ["lambda:second", "lambda:first", "service:zulu", "service:alpha", "task:worker", "workflow:flow", "agent:assistant"]);
  const registry = new FrameworkTargetRegistry();
  registry.service("zulu", "http://fixture");
  assert.throws(() => assertFrameworkTargetsComplete(built, registry, options), {
    message: 'Framework target "service:zulu" is disabled for the cloud scope in framework.config.ts but a stack registered it.',
  });
});
