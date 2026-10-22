import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { defineFrameworkConfig, type FrameworkHttp, type FrameworkEvents } from "../src/config/index";
import { locateConfigSource, type ConfigSourceHost } from "../scripts/config-source";

function host(files: Record<string, string>): ConfigSourceHost {
  const entries = new Map(Object.entries(files).map(([file, value]) => [path.resolve("/repo", file), value]));
  return { exists: file => entries.has(file), readFile: file => { const text = entries.get(file); assert.notEqual(text, undefined, file); return text!; } };
}

test("cohesive feature modules and smaller nested modules retain direct composition and locations", () => {
  const source = host({
    "framework.config.ts": `import { identityRoutes, identityEvents } from "./framework-config/features/identity";
import { reportRoutes as reports } from "./framework-config/workloads/http/reports/index";
export default defineFrameworkConfig({ http: [identityRoutes, reports], events: [identityEvents] });`,
    "framework-config/features/identity.ts": `export const identityRoutes = { "/sign-in": { directory: "/sign-in" }, "/refresh": { directory: "/refresh" } } satisfies HttpSection;
export const identityEvents = { confirmed: { directory: "/confirmed" } } satisfies EventsSection;`,
    "framework-config/workloads/http/reports/index.ts": `export const reportRoutes = { "/reports": { directory: "/reports" } } satisfies HttpSection;`,
  });
  const located = locateConfigSource("/repo/framework.config.ts", { repositoryRoot: "/repo", host: source });
  assert.deepEqual(located.sections.http.map(entry => entry.key), ["/sign-in", "/refresh", "/reports"]);
  assert.deepEqual(located.sections.events.map(entry => entry.key), ["confirmed"]);
  assert.equal(located.sections.http[0]!.file, "/repo/framework-config/features/identity.ts");
  assert.equal(located.sections.http[2]!.file, "/repo/framework-config/workloads/http/reports/index.ts");
});

test("duplicate diagnostics name both source owners regardless of module depth", () => {
  const source = host({
    "framework.config.ts": 'import { a } from "./framework-config/a"; import { b } from "./framework-config/features/nested/b"; export default defineFrameworkConfig({ http: [a, b] });',
    "framework-config/a.ts": 'export const a = { "/same": { directory: "/a" } };',
    "framework-config/features/nested/b.ts": 'export const b = { "/same": { directory: "/b" } };',
  });
  assert.throws(() => locateConfigSource("/repo/framework.config.ts", { repositoryRoot: "/repo", host: source }), error => {
    assert.match(String(error), /framework-config\/a\.ts/);
    assert.match(String(error), /framework-config\/features\/nested\/b\.ts/);
    return true;
  });
});

test("section composition retains literal keys and methods while validating resource-bound declarations", () => {
  const routes = { "/reports": { directory: "/reports", methods: ["GET"], tags: { area: "reports" } } } satisfies FrameworkHttp;
  const events = { completed: { directory: "/completed", tags: { area: "reports" } } } satisfies FrameworkEvents;
  const base = { defaults: { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: { minify: true, sourceMap: true } } }, webSocket: [], services: [] } as const;
  const config = defineFrameworkConfig({ ...base, http: [routes], events: [events] });
  const route: "/reports" = Object.keys(config.http)[0] as keyof typeof config.http;
  const method: "GET" = config.http["/reports"].methods[0]!;
  assert.equal(route, "/reports");
  assert.equal(method, "GET");
  assert.throws(() => defineFrameworkConfig({ ...base, http: [routes, routes], events: [] }), /declares.*twice/i);
});
