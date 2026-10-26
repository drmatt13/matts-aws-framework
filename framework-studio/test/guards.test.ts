import assert from "./support/assert";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";
import express from "express";
import { assertWritable } from "../server/files";
import { apiGuard, hostGuard } from "../server/guards";
import { readIntent } from "../server/server";

/**
 * The guards over real HTTP, with the headers a hostile page or a rebinding
 * attack would send. Node's own client is used because it will send any Host.
 */

const token = "a".repeat(48);
let server: Server;
let port: number;

before(async () => {
  const app = express();
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  port = (server.address() as AddressInfo).port;
  app.use(hostGuard(port));
  const api = express.Router();
  api.use(apiGuard(token));
  api.get("/snapshot", (_request, response) => response.json({ ok: true }));
  api.post("/edits/apply", (_request, response) => response.json({ ok: true }));
  app.use("/api", api);
});
after(() => server.close());

function call(options: { method?: string; path: string; headers?: Record<string, string> }): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, method: options.method ?? "GET", path: options.path, headers: { host: `127.0.0.1:${port}`, ...options.headers } },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on("error", reject);
    request.end();
  });
}

test("a request naming another host is refused, whatever it carries", async () => {
  assert.equal(await call({ path: "/api/snapshot", headers: { host: "attacker.example", "x-studio-token": token } }), 421);
  assert.equal(await call({ path: "/api/snapshot", headers: { host: `localhost:${port}`, "x-studio-token": token } }), 200);
});

test("the API needs the token", async () => {
  assert.equal(await call({ path: "/api/snapshot" }), 401);
  assert.equal(await call({ path: "/api/snapshot", headers: { "x-studio-token": "b".repeat(48) } }), 401);
  assert.equal(await call({ path: "/api/snapshot", headers: { "x-studio-token": "é".repeat(48) } }), 401);
  assert.equal(await call({ path: "/api/snapshot", headers: { "x-studio-token": token } }), 200);
});

test("a change needs the token and the studio's own origin", async () => {
  const headers = { "x-studio-token": token };
  assert.equal(await call({ method: "POST", path: "/api/edits/apply", headers }), 403);
  assert.equal(await call({ method: "POST", path: "/api/edits/apply", headers: { ...headers, origin: "http://attacker.example" } }), 403);
  assert.equal(await call({ method: "POST", path: "/api/edits/apply", headers: { ...headers, origin: `http://127.0.0.1:${port}` } }), 200);
});

test("only framework.config.ts and framework-config/*.ts are writable", () => {
  const repositoryRoot = path.resolve(__dirname, "..", "..");
  assert.ok(assertWritable(repositoryRoot, "framework-config/workloads/services.ts").endsWith("services.ts"));
  assert.ok(assertWritable(repositoryRoot, "framework.config.ts").endsWith("framework.config.ts"));
  for (const file of ["cdk-app/.env", "package.json", "framework-config/../package.json", "cdk-app/bin/cdk-app.ts", "framework-config/missing.ts"]) {
    assert.throws(() => assertWritable(repositoryRoot, file), Error, file);
  }
});

test("edit requests retain boolean and numeric values and reject structured values", () => {
  for (const value of [false, true, 14, "arm64"]) {
    assert.equal(readIntent({ intent: { target: "lambda:graphql-api", field: "lambda.bundling.minify", value } }).value, value);
  }
  for (const value of [null, undefined, {}, []]) {
    assert.throws(() => readIntent({ intent: { target: "lambda:graphql-api", field: "lambda.bundling.minify", value } }), /string, number or boolean/);
  }
});

test("configuration modules cannot use a symlink parent to widen write authority", () => {
  const root = mkdtempSync(path.join(tmpdir(), "studio-authority-"));
  try {
    mkdirSync(path.join(root, "framework-config"));
    mkdirSync(path.join(root, "cdk-app"));
    writeFileSync(path.join(root, "cdk-app/native.ts"), "// source-owned CDK\n");
    symlinkSync(path.join(root, "cdk-app"), path.join(root, "framework-config/linked"));
    assert.throws(() => assertWritable(root, "framework-config/linked/native.ts"), /symbolic link/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
