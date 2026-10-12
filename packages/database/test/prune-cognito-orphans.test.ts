import assert from "node:assert/strict";
import { test } from "node:test";
import {
  pruneCognitoOrphans,
  type LocalUser,
  type LocalUserStore,
} from "../scripts/prune-cognito-orphans.js";

function fakeStore(seed: LocalUser[]) {
  const rows = [...seed];
  const store: LocalUserStore = {
    list: async () => [...rows],
    remove: async ({ id, cognitoSub }) => {
      const index = rows.findIndex(
        (row) => row.id === id && row.cognitoSub === cognitoSub,
      );
      if (index === -1) return false;
      rows.splice(index, 1);
      return true;
    },
  };
  return { store, rows };
}

const kept: LocalUser = { id: "id-1", cognitoSub: "sub-live", email: "live@example.com" };
const stale: LocalUser = { id: "id-2", cognitoSub: "sub-old-pool", email: "ada@example.com" };

test("removes rows whose sub the pool no longer holds and keeps the rest", async () => {
  const { store, rows } = fakeStore([kept, stale]);

  const outcome = await pruneCognitoOrphans({
    users: store,
    listCognitoSubs: async () => new Set(["sub-live", "sub-new-pool"]),
  });

  assert.deepEqual(outcome, { status: "checked", checked: 2, removed: [stale] });
  assert.deepEqual(rows, [kept]);
});

test("an empty pool that was listed successfully removes every row", async () => {
  const { store, rows } = fakeStore([kept, stale]);

  const outcome = await pruneCognitoOrphans({
    users: store,
    listCognitoSubs: async () => new Set(),
  });

  assert.equal(outcome.status, "checked");
  assert.deepEqual(rows, []);
});

test("a failed pool listing removes nothing", async () => {
  const { store, rows } = fakeStore([kept, stale]);

  const outcome = await pruneCognitoOrphans({
    users: store,
    listCognitoSubs: async () => {
      throw new Error("The SSO session associated with this profile has expired");
    },
  });

  assert.deepEqual(outcome, {
    status: "skipped",
    reason: "The SSO session associated with this profile has expired",
  });
  assert.deepEqual(rows, [kept, stale]);
});

test("an empty database does not call Cognito", async () => {
  const { store } = fakeStore([]);

  const outcome = await pruneCognitoOrphans({
    users: store,
    listCognitoSubs: async () => assert.fail("Cognito must not be listed"),
  });

  assert.deepEqual(outcome, { status: "checked", checked: 0, removed: [] });
});

test("a row removed concurrently is not reported as removed", async () => {
  const { store } = fakeStore([stale]);
  store.remove = async () => false;

  const outcome = await pruneCognitoOrphans({
    users: store,
    listCognitoSubs: async () => new Set(),
  });

  assert.deepEqual(outcome, { status: "checked", checked: 1, removed: [] });
});
