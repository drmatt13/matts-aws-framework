import assert from "node:assert/strict";
import test from "node:test";
import {
  defineFrameworkConfig,
  normalizeFrameworkConfig,
  resolveTaskTarget,
  validateFrameworkConfig,
  type ContainerArchitecture,
  type FrameworkConfig,
} from "@repo/framework/config";

function fixture(architecture?: ContainerArchitecture, override?: ContainerArchitecture): FrameworkConfig {
  return defineFrameworkConfig({
    resources: {},
    defaults: {
      lambda: {
        runtime: "nodejs24", packaging: "zip", architecture: "arm64",
        memorySize: 128, timeoutSeconds: 10, bundling: { minify: true, sourceMap: true },
      },
      container: { architecture },
    },
    http: [], webSocket: [], events: [],
    tasks: [{ job: { cloud: { architecture: override } } }],
    services: [{ "/orders/*": {
      directory: "/ecs_containers/services/orders", methods: ["GET"], port: 8000,
      cloud: { architecture: override },
    } }],
  } as never);
}

for (const architecture of ["arm64", "x86_64"] as const) {
  test(`tasks and services inherit the ${architecture} container default`, () => {
    const config = fixture(architecture);
    validateFrameworkConfig(config);
    assert.equal(resolveTaskTarget(config, "job").cloud.architecture, architecture);
    assert.equal(normalizeFrameworkConfig(config).targets.get("service:orders")?.cloud.service?.architecture, architecture);
  });

  test(`a target's ${architecture} override wins over the container default`, () => {
    const config = fixture(architecture === "arm64" ? "x86_64" : "arm64", architecture);
    assert.equal(resolveTaskTarget(config, "job").cloud.architecture, architecture);
    assert.equal(normalizeFrameworkConfig(config).targets.get("service:orders")?.cloud.service?.architecture, architecture);
  });
}

test("tasks and services always resolve an architecture, even without a default", () => {
  const config = fixture();
  assert.equal(resolveTaskTarget(config, "job").cloud.architecture, "x86_64");
  assert.equal(normalizeFrameworkConfig(config).targets.get("service:orders")?.cloud.service?.architecture, "x86_64");
});

test("unsupported container defaults are refused", () => {
  assert.throws(
    () => validateFrameworkConfig(fixture("sparc" as ContainerArchitecture)),
    /defaults\.container\.architecture "sparc" is not supported/,
  );
});
