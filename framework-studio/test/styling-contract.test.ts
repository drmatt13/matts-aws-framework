import assert from "./support/assert";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

async function files(directory: string): Promise<string[]> {
  return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat();
}

test("production styles have four explicit owners and no legacy feature imports", async () => {
  const source = await files("src");
  assert.deepEqual(source.filter(file => file.endsWith(".css")).map(file => file.replaceAll(path.sep, "/")).sort(), [
    "src/styles.css", "src/styles/base.css", "src/styles/codemirror.css", "src/styles/theme.css",
  ]);
  const entry = await readFile("src/styles.css", "utf8");
  assert.ok(entry.includes('source(none)'));
  assert.ok(entry.includes('@source "./"'));
  assert.ok(entry.includes('@source "../index.html"'));
  assert.ok(!/\blegacy\b|tailwindcss\/preflight|@apply/.test(entry));
  for (const file of source.filter(file => /\.[cm]?[jt]sx?$/.test(file))) {
    const content = await readFile(file, "utf8");
    for (const match of content.matchAll(/import\s+["']([^"']+\.css)["']/g)) {
      const resolved = path.normalize(path.join(path.dirname(file), match[1]!)).replaceAll(path.sep, "/");
      assert.ok(resolved === "src/styles.css" && file === path.join("src", "main.tsx") || resolved === "src/styles/codemirror.css" && file === path.join("src", "views", "PrismaEditor.tsx"), `Unexpected stylesheet owner: ${file} imports ${match[1]}`);
    }
  }
});
