import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(__dirname, "../..");
const artifacts = path.join(root, ".framework", "artifacts");

// A copy of the deploy script beside the real framework config, with an app
// whose synthesis fails, so the run stops before identity checks or AWS calls.
function withDeployFixture(body: (fixture: string, deploy: (...args: string[]) => ReturnType<typeof spawnSync>) => void): void {
  mkdirSync(artifacts, { recursive: true });
  const fixture = mkdtempSync(path.join(artifacts, "deploy-assembly-"));
  try {
    mkdirSync(path.join(fixture, "scripts"));
    mkdirSync(path.join(fixture, "cdk-app"));
    for (const name of ["deploy.ts", "deployment-assembly.ts", "deployment-secrets.ts"]) {
      copyFileSync(path.join(root, "scripts", name), path.join(fixture, "scripts", name));
    }
    writeFileSync(path.join(fixture, "framework.config.ts"), `export { default } from "../../../framework.config";\n`);
    writeFileSync(path.join(fixture, "failing-app.js"), "process.exit(3);\n");
    const app = `node "${path.join(fixture, "failing-app.js")}"`;
    body(fixture, (...args) => spawnSync(process.execPath, ["--import", "tsx", path.join(fixture, "scripts", "deploy.ts"), "--all", "--no-notices", "--app", app, ...args], {
      cwd: root, encoding: "utf8", timeout: 60_000,
    }));
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
