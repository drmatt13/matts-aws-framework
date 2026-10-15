import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { databaseConnection, databaseUrl } from "../src/runtime/database";
import { RDS_CA_BUNDLE } from "../src/runtime/rds-ca-bundle";

const DEPLOYED = "postgresql://app_user@app.abc123.us-east-1.rds.amazonaws.com:5432/app_db";
const LOCAL = "postgresql://admin:password@postgres:5432/app_db";

/** Runs with exactly these database variables, and static credentials so signing never leaves the process. */
async function withEnvironment(values: Record<string, string | undefined>, run: () => Promise<void> | void): Promise<void> {
  const names = ["PRIMARY_DATABASE_URL", "PRIMARY_DATABASE_AUTH", "PRIMARY_DATABASE_READ_URLS", "PRIMARY_DATABASE_POOL_OPTIONS", "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  Object.assign(process.env, { AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" }, values);
  try {
    await run();
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

test("locally the Compose URL passes straight through", async () => {
  await withEnvironment({ PRIMARY_DATABASE_URL: LOCAL }, async () => {
    assert.deepEqual(databaseConnection(), { connectionString: LOCAL });
    assert.equal(await databaseUrl(), LOCAL);
  });
});

test("in AWS every new connection signs its own IAM token, over verified TLS", async () => {
  await withEnvironment({ PRIMARY_DATABASE_URL: DEPLOYED, PRIMARY_DATABASE_AUTH: "iam", AWS_REGION: "us-east-1" }, async () => {
    const connection = databaseConnection();
    assert.equal(connection.connectionString, undefined, "no URL, so nothing can carry a password");
    assert.equal(connection.host, "app.abc123.us-east-1.rds.amazonaws.com");
    assert.equal(connection.port, 5432);
    assert.equal(connection.database, "app_db");
    assert.equal(connection.user, "app_user");
    assert.equal(connection.ssl?.rejectUnauthorized, true);
    assert.ok(connection.ssl?.ca.includes(RDS_CA_BUNDLE), "the RDS certificate authorities are trusted");
    assert.equal(typeof connection.password, "function", "a pool asks for a password per connection");

    const token = await connection.password!();
    assert.match(token, /^app\.abc123\.us-east-1\.rds\.amazonaws\.com:5432\/\?Action=connect&DBUser=app_user&/);
    assert.match(token, /X-Amz-Signature=[0-9a-f]{64}/);
    assert.match(token, /X-Amz-Expires=900/, "good for 15 minutes");
  });
});

test("a tool that only takes a URL gets one with a fresh token and the trust store", async () => {
  await withEnvironment({ PRIMARY_DATABASE_URL: DEPLOYED, PRIMARY_DATABASE_AUTH: "iam", AWS_REGION: "us-east-1" }, async () => {
    const url = new URL(await databaseUrl());
    assert.equal(url.username, "app_user");
    assert.match(decodeURIComponent(url.password), /Action=connect&DBUser=app_user&.*X-Amz-Signature=/);
    assert.equal(url.searchParams.get("sslmode"), "verify-full");
    const rootCert = url.searchParams.get("sslrootcert") ?? "";
    assert.ok(existsSync(rootCert));
    assert.match(readFileSync(rootCert, "utf8"), /BEGIN CERTIFICATE/);
  });
});

test("a workload without database: true is told to declare it", async () => {
  await withEnvironment({}, async () => {
    assert.throws(() => databaseConnection(), /PRIMARY_DATABASE_URL is not set\. The framework sets it on a workload that declares database: true/);
    await assert.rejects(databaseUrl(), /declares database: true/);
  });
  await withEnvironment({ PRIMARY_DATABASE_URL: DEPLOYED, PRIMARY_DATABASE_AUTH: "password" }, () => {
    assert.throws(() => databaseConnection(), /PRIMARY_DATABASE_AUTH is "password"/);
  });
});

test("reader access is explicit; zero replicas use the writer locally and in AWS", async () => {
  await withEnvironment({ PRIMARY_DATABASE_URL: LOCAL }, () => assert.throws(() => databaseConnection({ role: "reader" }), /Reader access is not declared/));
  await withEnvironment({ PRIMARY_DATABASE_URL: LOCAL, PRIMARY_DATABASE_READ_URLS: "[]" }, () => assert.deepEqual(databaseConnection({ role: "reader" }), databaseConnection()));
  await withEnvironment({ PRIMARY_DATABASE_URL: DEPLOYED, PRIMARY_DATABASE_AUTH: "iam", PRIMARY_DATABASE_READ_URLS: "[]", AWS_REGION: "us-east-1" }, () => assert.equal(databaseConnection({ role: "reader" }).host, databaseConnection().host));
});

test("one replica is selected per execution environment and tokens name that host", async () => {
  const readers = [DEPLOYED.replace("app.abc123", "replica1.abc123"), DEPLOYED.replace("app.abc123", "replica2.abc123")];
  await withEnvironment({ PRIMARY_DATABASE_URL: DEPLOYED, PRIMARY_DATABASE_AUTH: "iam", PRIMARY_DATABASE_READ_URLS: JSON.stringify(readers), AWS_REGION: "us-east-1" }, async () => {
    const reader = databaseConnection({ role: "reader" });
    assert.ok(readers.some(url => new URL(url).hostname === reader.host));
    for (let index = 0; index < 20; index++) assert.equal(databaseConnection({ role: "reader" }).host, reader.host);
    assert.equal(databaseConnection().host, new URL(DEPLOYED).hostname);
    const token = await reader.password!();
    assert.ok(token.startsWith(`${reader.host}:5432/`));
    assert.equal(reader.ssl?.rejectUnauthorized, true);
  });
});

test("pool options apply in both lanes and malformed reader/pool data fails clearly", async () => {
  const pool = { maxConnections: 2, connectionTimeoutMs: 1234, idleTimeoutMs: 0 };
  for (const iam of [false, true]) await withEnvironment({ PRIMARY_DATABASE_URL: iam ? DEPLOYED : LOCAL, ...(iam ? { PRIMARY_DATABASE_AUTH: "iam" } : {}), PRIMARY_DATABASE_POOL_OPTIONS: JSON.stringify(pool) }, () => {
    const connection = databaseConnection();
    assert.equal(connection.max, 2);
    assert.equal(connection.connectionTimeoutMillis, 1234);
    assert.equal(connection.idleTimeoutMillis, 0);
  });
  for (const value of ["bad-json", "null", "{}", '["https://wrong.example"]', "[1]"]) await withEnvironment({ PRIMARY_DATABASE_URL: LOCAL, PRIMARY_DATABASE_READ_URLS: value }, () => assert.throws(() => databaseConnection({ role: "reader" }), /JSON array/));
  for (const value of ["bad-json", "null", "[]", '{"maxConnections":0}', '{"max":2}']) await withEnvironment({ PRIMARY_DATABASE_URL: LOCAL, PRIMARY_DATABASE_POOL_OPTIONS: value }, () => assert.throws(() => databaseConnection()));
});
