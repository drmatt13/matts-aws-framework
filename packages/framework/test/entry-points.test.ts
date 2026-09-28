import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";

const packageRoot = resolve(__dirname, "..");
const entryPoints = [
  "invocation",
  "auth",
  "callbacks",
  "http",
  "database",
  "event-replay",
  "websocket",
] as const;

// Exercise package exports through the same bundler used by Lambda/service
// builds. Independent entry points must stay independent even without tree
// shaking; merely moving a shared barrel would bring its imports along.
for (const entryPoint of entryPoints) {
  test(`${entryPoint} resolves without unrelated runtime or configuration modules`, async () => {
    for (const format of ["cjs", "esm"] as const) {
      const result = await build({
        absWorkingDir: packageRoot,
        stdin: {
          contents: `export * from "@repo/framework/runtime/${entryPoint}";`,
          resolveDir: packageRoot,
          sourcefile: "consumer.ts",
          loader: "ts",
        },
        bundle: true,
        platform: "node",
        target: "node24",
        format,
        treeShaking: false,
        write: false,
        metafile: true,
        // Bundle workspace source, while leaving third-party runtime packages
        // external. This makes accidental cross-module imports visible.
        external: ["@aws-sdk/*", "@smithy/*", "cookie", "jose"],
      });
      const inputs = Object.keys(result.metafile.inputs).map((input) =>
        input.replaceAll("\\", "/"),
      );
      assert.ok(inputs.includes(`src/runtime/${entryPoint}.ts`), `${format}: export resolved`);
      for (const other of entryPoints.filter((entry) => entry !== entryPoint)) {
        assert.ok(!inputs.includes(`src/runtime/${other}.ts`), `${format}: unexpectedly loaded ${other}`);
      }
      assert.ok(
        !inputs.some((input) =>
          /framework\.config\.ts|framework-config\/|src\/(config|local)\//.test(input),
        ),
        `${format}: runtime imported configuration or local execution: ${inputs.join(", ")}`,
      );
    }
  });
}

test("configuration remains browser-safe without loading runtime or local execution", async () => {
  const result = await build({
    absWorkingDir: packageRoot,
    stdin: {
      contents: 'export * from "@repo/framework/config";',
      resolveDir: packageRoot,
      loader: "ts",
    },
    bundle: true,
    platform: "browser",
    format: "esm",
    treeShaking: false,
    write: false,
    metafile: true,
  });
  const inputs = Object.keys(result.metafile.inputs).map((input) => input.replaceAll("\\", "/"));
  assert.ok(inputs.includes("src/config/index.ts"));
  assert.ok(!inputs.some((input) => /src\/(runtime|local)\/|src\/config\/source\.ts|node_modules\//.test(input)));
});

test("local origins can be imported without loading the executor", async () => {
  const result = await build({
    absWorkingDir: packageRoot,
    stdin: {
      contents: 'export * from "@repo/framework/local/origins";',
      resolveDir: packageRoot,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    treeShaking: false,
    write: false,
    metafile: true,
  });
  const inputs = Object.keys(result.metafile.inputs).filter((input) => input !== "<stdin>");
  assert.deepEqual(inputs, ["src/local/origins.ts"]);
});

test("local execution resolves without importing the application inventory", async () => {
  const result = await build({
    absWorkingDir: packageRoot,
    stdin: {
      contents: 'export * from "@repo/framework/local";',
      resolveDir: packageRoot,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    treeShaking: false,
    write: false,
    metafile: true,
    external: ["@aws-sdk/*", "@smithy/*"],
  });
  const inputs = Object.keys(result.metafile.inputs).map((input) => input.replaceAll("\\", "/"));
  assert.ok(inputs.includes("src/local/index.ts"));
  assert.ok(inputs.includes("src/config/source.ts"));
  assert.ok(!inputs.some((input) => /framework\.config\.ts|framework-config\//.test(input)));
});
