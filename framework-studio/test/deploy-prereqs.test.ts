import assert from "./support/assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { dependencyState, probeDocker, probePrerequisites } from "../server/deploy/prereqs";
import { npmCli, Tools, type CommandResult, type CommandSpec, type Runner } from "../server/deploy/process";

/**
 * What this machine can do, from each tool's own answers: the runner is
 * scripted, so every state (missing, stopped, running, stale) is exercised
 * without Docker or the AWS CLI installed.
 */

const root = path.resolve(__dirname, "..", "..");

function scripted(answers: Record<string, CommandResult>): Runner {
  return async (spec: CommandSpec) => {
    const key = spec.display;
    const match = Object.keys(answers).find((pattern) => key.startsWith(pattern));
    return match ? answers[match]! : { code: 1, stdout: "", stderr: `unscripted: ${key}` };
  };
}

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: "" });

test("a running engine reports its versions, context and the Desktop plugin", async () => {
  const docker = await probeDocker(new Tools(root, {}), scripted({
    "docker version": ok(JSON.stringify({ Client: { Version: "29.0.1" }, Server: { Version: "29.0.1", Os: "linux", Platform: { Name: "Docker Desktop 4.50.0" } } })),
    "docker context show": ok("desktop-linux\n"),
    "docker compose version": ok("5.1.0\n"),
    "docker compose watch --help": ok("Usage: docker compose watch\n      --no-up     Do not build & start services before watching\n"),
    "docker desktop version": ok("Docker Desktop 4.50.0\n"),
  }), {});
  assert.deepEqual([docker.engine, docker.serverVersion, docker.platform, docker.context, docker.composeVersion, docker.desktop], ["running", "29.0.1", "Docker Desktop 4.50.0", "desktop-linux", "5.1.0", true]);
});

test("a stopped engine is told apart from a missing one", async () => {
  const stopped = await probeDocker(new Tools(root, {}), scripted({
    "docker version": { code: 1, stdout: JSON.stringify({ Client: { Version: "29.0.1" }, Server: null }), stderr: "error during connect: Get \"http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.51/version\": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified." },
    "docker context show": ok("desktop-linux\n"),
    "docker compose version": ok("5.1.0\n"),
    "docker compose watch --help": ok("--no-up"),
    "docker desktop version": ok("Docker Desktop 4.50.0\n"),
  }), {});
  assert.equal(stopped.engine, "stopped");
  assert.equal(stopped.desktop, true);
  const missing = await probeDocker(new Tools(root, {}), async () => ({ code: null, stdout: "", stderr: "spawn docker ENOENT", missing: true }), {});
  assert.equal(missing.engine, "missing");
  assert.equal(missing.desktop, false);
});

