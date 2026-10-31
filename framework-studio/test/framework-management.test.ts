import assert from "./support/assert";
import { test } from "node:test";
import type { ModelResource } from "../shared/model";
import { isFrameworkManagedResource } from "../shared/framework-management";
import { resourceBadge } from "../src/icons";
import { buildIconShape } from "../src/scene/shapes";

const resource = (id: string, extra: Partial<ModelResource> = {}): ModelResource => ({ id, path: [id], kind: "member", absent: false, ...extra });

test("ownership follows framework stack parents without treating application declarations as managed", () => {
  const stack = resource("framework-stack", { kind: "stack", frameworkStack: true });
  const member = resource("member", { parent: stack.id });
  const nested = resource("nested", { parent: member.id, absent: true });
  const map = new Map([stack, member, nested].map(item => [item.id, item]));
  for (const item of [stack, member, nested]) {
    assert.equal(isFrameworkManagedResource(item, map), true, item.id);
    assert.equal(resourceBadge(item, map), "managed", item.id);
  }
  for (const kind of ["stack", "member", "input", "secret", "group", "envFile"] as const) {
    assert.equal(isFrameworkManagedResource(resource(kind, { kind }), map), false, kind);
  }
  assert.equal(isFrameworkManagedResource(resource("broken", { parent: "missing" }), map), false);
  const loop = resource("loop", { parent: "loop" });
  assert.equal(isFrameworkManagedResource(loop, new Map([[loop.id, loop]])), false);
});

test("a missing framework input file keeps its ownership while its error takes the badge alone", () => {
  const file = resource("envfile:dev", { kind: "envFile", deploymentFile: { mode: "dev", path: "cdk-app/.env.dev", template: "cdk-app/.env.dev.template", exists: false, entries: [] } });
  assert.equal(isFrameworkManagedResource(file), true, "hover cards and inspectors still state ownership");
  assert.equal(resourceBadge(file), "error", "where one badge fits, the error wins over the lock");
  const xs = (shape: ReturnType<typeof buildIconShape>) => shape.hull.filter((_, at) => at % 2 === 0);
  assert.ok(Math.max(...xs(buildIconShape(0, 0, true, false))) >= 39 && Math.min(...xs(buildIconShape(0, 0, true, false))) > -39, "one right badge reserves only its own corner");
  assert.ok(Math.min(...xs(buildIconShape(0, 0, true, true))) <= -39, "a role badge displaced to the left keeps its corner too");
});
