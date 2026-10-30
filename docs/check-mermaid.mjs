#!/usr/bin/env node
// Documentation-only syntax checking. Dependencies live in a separate temporary
// npm project, never in this repository's dependency graph or lockfile.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const toolingDirectory = process.argv[2];
if (!toolingDirectory) {
  console.error("Usage: node docs/check-mermaid.mjs <temporary-tooling-directory>");
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireTool = createRequire(path.resolve(toolingDirectory, "package.json"));
const { JSDOM } = requireTool("jsdom");
const window = new JSDOM("<!doctype html><html><body></body></html>").window;
for (const key of ["window", "document", "DOMParser", "HTMLElement", "SVGElement"]) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: key === "window" ? window : window[key],
  });
}
const { default: mermaid } = await import(pathToFileURL(requireTool.resolve("mermaid")).href);
const { version } = JSON.parse(readFileSync(path.resolve(toolingDirectory, "node_modules/mermaid/package.json"), "utf8"));
mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });

const files = execFileSync("rg", ["--files", "-g", "*.md", "-g", "!node_modules", "-g", "!.git"], {
  cwd: root,
  encoding: "utf8",
}).trim().split("\n").filter(Boolean);
let count = 0;
let failures = 0;
try {
  // A rejected control proves this invocation is actually checking syntax.
  let rejectedControl = false;
  try { await mermaid.parse("flowchart TD\n  a[unterminated"); }
  catch { rejectedControl = true; }
  if (!rejectedControl) throw new Error("Mermaid accepted an intentionally invalid control diagram.");

  for (const file of files) {
    const markdown = readFileSync(path.join(root, file), "utf8");
    for (const block of markdown.matchAll(/^```mermaid\s*\n([\s\S]*?)^```\s*$/gm)) {
      count++;
      const line = markdown.slice(0, block.index).split("\n").length;
      try {
        const result = await mermaid.parse(block[1]);
        console.log(`PASS ${file}:${line} ${result.diagramType}`);
      } catch (error) {
        failures++;
        console.error(`FAIL ${file}:${line}\n${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (!count) throw new Error("No Mermaid fences found; confirm the scan scope before claiming validation.");
  console.log(`Mermaid ${version}: ${count - failures}/${count} parsed; ${files.length} Markdown files scanned; invalid control rejected.`);
  process.exitCode = failures ? 1 : 0;
} finally {
  window.close();
}
