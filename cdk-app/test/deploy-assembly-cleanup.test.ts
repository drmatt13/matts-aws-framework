import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(__dirname, "../..");
const artifacts = path.join(root, ".framework", "artifacts");

// A copy of the deploy script beside the real framework config, with an app
// whose synthesis fails, so the run stops before identity checks or AWS calls.
type Deploy = (...args: string[]) => ReturnType<typeof spawnSync>;
type DeployWith = (env: NodeJS.ProcessEnv, ...args: string[]) => ReturnType<typeof spawnSync>;
function withDeployFixture(body: (fixture: string, deploy: Deploy, deployWith: DeployWith) => void): void {
  mkdirSync(artifacts, { recursive: true });
  const fixture = mkdtempSync(path.join(artifacts, "deploy-assembly-"));
  try {
    mkdirSync(path.join(fixture, "scripts"));
    mkdirSync(path.join(fixture, "cdk-app"));
    // Every script, so the copy keeps working as deploy.ts gains helpers.
    for (const name of readdirSync(path.join(root, "scripts")).filter((entry) => /\.(ts|mjs)$/.test(entry))) {
      copyFileSync(path.join(root, "scripts", name), path.join(fixture, "scripts", name));
    }
    writeFileSync(path.join(fixture, "framework.config.ts"), `export { default } from "../../../framework.config";\n`);
    writeFileSync(path.join(fixture, "failing-app.js"), "console.error(`app-profile=${process.env.AWS_PROFILE}`);\nprocess.exit(3);\n");
    const app = `node "${path.join(fixture, "failing-app.js")}"`;
    const deployWith: DeployWith = (env, ...args) => spawnSync(process.execPath, ["--import", "tsx", path.join(fixture, "scripts", "deploy.ts"), "--all", "--no-notices", "--app", app, ...args], {
      cwd: root, encoding: "utf8", timeout: 60_000, env: { ...process.env, ...env },
    });
    body(fixture, (...args) => deployWith({}, ...args), deployWith);
  } finally {
    assert.ok(path.resolve(fixture).startsWith(path.resolve(artifacts) + path.sep));
    rmSync(fixture, { recursive: true, force: true });
  }
}

test("deploy removes the temporary assembly it synthesized into", () => {
  withDeployFixture((fixture, deploy) => {
    const result = deploy();
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(`${result.stdout}${result.stderr}`, /Deployment tooling exited with status/);
    assert.deepEqual(readdirSync(path.join(fixture, ".cache", "deploy")), []);
  });
});

test("deploy keeps an assembly directory named with --output", () => {
  withDeployFixture((fixture, deploy) => {
    mkdirSync(path.join(fixture, "cdk-app", "kept"));
    writeFileSync(path.join(fixture, "cdk-app", "kept", "keep.txt"), "caller-owned\n");
    const result = deploy("--output", "kept");
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.equal(existsSync(path.join(fixture, "cdk-app", "kept", "keep.txt")), true);
  });
});

test("deploy sweeps assemblies an interrupted run left behind", () => {
  withDeployFixture((fixture, deploy) => {
    const cache = path.join(fixture, ".cache", "deploy");
    mkdirSync(path.join(cache, "assembly-stale"), { recursive: true });
    mkdirSync(path.join(cache, "assembly-recent"));
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(path.join(cache, "assembly-stale"), twoDaysAgo, twoDaysAgo);
    const result = deploy();
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.deepEqual(readdirSync(cache), ["assembly-recent"]);
  });
});

test("deploy reads its authored inputs from FRAMEWORK_INPUTS_FILE when set", () => {
  withDeployFixture((fixture, _deploy, deployWith) => {
    const inputs = path.join(fixture, "inputs.env");
    writeFileSync(inputs, "AWS_PROFILE=fixture-profile-from-inputs\n");
    const result = deployWith({ FRAMEWORK_INPUTS_FILE: inputs, AWS_PROFILE: undefined });
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(`${result.stdout}${result.stderr}`, /app-profile=fixture-profile-from-inputs/);
  });
});
