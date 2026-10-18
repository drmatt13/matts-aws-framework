import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * npm run dev:containers, with a simulated Docker: --detach starts the stack in
 * the background (what Studio's Start development runs), from the repository
 * root whatever the caller's directory, with the profile handed to Compose.
 */

const root = path.resolve(__dirname, "../..");
const FAKE_DOCKER = path.join(root, "framework-studio", "test", "support", "fake-docker.mjs");

function engine(state: Record<string, unknown>) {
  mkdirSync(path.join(root, ".cache"), { recursive: true });
  const directory = mkdtempSync(path.join(root, ".cache", "fake-docker-"));
  const statePath = path.join(directory, "state.json");
  writeFileSync(statePath, JSON.stringify({ engine: "running", desktop: true, compose: "5.1.0", services: [{ name: "postgres" }, { name: "seed-test-user", oneShot: true }], ...state }));
  const dev = (...args: string[]) => {
    const run = spawnSync(process.execPath, [path.join(root, "scripts", "dev.mjs"), ...args], {
      cwd: directory, encoding: "utf8", timeout: 180_000,
      env: { ...process.env, FRAMEWORK_DOCKER_CLI: FAKE_DOCKER, FAKE_DOCKER_STATE: statePath, AWS_PROFILE: "" },
    });
    return { status: run.status, output: `${run.stdout}${run.stderr}` };
  };
  const calls = () => readFileSync(`${statePath}.calls.jsonl`, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  return { dev, calls, read: () => JSON.parse(readFileSync(statePath, "utf8")), dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

test("--detach starts the stack in the background from the repository root, with the profile", () => {
  const docker = engine({});
  try {
    const result = docker.dev("--detach", "--profile", "dev");
    assert.equal(result.status, 0, result.output);
    const up = docker.calls().find((call: any) => call.args[0] === "compose" && call.args[1] === "up");
    assert.deepEqual(up.args, ["compose", "up", "--detach", "--build", "--remove-orphans"]);
    assert.equal(up.profile, "dev");
    assert.equal(path.resolve(up.cwd), root, "Compose runs where docker-compose.yml is");
    assert.ok(docker.read().containers.some((container: any) => container.Names.endsWith("postgres-1") && container.State === "running"));
  } finally { docker.dispose(); }
});

test("--detach fails, naming the engine, when Docker is not running", () => {
  const docker = engine({ engine: "stopped" });
  try {
    const result = docker.dev("--detach", "--profile", "dev");
    assert.notEqual(result.status, 0);
    assert.match(result.output, /dockerDesktopLinuxEngine|Docker/);
  } finally { docker.dispose(); }
});
