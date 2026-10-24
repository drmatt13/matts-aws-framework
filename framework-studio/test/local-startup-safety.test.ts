import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { LocalEnvironment } from "../server/deploy/local";
import { Tools } from "../server/deploy/process";

test("default Compose startup verifies storage and cannot reach profiled data or identity writers", () => {
  const config = parse(readFileSync(path.resolve(__dirname, "../../docker-compose.yml"), "utf8"), { merge: true });
  const services = config.services as Record<string, { profiles?: string[]; depends_on?: Record<string, unknown>; command?: string[] }>;
  assert.ok(services["prisma-verify"]!.command!.includes("db:verify"));
  for (const name of ["prisma-migrate", "prune-cognito-orphans", "seed-test-user"]) assert.ok(services[name]!.profiles?.length, name);
  for (const [name, service] of Object.entries(services).filter(([, service]) => !service.profiles?.length)) {
    for (const dependency of Object.keys(service.depends_on ?? {})) assert.ok(!services[dependency]?.profiles?.length, `${name} depends on a data writer: ${dependency}`);
  }
  assert.ok(!services["seed-test-user"]!.depends_on?.["prune-cognito-orphans"], "test identity setup never implicitly prunes application data");
});

test("readiness distinguishes process start, database failure and a reachable application", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "studio-local-readiness-"));
  mkdirSync(path.join(root, "cdk-app"));
  const server = createServer((_request, response) => response.end("fixture client"));
  server.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  writeFileSync(path.join(root, "cdk-app/.env.dev"), `LOCAL_DEV_URL=${url}\n`);
  const env = { ...process.env };
  const disabledServices = new Set<string>();
  const local = new LocalEnvironment(root, new Tools(path.resolve(__dirname, "../.."), env), async () => ({ code: 0, stdout: "", stderr: "" }), env, root, path.join(root, "state"), () => disabledServices);
  const managed = { watch: { running: true }, client: { running: true } };
  try {
    assert.equal((await local.readiness([], managed)).state, "starting");
    assert.equal((await local.readiness([{ name: "prisma-verify", container: "check", state: "exited", oneShot: true, ports: "", exitCode: 1 }], managed)).state, "blocked");
    const service = { name: "api", container: "api", state: "running", oneShot: false, ports: "", health: "starting" as const };
    assert.equal((await local.readiness([service], managed)).state, "starting");
    assert.equal((await local.readiness([{ ...service, health: "healthy" }], managed)).state, "ready");
    const optional = { name: "conditional-service", container: "optional", state: "exited", oneShot: false, ports: "", exitCode: 0 };
    disabledServices.add(optional.name);
    assert.equal((await local.readiness([{ ...service, health: "healthy" }, optional], managed)).state, "ready", "a disabled service's clean launcher exit is intentional");
    assert.equal((await local.readiness([{ ...service, health: "healthy" }, { ...optional, exitCode: 1 }], managed)).state, "blocked", "a genuine failed startup still blocks readiness");
    disabledServices.clear();
    assert.equal((await local.readiness([{ ...service, health: "healthy" }, optional], managed)).state, "blocked", "an enabled service exiting still needs attention");
    assert.equal((await local.readiness([], { watch: { running: false }, client: { running: false } })).state, "stopped");
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});
