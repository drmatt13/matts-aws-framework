import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("deploy reports both conflicting route owners before synth or secret synchronization", () => {
  const root = path.resolve(__dirname, "../..");
  const artifacts = path.join(root, ".framework", "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const fixture = mkdtempSync(path.join(artifacts, "agent-route-preflight-"));
  try {
    mkdirSync(path.join(fixture, "scripts"));
    for (const name of ["deploy.ts", "deployment-assembly.ts", "deployment-secrets.ts"]) {
      copyFileSync(path.join(root, "scripts", name), path.join(fixture, "scripts", name));
    }
    writeFileSync(path.join(fixture, "framework.config.ts"), `
import { defineFrameworkConfig } from "@repo/framework/config";
import { defaults } from "../../../framework-config/defaults";
export default defineFrameworkConfig({
  defaults, webSocket: [], events: [], services: [],
  http: [{ "/duplicate": { directory: "/lambda_functions/http_functions/report", methods: ["GET"] } }],
  agents: [{ support: { auth: true, route: "/api/duplicate", environment: { USER_POOL_ID: "us-east-1_pool", USER_POOL_CLIENT_ID: "client" } } }],
});
`);
    const result = spawnSync(process.execPath, ["--import", "tsx", path.join(fixture, "scripts", "deploy.ts"), "--all"], {
      cwd: root, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    const output = result.stdout + result.stderr;
    assert.match(output, /Browser route collision: agents\["support"\]\.route.*http\["\/duplicate"\]/);
    assert.doesNotMatch(output, /\n\s+at /, "declaration failures print a useful message without a stack trace");
    assert.equal(existsSync(path.join(fixture, ".cache", "deploy")), false, "deployment assembly preparation never starts");
  } finally {
    assert.ok(path.resolve(fixture).startsWith(path.resolve(artifacts) + path.sep));
    rmSync(fixture, { recursive: true, force: true });
  }
});
