import assert from "./support/assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { createSightlineWorkspaceRegistry } from "../src/sightline/bridge";
import {
  buildWorkspace,
  sightlineContributorKinds,
  sightlineWorkspacePaths,
  workspaceFor,
  type WorkspaceFragments,
} from "../src/sightline/workspace";
import { snapshot } from "./browser/support/scenarios";
import type { SightlineOmission } from "../src/sightline/types";

test("Sightline readers remain idle without a visible consumer and release their fragments", () => {
  const store = createSightlineWorkspaceRegistry();
  const owner = Symbol("workspace");
  let reads = 0,
    notifications = 0;
  store.publish("databaseSql", owner, () => {
    reads++;
    return { targetId: "local:postgres", busy: false, reviewOpen: false };
  });
  assert.equal(reads, 0);
  assert.deepEqual(store.getSnapshot(), {});
  const close = store.subscribe(() => notifications++);
  assert.equal(reads, 1);
  assert.equal(notifications, 1);
  const first = store.getSnapshot();
  store.publish("databaseSql", owner, () => ({
    targetId: "local:postgres",
    busy: false,
    reviewOpen: false,
  }));
  assert.equal(
    notifications,
    1,
    "equal fragments retain object identity and do not rerender the consumer",
  );
  assert.equal(store.getSnapshot(), first);
  store.publish("databaseSql", owner, () => ({
    targetId: "production",
    busy: false,
    reviewOpen: false,
  }));
  assert.equal(notifications, 2);
  close();
  assert.deepEqual(store.getSnapshot(), {});
  store.publish("databaseSql", owner, () => {
    reads++;
    return { targetId: "production", busy: true, reviewOpen: false };
  });
  assert.equal(
    reads,
    1,
    "closed Sightline neither subscribes to owners nor evaluates readers",
  );
  store.remove("databaseSql", owner);
});

test("Sightline cleanup is identity guarded and child fragments have independent lifetimes", () => {
  const store = createSightlineWorkspaceRegistry();
  const previous = Symbol("old"),
    current = Symbol("new"),
    child = Symbol("child");
  const close = store.subscribe(() => {});
  store.publish("websockets", previous, () => ({ availability: "loading" }));
  store.publish("websockets", current, () => ({ availability: "available" }));
  store.publish("websocketLocal", child, () => ({
    connection: "connected",
    configured: true,
    valid: true,
  }));
  store.remove("websockets", previous);
  assert.equal(store.getSnapshot().websockets?.availability, "available");
  store.remove("websocketLocal", child);
  assert.equal(store.getSnapshot().websocketLocal, undefined);
  assert.equal(store.getSnapshot().websockets?.availability, "available");
  store.remove("websockets", current);
  assert.deepEqual(store.getSnapshot(), {});
  close();
});

test("every actual Studio workspace route has an exhaustive Sightline contributor", () => {
  const file = ts.createSourceFile(
    "main.tsx",
    readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const paths: string[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(file) === "createRoute"
    ) {
      const declaration = node.arguments[0];
      if (declaration && ts.isObjectLiteralExpression(declaration)) {
        const entries = declaration.properties.filter(ts.isPropertyAssignment);
        const path = entries.find(
          (entry) => entry.name.getText(file) === "path",
        )?.initializer;
        const redirected = entries.some(
          (entry) => entry.name.getText(file) === "beforeLoad",
        );
        if (
          !redirected &&
          path &&
          ts.isStringLiteral(path) &&
          path.text.startsWith("/")
        )
          paths.push(path.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.deepEqual(paths.sort(), Object.keys(sightlineWorkspacePaths).sort());
  assert.deepEqual(
    [...new Set(Object.values(sightlineWorkspacePaths))].sort(),
    [...sightlineContributorKinds].sort(),
  );
  for (const subsection of [
    "user-pools",
    "identity-pools",
    "providers",
    "permissions",
  ])
    assert.equal(workspaceFor(`/cognito/${subsection}`), "cognito");
});

test("Database target follows the active tab while hidden selections remain identifiable", () => {
  const fragments: WorkspaceFragments = {
    database: {
      availability: "available",
      tab: "sql",
      editorMode: "split",
      dirty: true,
      conflicted: false,
      validation: {
        availability: "not-loaded",
        current: false,
        diagnostics: [],
      },
      diagramRetained: false,
    },
    databaseSql: { targetId: "local:postgres", busy: false, reviewOpen: false },
    databaseTarget: {
      availability: "available",
      targetId: "production",
      inspecting: false,
      reviewing: false,
      applying: false,
    },
    databaseHistory: { availability: "available", selectedId: "migration:one" },
  };
  const sql = buildWorkspace(
    "database",
    fragments,
    snapshot().snapshot,
    "dev",
    [],
  );
  assert.equal(sql.kind, "database");
  if (sql.kind !== "database") return;
  assert.equal("id" in sql.target && sql.target.id, "local:postgres");
  assert.equal(
    "selectedId" in sql.migration && sql.migration.selectedId,
    "migration:one",
  );
  assert.equal(
    "diagnostics" in sql.validation && sql.validation.diagnostics,
    null,
  );
  fragments.database!.tab = "database";
  const database = buildWorkspace(
    "database",
    fragments,
    snapshot().snapshot,
    "dev",
    [],
  );
  assert.equal(
    database.kind === "database" &&
      "id" in database.target &&
      database.target.id,
    "production",
  );
});

test("workspace projection retains availability, applies pending domain metadata, and omits unlisted values", () => {
  const marker = "PRIVATE_SIGHTLINE_WORKSPACE_CANARY";
  const fragments: WorkspaceFragments = {
    domains: {
      destination: { deployment: "test-prod", region: "us-east-1" },
      source: {
        availability: "available",
        mode: "prod",
        inputs: [{ name: "FRONTEND_URL", present: true, modified: false }],
        diagnostics: [],
      },
      observed: { availability: "not-loaded", stale: false },
    },
    domainIntent: {
      inputs: [{ name: "FRONTEND_URL", present: false, modified: true }],
      diagnostics: [{ severity: "error" }],
    },
  };
  Object.assign(fragments.domains!.source, {
    values: { FRONTEND_URL: marker },
    error: marker,
  });
  Object.assign(fragments.domains!.observed, {
    certificates: [{ arn: marker }],
    dns: [{ value: marker }],
  });
  const omitted: SightlineOmission[] = [];
  const value = buildWorkspace(
    "domains",
    fragments,
    snapshot().snapshot,
    "dev",
    omitted,
  );
  assert.equal(value.kind, "domains");
  if (value.kind !== "domains") return;
  assert.deepEqual("inputs" in value.source && value.source.inputs, [
    { name: "FRONTEND_URL", present: false, modified: true },
  ]);
  assert.equal(value.source.mode, "prod");
  assert.equal(value.observed.availability, "not-loaded");
  assert.ok(!JSON.stringify(value).includes(marker));
  assert.ok(omitted.some((item) => item.reason === "privacy"));
});
