import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { getDatabase, disconnectDatabase } from "../src/index.js";

test("writer and reader repositories have distinct cached pools, all closed on disconnect", async () => {
  const original = pg.Pool.prototype.end;
  let closed = 0;
  pg.Pool.prototype.end = async function() { closed++; await original.call(this); };
  try {
    const writer = { host: "writer.invalid", port: 5432, user: "app_user", database: "app_db", password: async () => "first-token", max: 2 };
    const first = getDatabase(writer);
    assert.equal(getDatabase({ ...writer, password: async () => "new-token" }), first, "rotating IAM credentials reuse the pool");
    assert.equal(getDatabase({ max: 2, database: "app_db", user: "app_user", port: 5432, host: "writer.invalid" }), first, "property order is not a pool change");
    const reader = getDatabase({ ...writer, host: "reader.invalid" });
    assert.notEqual(reader, first);
    assert.equal(getDatabase({ ...writer, host: "reader.invalid" }), reader);
    assert.throws(() => getDatabase({ ...writer, max: 3 }), /pool settings changed/);
    await disconnectDatabase();
    assert.equal(closed, 2);
    assert.notEqual(getDatabase(writer), first);
    await disconnectDatabase();
    assert.equal(closed, 3);
  } finally { await disconnectDatabase(); pg.Pool.prototype.end = original; }
});

test("password changes in a local URL do not change connection identity", async () => {
  try {
    const first = getDatabase({ connectionString: "postgresql://admin:first@postgres:5432/app_db" });
    assert.equal(getDatabase({ connectionString: "postgresql://admin:second@postgres:5432/app_db" }), first);
  } finally { await disconnectDatabase(); }
});

test("cleanup attempts every pool and resets the cache even if one close fails", async () => {
  const original = pg.Pool.prototype.end;
  let closed = 0;
  const failure = new Error("reader pool close failed");
  pg.Pool.prototype.end = async function() {
    const index = ++closed;
    await original.call(this);
    if (index === 1) throw failure;
  };
  try {
    const writer = getDatabase({ host: "writer-cleanup.invalid", user: "app_user", database: "app_db" });
    getDatabase({ host: "reader-cleanup.invalid", user: "app_user", database: "app_db" });
    await assert.rejects(disconnectDatabase(), error => {
      assert.deepEqual((error as Error & { errors: unknown[] }).errors, [failure]);
      return true;
    });
    assert.equal(closed, 2);
    assert.notEqual(getDatabase({ host: "writer-cleanup.invalid", user: "app_user", database: "app_db" }), writer);
    await disconnectDatabase();
  } finally { await disconnectDatabase(); pg.Pool.prototype.end = original; }
});
