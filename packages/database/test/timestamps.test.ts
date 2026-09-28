import assert from "node:assert/strict";
import { test } from "node:test";
import postgres from "@prisma/orm-postgres/runtime";
import contractJson from "../src/generated/contract.json" with { type: "json" };
import type { Contract } from "../src/generated/contract.js";

test("contract timestamps apply on create and update without a connection or Temporal", () => {
  // Constructing the context is lazy and needs neither a connection nor a pool.
  const client = postgres<Contract>({ contractJson });
  for (const table of ["projects", "users"]) {
    for (const op of ["create", "update"] as const) {
      const started = Date.now();
      const defaults = client.context.applyMutationDefaults({
        namespace: "public",
        table,
        op,
        values:
          table === "projects"
            ? { name: "Updated" }
            : { first_name: "Updated" },
      });
      const timestamp = defaults.find(
        (entry) => entry.column === "updated_at",
      )?.value;
      assert.ok(timestamp instanceof Date);
      assert.ok(
        timestamp.getTime() >= started && timestamp.getTime() <= Date.now(),
      );
      const column =
        contractJson.storage.namespaces.public.entries.table[
          table as "projects" | "users"
        ].columns.updated_at;
      assert.equal(column.codecId, "pg/timestamptz-string@1");
      assert.deepEqual(column.typeParams, { precision: 6 });
    }
    assert.deepEqual(
      client.context.applyMutationDefaults({
        namespace: "public",
        table,
        op: "update",
        values: {},
      }),
      [],
    );
  }
});
