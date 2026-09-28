import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeFrameworkConfig,
  type FrameworkConfig,
} from "@repo/framework/config";

function withService(service: Record<string, unknown>): FrameworkConfig {
  return {
    resources: {},
    defaults: {
      lambda: {
        runtime: "nodejs24",
        packaging: "zip",
        architecture: "arm64",
        memorySize: 128,
        timeoutSeconds: 10,
        bundling: { minify: true, sourceMap: true },
      },
    },
    http: {},
    webSocket: {},
    events: {},
    services: {
      "/orders/*": { directory: "/ecs_containers/services/orders", methods: ["GET"], port: 8000, ...service },
    },
  } as unknown as FrameworkConfig;
}

test("a service's load balancer is private unless declared otherwise", () => {
  const config = withService({ auth: true });
  const target = normalizeFrameworkConfig(config).targets.get("service:orders");
  assert.equal(target?.cloud.service?.publicLoadBalancer, false);
});

test("auth: true cannot be combined with a public load balancer", () => {
  assert.throws(
    () => normalizeFrameworkConfig(withService({ auth: true, cloud: { publicLoadBalancer: true } })),
    /reachable without the HTTP API's authorizer/,
  );
  // Without auth the service owns its own access control, so it is allowed.
  normalizeFrameworkConfig(withService({ cloud: { publicLoadBalancer: true } }));
});
