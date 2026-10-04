import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { IgnoreStrategy } from "aws-cdk-lib";

// The repository root is the build context of every container image, so what
// .dockerignore lets through is uploaded to the account's asset bucket and
// baked into an image. Judged with CDK's own Docker ignore rules, the ones it
// stages image assets with.
const root = path.resolve(__dirname, "../..");
const patterns = readFileSync(path.join(root, ".dockerignore"), "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));
const strategy = IgnoreStrategy.docker(root, patterns);
const ignored = (relative: string) => strategy.ignores(path.join(root, relative));

test("research workspaces, caches, local state and secrets never enter an image context", () => {
  for (const relative of [
    ".superpowers/sdd/notes.md",
    ".claude/settings.local.json",
    ".cache/agentcore-redesign/verify.log",
    "packages/database/.cache/prisma/engine",
    "cdk-app/.cache/deploy/manifest.json",
    "cdk-app/.env",
    "cdk-app/.env.local",
    "cdk-app/cdk.out/manifest.json",
    "node_modules/zod/package.json",
    "client-app/dist/index.html",
    ".git/HEAD",
  ]) {
    assert.equal(ignored(relative), true, `${relative} must not reach a Docker build context`);
  }
});

test("the sources an image builds from still do", () => {
  for (const relative of ["package.json", "package-lock.json", "packages/framework/src/runtime/tools.ts", "framework.config.ts"]) {
    assert.equal(ignored(relative), false, `${relative} is needed in the build context`);
  }
});
