import assert from "node:assert/strict";
import { test } from "node:test";
import { localDatabaseUrl, userPoolRegion } from "../scripts/local-users.js";

test("only the Compose database or one on this machine may be changed", () => {
  for (const url of [
    "postgresql://admin:password@postgres:5432/app_db",
    "postgresql://admin:password@localhost:5432/app_db",
    "postgresql://admin:password@127.0.0.1:5432/app_db",
    "postgresql://admin:password@[::1]:5432/app_db",
  ]) {
    assert.equal(localDatabaseUrl(url), url);
  }

  assert.throws(
    () => localDatabaseUrl("postgresql://app@prod.cluster-abc.us-east-1.rds.amazonaws.com:5432/app_db"),
    /only the local Compose database/,
  );
  assert.throws(() => localDatabaseUrl(undefined), /DATABASE_URL is required/);
  assert.throws(() => localDatabaseUrl("not a url"), /not a valid URL/);
});

test("the pool region comes from the pool id", () => {
  assert.equal(userPoolRegion("eu-west-2_Abc123"), "eu-west-2");
  assert.equal(userPoolRegion("us-gov-west-1_Abc123"), "us-gov-west-1");
  assert.equal(userPoolRegion("not-a-pool"), undefined);
});
