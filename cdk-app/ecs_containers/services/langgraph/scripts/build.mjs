import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  minify: true,
  sourcemap: true,
  platform: "node",
  target: "node24",
  format: "esm",
  treeShaking: true,
  legalComments: "none",
  tsconfig: "./tsconfig.json",
  // Bundled CommonJS dependencies (including parts of the AWS SDK) still call
  // require() at runtime. An ESM bundle has no `require` in scope, so esbuild's
  // interop shim throws "Dynamic require of \"fs\" is not supported" the moment
  // one of them loads. Defining `require` from import.meta.url gives them a
  // real one. Without this the image builds fine and then dies on startup.
  banner: {
    js: [
      `import { createRequire as __nodeCreateRequire } from "node:module";`,
      `import { fileURLToPath as __nodeFileURLToPath } from "node:url";`,
      `import { dirname as __nodeDirname } from "node:path";`,
      `const require = __nodeCreateRequire(import.meta.url);`,
      `const __filename = __nodeFileURLToPath(import.meta.url);`,
      `const __dirname = __nodeDirname(__filename);`,
    ].join("\n"),
  },
});
