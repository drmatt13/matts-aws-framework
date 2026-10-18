import assert from "node:assert/strict";
import { test } from "node:test";
import type { UserRecord, UserRepository } from "../src/contracts.js";
import {
  seedTestUser,
  testUserSettings,
  type CognitoTestUser,
  type TestUserDirectory,
} from "../scripts/seed-test-user.js";

const settings = { email: "testuser@example.com", password: "a-long-password" };

function fakeUsers(seed: UserRecord[] = []) {
  const rows = [...seed];
  const repository: UserRepository = {
    findById: async (id) => rows.find((r) => r.id === id) ?? null,
    findByCognitoSub: async (sub) => rows.find((r) => r.cognitoSub === sub) ?? null,
    findByEmail: async (email) => rows.find((r) => r.email === email) ?? null,
    findByCognitoSubOrEmail: async (sub, email) =>
      rows.find((r) => r.cognitoSub === sub || r.email === email) ?? null,
    create: async (input) => {
      const row: UserRecord = {
        id: `id-${rows.length + 1}`,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        ...input,
      };
      rows.push(row);
      return row;
    },
    updateById: async () => null,
    updateByCognitoSub: async () => null,
  };
  return { repository, rows };
}

function fakeDirectory(existing?: CognitoTestUser) {
  const calls: string[] = [];
  const passwords: string[] = [];
  let account = existing;
  let failCreate: Error | undefined;
  const directory: TestUserDirectory = {
    find: async () => account,
    create: async (email, password, name) => {
      calls.push(`create ${email} ${name.givenName} ${name.familyName}`);
      passwords.push(password);
      if (failCreate) throw failCreate;
      account = { sub: "sub-new", ...name, emailVerified: true };
      return account;
    },
    markEmailVerified: async (email) => {
      calls.push(`verify ${email}`);
    },
    setPermanentPassword: async (email, password) => {
      calls.push(`password ${email}`);
      passwords.push(password);
    },
  };
  return {
    directory,
    calls,
    passwords,
    failCreateWith(error: Error) {
      failCreate = error;
    },
  };
}

// What a development export wrote to root .env and Compose hands the service.
const exported = "my-aws-app";

test("settings come from cdk-app/.env, with the email normalized", () => {
  assert.deepEqual(
    testUserSettings({
      LOCAL_TEST_USER_EMAIL: "  TestUser@Example.com ",
      LOCAL_TEST_USER_PASSWORD: "a-long-password",
    }, exported),
    { status: "ready", settings },
  );
});

test("only a development export's pool ever gets a test user", () => {
  const configured = { LOCAL_TEST_USER_EMAIL: settings.email, LOCAL_TEST_USER_PASSWORD: settings.password };
  // root .env not written by a development export: its pool could be anyone's.
  for (const deployment of [undefined, "", "  "]) {
    const outcome = testUserSettings(configured, deployment);
    assert.equal(outcome.status, "skipped");
    assert.match(outcome.status === "skipped" ? outcome.reason : "", /development export/);
  }
  // A leftover PROD_DEPLOYMENT=true still refuses, whatever was exported.
  for (const PROD_DEPLOYMENT of ["true", " TRUE "]) {
    const outcome = testUserSettings({ ...configured, PROD_DEPLOYMENT }, exported);
    assert.equal(outcome.status, "skipped");
    assert.match(outcome.status === "skipped" ? outcome.reason : "", /PROD_DEPLOYMENT=true/);
  }
  assert.equal(testUserSettings({ ...configured, PROD_DEPLOYMENT: "false" }, exported).status, "ready");
});

test("without both settings there is nothing to create", () => {
  assert.equal(testUserSettings({}, exported).status, "skipped");
  assert.equal(testUserSettings({ LOCAL_TEST_USER_EMAIL: settings.email }, exported).status, "skipped");
  assert.equal(testUserSettings({ LOCAL_TEST_USER_PASSWORD: "x" }, exported).status, "skipped");
});

test("creates the Cognito account and its row on a fresh deployment", async () => {
  const users = fakeUsers();
  const cognito = fakeDirectory();

  const outcome = await seedTestUser({ settings, cognito: cognito.directory, users: users.repository });

  assert.equal(outcome.status, "ready");
  assert.deepEqual(cognito.calls, [
    "create testuser@example.com Test User",
    "password testuser@example.com",
  ]);
  assert.deepEqual(cognito.passwords, [settings.password, settings.password]);
  assert.deepEqual(
    users.rows.map(({ cognitoSub, email, firstName, lastName }) => ({ cognitoSub, email, firstName, lastName })),
    [{ cognitoSub: "sub-new", email: settings.email, firstName: "Test", lastName: "User" }],
  );
  assert.ok(outcome.status === "ready" && outcome.createdInCognito && outcome.createdRow);
});

test("an existing account keeps its row and gets the password from cdk-app/.env", async () => {
  const row: UserRecord = {
    id: "id-1",
    cognitoSub: "sub-1",
    email: settings.email,
    firstName: "Edited",
    lastName: "In App",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const users = fakeUsers([row]);
  const cognito = fakeDirectory({ sub: "sub-1", givenName: "Test", familyName: "User", emailVerified: true });

  const outcome = await seedTestUser({ settings, cognito: cognito.directory, users: users.repository });

  assert.deepEqual(cognito.calls, ["password testuser@example.com"]);
  assert.equal(users.rows.length, 1);
  assert.equal(users.rows[0].firstName, "Edited");
  assert.ok(outcome.status === "ready" && !outcome.createdInCognito && !outcome.createdRow);
});

test("an existing account with an unverified email is verified, and its missing row created", async () => {
  const users = fakeUsers();
  const cognito = fakeDirectory({ sub: "sub-1", givenName: "Ada", familyName: "Lovelace", emailVerified: false });

  const outcome = await seedTestUser({ settings, cognito: cognito.directory, users: users.repository });

  assert.deepEqual(cognito.calls, ["verify testuser@example.com", "password testuser@example.com"]);
  assert.equal(users.rows[0].cognitoSub, "sub-1");
  assert.equal(users.rows[0].firstName, "Ada");
  assert.ok(outcome.status === "ready" && outcome.createdRow);
});

test("a Cognito failure writes no row", async () => {
  const users = fakeUsers();
  const cognito = fakeDirectory();
  cognito.failCreateWith(new Error("Password did not conform with policy: Password not long enough"));

  const outcome = await seedTestUser({ settings, cognito: cognito.directory, users: users.repository });

  assert.deepEqual(outcome, {
    status: "skipped",
    reason: "Password did not conform with policy: Password not long enough",
  });
  assert.equal(users.rows.length, 0);
});

test("a row holding the email for another identity is reported, not overwritten", async () => {
  const stale: UserRecord = {
    id: "id-1",
    cognitoSub: "sub-old",
    email: settings.email,
    firstName: "Old",
    lastName: "Pool",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const users = fakeUsers([stale]);
  const cognito = fakeDirectory();

  const outcome = await seedTestUser({ settings, cognito: cognito.directory, users: users.repository });

  assert.equal(outcome.status, "skipped");
  assert.match(outcome.status === "skipped" ? outcome.reason : "", /different Cognito identity/);
  assert.deepEqual(users.rows, [stale]);
});
