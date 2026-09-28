import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CognitoIdentityConflictError,
  ensureCognitoUser,
  type CognitoUserIdentity,
} from "../src/cognito-users.js";
import type { UserRecord, UserRepository } from "../src/contracts.js";

/**
 * A fake standing in for the real repository. This is what the
 * `UserRepository` interface is for: `ensureCognitoUser` depends on the
 * interface, not on the Prisma-backed factory, so its branching can be tested
 * without a database.
 */
function fakeUsers(seed: UserRecord[] = []) {
  const rows = [...seed];
  let onCreate: (() => void) | undefined;

  const repository: UserRepository = {
    findById: async (id) => rows.find((r) => r.id === id) ?? null,
    findByCognitoSub: async (sub) =>
      rows.find((r) => r.cognitoSub === sub) ?? null,
    findByEmail: async (email) => rows.find((r) => r.email === email) ?? null,
    findByCognitoSubOrEmail: async (sub, email) =>
      rows.find((r) => r.cognitoSub === sub || r.email === email) ?? null,
    create: async (input) => {
      onCreate?.();
      const row: UserRecord = {
        id: `id-${rows.length + 1}`,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        ...input,
      };
      rows.push(row);
      return row;
    },
    updateById: async (id, input) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      Object.assign(row, input);
      return row;
    },
    updateByCognitoSub: async (sub, input) => {
      const row = rows.find((r) => r.cognitoSub === sub);
      if (!row) return null;
      Object.assign(row, input);
      return row;
    },
  };

  return {
    repository,
    rows,
    failNextCreate(then: () => void) {
      onCreate = () => {
        onCreate = undefined;
        then();
        throw new Error("duplicate key value violates unique constraint");
      };
    },
  };
}

const identity: CognitoUserIdentity = {
  cognitoSub: "sub-1",
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
};

test("creates a profile for an unseen identity", async () => {
  const users = fakeUsers();

  const user = await ensureCognitoUser(users.repository, identity);

  assert.equal(user.cognitoSub, "sub-1");
  assert.equal(user.email, "ada@example.com");
  assert.equal(users.rows.length, 1);
});

test("refreshes profile fields for a known cognito sub", async () => {
  const users = fakeUsers();
  await ensureCognitoUser(users.repository, identity);

  const user = await ensureCognitoUser(users.repository, {
    ...identity,
    lastName: "Byron",
  });

  assert.equal(user.lastName, "Byron");
  assert.equal(users.rows.length, 1, "must update rather than insert a second row");
});

test("refuses to rebind an email to a different cognito identity", async () => {
  const users = fakeUsers();
  await ensureCognitoUser(users.repository, identity);

  await assert.rejects(
    () => ensureCognitoUser(users.repository, { ...identity, cognitoSub: "sub-2" }),
    CognitoIdentityConflictError,
  );
});

test("recovers when a concurrent writer wins the insert race", async () => {
  const users = fakeUsers();

  // The post-confirmation trigger and the OAuth callback can both arrive first.
  users.failNextCreate(() => {
    users.rows.push({
      id: "id-concurrent",
      cognitoSub: identity.cognitoSub,
      email: identity.email,
      firstName: identity.firstName,
      lastName: identity.lastName,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  const user = await ensureCognitoUser(users.repository, identity);

  assert.equal(user.id, "id-concurrent");
  assert.equal(users.rows.length, 1);
});
