import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFrameworkConfig, type FrameworkConfig, type HttpMethod } from "../src/config";
import { defaults } from "../../../framework-config/defaults";
import { applicationVpc } from "../../../framework-config/networks/application";

function routes(http: string, service: string, methods: readonly [HttpMethod, ...HttpMethod[]] = ["GET"]): FrameworkConfig {
  return { defaults, resources: {}, networks: [applicationVpc], http: { [http]: { directory: "/functions/handler", methods: ["GET"] } },
    services: { [service]: { directory: "/services/service", port: 8000, methods, cloud: { vpc: applicationVpc } } },
    webSocket: {}, events: {},
  };
}

test("literal and mount overlap respects root, segments, case and methods", () => {
  for (const [http, service] of [["/", "/"], ["/", "/*"], ["/api", "/api"], ["/api", "/api/*"], ["/api/child", "/api/*"]]) {
    assert.throws(() => normalizeFrameworkConfig(routes(http!, service!)), {
      message: `HTTP routes http["${http}"] (lambda:handler) and services["${service}"] (service:service) both accept GET ${http}. One request belongs to one route.`,
    });
    assert.doesNotThrow(() => normalizeFrameworkConfig(routes(http!, service!, ["POST"])));
  }
  for (const [http, service] of [["/", "/api"], ["/api", "/API"], ["/apis", "/api/*"], ["/api", "/api/child/*"]]) {
    assert.doesNotThrow(() => normalizeFrameworkConfig(routes(http!, service!)));
  }
});
