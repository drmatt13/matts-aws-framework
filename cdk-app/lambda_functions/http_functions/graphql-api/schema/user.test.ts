import assert from "node:assert/strict";
import { test } from "node:test";
import { graphql } from "graphql";
import {
  CognitoIdentityConflictError,
  type UserRecord,
  type UserRepository,
} from "@repo/database";
import type { GraphQLContext } from "../graphql-context";
import { schema } from "./index";

const user: UserRecord = {
  id: "user-1",
  cognitoSub: "subject-1",
  email: "person@example.com",
  firstName: "First",
  lastName: "Last",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const query = "{ currentUser { id email firstName lastName updatedAt } }";
const update = `mutation($data: UpdateCurrentUserInput!) {
  updateCurrentUser(data: $data) { user { id firstName lastName } }
}`;

function fixture(
  options: {
    missing?: boolean;
    conflictingEmail?: boolean;
    payload?: Record<string, unknown>;
  } = {},
) {
  const writes: Array<{ method: string; value: unknown }> = [];
  const users: UserRepository = {
    findById: async () => {
      throw new Error("Unexpected lookup by caller-supplied id");
    },
    findByCognitoSubOrEmail: async () => {
      throw new Error("Unexpected combined identity lookup");
    },
    findByCognitoSub: async (sub) => {
      assert.equal(sub, user.cognitoSub);
      return options.missing ? null : user;
    },
    findByEmail: async (email) => {
      assert.equal(email, user.email);
      return options.conflictingEmail
        ? { ...user, cognitoSub: "another-subject" }
        : null;
    },
    create: async (input) => {
      writes.push({ method: "create", value: input });
      return { ...user, ...input };
    },
    updateById: async () => {
      throw new Error("Unexpected identity reassignment");
    },
    updateByCognitoSub: async (sub, input) => {
      assert.equal(sub, user.cognitoSub);
      writes.push({ method: "update", value: { sub, ...input } });
      return options.missing ? null : { ...user, ...input };
    },
  };
  const contextValue = {
    session: { payload: { sub: user.cognitoSub, ...options.payload } },
    database: { users },
  } as unknown as GraphQLContext;
  return {
    writes,
    run: (source: string, variableValues?: Record<string, unknown>) =>
      graphql({ schema, source, variableValues, contextValue }),
  };
}

test("currentUser reads the session identity and exposes only its public profile", async () => {
  const { run, writes } = fixture();
  const result = await run(query);
  assert.equal(result.errors, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(result.data)), {
    currentUser: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      updatedAt: user.updatedAt,
    },
  });
  for (const field of ["cognitoSub", "createdAt"]) {
    assert.match(
      (await run(`{ currentUser { ${field} } }`)).errors![0].message,
      /Cannot query field/,
    );
  }
  assert.deepEqual(writes, []);
});

test("currentUser provisions only a verified identity and normalizes provider names", async () => {
  const { run, writes } = fixture({
    missing: true,
    payload: {
      email: user.email,
      email_verified: true,
      given_name: "  Given  ",
      family_name: "  Family  ",
    },
  });
  assert.equal((await run(query)).errors, undefined);
  assert.deepEqual(writes, [
    {
      method: "create",
      value: {
        cognitoSub: user.cognitoSub,
        email: user.email,
        firstName: "Given",
        lastName: "Family",
      },
    },
  ]);
  const fallback = fixture({
    missing: true,
    payload: { email: user.email, email_verified: true, given_name: " " },
  });
  assert.equal((await fallback.run(query)).errors, undefined);
  assert.deepEqual(fallback.writes, [
    {
      method: "create",
      value: {
        cognitoSub: user.cognitoSub,
        email: user.email,
        firstName: "person",
        lastName: "",
      },
    },
  ]);
});

test("currentUser refuses provisioning without a verified email", async () => {
  for (const payload of [
    {},
    { email: user.email },
    { email: user.email, email_verified: false },
    { email: user.email, email_verified: "true" },
    { email_verified: true },
  ]) {
    const { run, writes } = fixture({ missing: true, payload });
    assert.equal((await run(query)).errors![0].extensions.code, "NOT_FOUND");
    assert.deepEqual(writes, []);
  }
});

test("currentUser never rebinds another Cognito identity using a matching email", async () => {
  const { run, writes } = fixture({
    missing: true,
    conflictingEmail: true,
    payload: { email: user.email, email_verified: true },
  });
  const result = await run(query);
  assert.ok(
    result.errors![0].originalError instanceof CognitoIdentityConflictError,
  );
  assert.deepEqual(writes, []);
});

test("updateCurrentUser updates only supplied profile fields for the session identity", async () => {
  const { run, writes } = fixture();
  const result = await run(update, { data: { firstName: "Changed" } });
  assert.equal(result.errors, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(result.data)), {
    updateCurrentUser: {
      user: { id: user.id, firstName: "Changed", lastName: user.lastName },
    },
  });
  assert.deepEqual(writes, [
    { method: "update", value: { sub: user.cognitoSub, firstName: "Changed" } },
  ]);
});

test("updateCurrentUser rejects empty, null, invalid, and protected inputs without writing", async () => {
  const { run, writes } = fixture();
  for (const data of [{}, { firstName: null }]) {
    assert.equal(
      (await run(update, { data })).errors![0].extensions.code,
      "BAD_USER_INPUT",
    );
  }
  for (const data of [
    null,
    { firstName: 123 },
    { id: "other" },
    { email: "other@example.com" },
    { cognitoSub: "other" },
  ]) {
    assert.ok((await run(update, { data })).errors);
  }
  assert.deepEqual(writes, []);
});

test("updateCurrentUser reports a missing application user", async () => {
  const { run, writes } = fixture({ missing: true });
  assert.equal(
    (await run(update, { data: { lastName: "Changed" } })).errors![0].extensions
      .code,
    "NOT_FOUND",
  );
  assert.deepEqual(writes, [
    { method: "update", value: { sub: user.cognitoSub, lastName: "Changed" } },
  ]);
});