test("prerequisites say what is wrong and offer the operation that fixes it", async () => {
  const { prerequisites } = await probePrerequisites(new Tools(root, {}), scripted({
    "npm --version": ok("10.9.2\n"),
    "aws --version": { code: null, stdout: "", stderr: "spawn aws ENOENT", missing: true },
    "docker version": { code: 1, stdout: JSON.stringify({ Client: {}, Server: null }), stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" },
    "docker context show": ok("default\n"),
    "docker compose version": ok("v2.20.0\n"),
    "docker compose watch --help": ok("Usage: docker compose watch\n"),
    "docker desktop version": ok("Docker Desktop 4.50.0\n"),
  }), {}, root);
  const byId = Object.fromEntries(prerequisites.map((item) => [item.id, item]));
  assert.equal(byId.node!.status, "ok");
  assert.equal(byId.npm!.status, "warn");
  assert.match(byId.npm!.summary, /npm 10/);
  assert.equal(byId["aws-cli"]!.status, "fail");
  assert.match(byId["aws-cli"]!.detail ?? "", /AWS CLI v2/);
  assert.equal(byId.docker!.status, "warn");
  assert.deepEqual(byId.docker!.remedy, { kind: "docker-start", params: {} });
  assert.equal(byId.compose!.status, "warn", "a Compose without watch --no-up cannot be watched separately");
});

test("npm is found beside Node in each install layout, including Homebrew's linked bin/npm", { skip: process.platform === "win32" ? "symlinked layouts are POSIX" : false }, () => {
  mkdirSync(path.join(root, ".cache"), { recursive: true });
  const directory = mkdtempSync(path.join(root, ".cache", "studio-npm-"));
  try {
    const place = (file: string) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, ""); return file; };
    // Node's own distribution: lib/node_modules/npm beside bin/node.
    const official = place(path.join(directory, "official", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
    assert.equal(path.resolve(npmCli({}, path.join(directory, "official", "bin", "node"))!), official);
    // Homebrew: the Node keg holds node and a bin/npm link to npm installed elsewhere.
    const linked = place(path.join(directory, "homebrew", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
    mkdirSync(path.join(directory, "homebrew", "Cellar", "node", "bin"), { recursive: true });
    symlinkSync(linked, path.join(directory, "homebrew", "Cellar", "node", "bin", "npm"));
    assert.equal(npmCli({}, path.join(directory, "homebrew", "Cellar", "node", "bin", "node")), realpathSync(linked));
    // Nothing anywhere: not found, rather than a guess.
    assert.equal(npmCli({}, path.join(directory, "bare", "bin", "node")), undefined);
    // npm running Studio names itself.
    assert.equal(npmCli({ npm_execpath: linked }, path.join(directory, "bare", "bin", "node")), linked);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a simulated AWS CLI is reported as such", async () => {
  const { prerequisites } = await probePrerequisites(new Tools(root, { FRAMEWORK_AWS_CLI: "fake-aws.mjs" }), scripted({ "npm --version": ok("11.6.0\n") }), { FRAMEWORK_AWS_CLI: "fake-aws.mjs" }, root);
  const aws = prerequisites.find((item) => item.id === "aws-cli")!;
  assert.equal(aws.status, "ok");
  assert.match(aws.summary, /simulated/);
});

test("dependencies are stale when the lockfile or a manifest changed after the last install", () => {
  mkdirSync(path.join(root, ".cache"), { recursive: true });
  const directory = mkdtempSync(path.join(root, ".cache", "studio-deps-"));
  try {
    assert.equal(dependencyState(directory).status, "fail", "never installed");
    writeFileSync(path.join(directory, "package.json"), JSON.stringify({ workspaces: ["packages/*", "client-app"] }));
    mkdirSync(path.join(directory, "packages", "framework"), { recursive: true });
    writeFileSync(path.join(directory, "packages", "framework", "package.json"), "{}");
    mkdirSync(path.join(directory, "client-app"));
    writeFileSync(path.join(directory, "client-app", "package.json"), "{}");
    writeFileSync(path.join(directory, "package-lock.json"), "{}");
    mkdirSync(path.join(directory, "node_modules"));
    writeFileSync(path.join(directory, "node_modules", ".package-lock.json"), "{}");
    const installed = new Date("2026-10-17T10:00:00Z");
    for (const file of ["package.json", "package-lock.json", "packages/framework/package.json", "client-app/package.json"]) utimesSync(path.join(directory, file), new Date("2026-10-17T09:00:00Z"), new Date("2026-10-17T09:00:00Z"));
    utimesSync(path.join(directory, "node_modules", ".package-lock.json"), installed, installed);
    assert.equal(dependencyState(directory).status, "ok");
    const later = new Date("2026-10-17T11:00:00Z");
    utimesSync(path.join(directory, "packages", "framework", "package.json"), later, later);
    const stale = dependencyState(directory);
    assert.equal(stale.status, "warn");
    assert.match(stale.summary, /packages\/framework\/package\.json changed after the last install/);
    assert.deepEqual(stale.remedy, { kind: "deps-install", params: {} });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
