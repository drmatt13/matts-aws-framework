import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import pg from "pg";
import { databaseConnection } from "@repo/framework/runtime/database";

/** Real Docker only when explicitly selected; no developer volume is inspected or reused. */
test("campaign-owned PostgreSQL retains rows across stop/start and complete surrounding container recreation", { skip: process.env.FRAMEWORK_DATABASE_PERSISTENCE !== "job2-disposable" }, async () => {
  const name = `matts-job2-postgres-${randomUUID().slice(0, 8)}`;
  const volume = `${name}-data`;
  const label = `com.matts-aws-framework.job2=${name}`;
  const prior = { url: process.env.PRIMARY_DATABASE_URL, auth: process.env.PRIMARY_DATABASE_AUTH, pool: process.env.PRIMARY_DATABASE_POOL_OPTIONS };
  function docker(args: string[], allowFailure = false): string {
    const result = spawnSync("docker", args, { encoding: "utf8", timeout: 30_000 });
    if (!allowFailure) assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  async function connect() {
    const binding = JSON.parse(docker(["inspect", "--format", "{{json .NetworkSettings.Ports}}", name]))["5432/tcp"][0];
    assert.equal(binding.HostIp, "127.0.0.1");
    process.env.PRIMARY_DATABASE_URL = `postgresql://campaign:campaign-disposable@127.0.0.1:${binding.HostPort}/campaign`;
    delete process.env.PRIMARY_DATABASE_AUTH;
    delete process.env.PRIMARY_DATABASE_POOL_OPTIONS;
    for (let attempt = 0; attempt < 60; attempt++) {
      const client = new pg.Client({ ...databaseConnection(), connectionTimeoutMillis: 1000 });
      try { await client.connect(); return client; }
      catch { await client.end().catch(() => {}); await setTimeout(250); }
    }
    throw new Error("Disposable PostgreSQL did not become reachable through framework databaseConnection().");
  }
  function createContainer() {
    docker(["run", "--detach", "--name", name, "--label", label, "--mount", `type=volume,source=${volume},target=/var/lib/postgresql/data`, "--publish", "127.0.0.1::5432", "--env", "POSTGRES_USER=campaign", "--env", "POSTGRES_PASSWORD=campaign-disposable", "--env", "POSTGRES_DB=campaign", "postgres:16"]);
  }
  try {
    docker(["volume", "create", "--label", label, volume]);
    createContainer();
    let client = await connect();
    try {
      await client.query("CREATE TABLE retained_records (id integer PRIMARY KEY, evidence text NOT NULL)");
      await client.query("INSERT INTO retained_records VALUES (1, $1)", ["job2-original-record"]);
    } finally { await client.end(); }
    docker(["stop", "--time", "5", name]);
    docker(["start", name]);
    client = await connect();
    try { assert.deepEqual((await client.query("SELECT * FROM retained_records")).rows, [{ id: 1, evidence: "job2-original-record" }]); }
    finally { await client.end(); }
    docker(["stop", "--time", "5", name]);
    docker(["rm", name]);
    createContainer();
    client = await connect();
    try {
      assert.deepEqual((await client.query("SELECT * FROM retained_records")).rows, [{ id: 1, evidence: "job2-original-record" }]);
      await assert.rejects(client.query("SELECT incompatible_column FROM retained_records"), (error: unknown) => (error as { code?: string }).code === "42703");
      const rejectedLogin = new pg.Client({ connectionString: process.env.PRIMARY_DATABASE_URL!.replace("campaign-disposable@", "wrong-password@"), connectionTimeoutMillis: 1000 });
      try { await assert.rejects(rejectedLogin.connect(), (error: unknown) => (error as { code?: string }).code === "28P01"); }
      finally { await rejectedLogin.end().catch(() => {}); }
      assert.deepEqual((await client.query("SELECT * FROM retained_records")).rows, [{ id: 1, evidence: "job2-original-record" }], "a failed authentication cannot alter retained records");
    } finally { await client.end(); }
    docker(["stop", "--time", "5", name]);
    docker(["rm", name]);
    // Refuse implicit Docker volume creation after loss: the evidence must exist.
    assert.equal(docker(["volume", "inspect", "--format", `{{index .Labels "com.matts-aws-framework.job2"}}`, volume]), name);
    docker(["volume", "rm", volume]);
    const missing = spawnSync("docker", ["volume", "inspect", volume], { encoding: "utf8" });
    assert.notEqual(missing.status, 0, "intentionally removed campaign volume is reported missing");
    process.env.PRIMARY_DATABASE_URL = "postgresql://campaign:campaign-disposable@127.0.0.1:1/campaign";
    const failed = new pg.Client({ ...databaseConnection(), connectionTimeoutMillis: 500 });
    try { await assert.rejects(failed.connect()); } finally { await failed.end().catch(() => {}); }
  } finally {
    docker(["stop", "--time", "5", name], true);
    docker(["rm", name], true);
    // Cleanup is constrained to this invocation's random name AND ownership label.
    const owned = docker(["volume", "ls", "--filter", `label=${label}`, "--format", "{{.Name}}"], true).split(/\r?\n/).includes(volume);
    if (owned) docker(["volume", "rm", volume]);
    for (const [key, value] of [["PRIMARY_DATABASE_URL", prior.url], ["PRIMARY_DATABASE_AUTH", prior.auth], ["PRIMARY_DATABASE_POOL_OPTIONS", prior.pool]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  }
});
