#!/usr/bin/env node
// Restricted frontmatter + ordinary Markdown links; no dependencies or network.
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ownFile = fileURLToPath(import.meta.url);
const listKeys = new Set(["read_when", "source", "related"]);
const scalarKeys = new Set(["id", "summary"]);
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const read = (file) => readFileSync(file, "utf8").replaceAll("\r\n", "\n");

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(file);
    return entry.isFile() && entry.name.endsWith(".md") ? [file] : [];
  });
}

function frontmatter(text, report) {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (!match) { report("missing frontmatter"); return { meta: {}, body: text }; }
  const meta = {};
  let current;
  for (const line of match[1].split("\n")) {
    if (!line.trim()) continue;
    const key = /^([a-z_]+):(?: (.*))?$/.exec(line);
    if (key) {
      current = key[1];
      if (!listKeys.has(current) && !scalarKeys.has(current)) report(`unknown metadata key ${current}`);
      if (Object.hasOwn(meta, current)) report(`duplicate metadata key ${current}`);
      if (listKeys.has(current)) {
        if (key[2]) report(`${current} must use indented list items`);
        meta[current] = [];
      } else meta[current] = key[2] ?? "";
    } else {
      const item = /^  - (\S.*)$/.exec(line);
      if (!item || !listKeys.has(current) || !Array.isArray(meta[current])) report("unsupported frontmatter syntax");
      else meta[current].push(item[1]);
    }
  }
  for (const key of scalarKeys) if (typeof meta[key] !== "string" || !meta[key].trim()) report(`missing metadata ${key}`);
  for (const key of listKeys) if (!Array.isArray(meta[key]) || !meta[key].length) report(`missing metadata list ${key}`);
  if (typeof meta.id === "string" && !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(meta.id)) report("invalid document id");
  return { meta, body: text.slice(match[0].length) };
}

function withoutFences(text) {
  let fence;
  return text.split("\n").map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence && marker) { fence = marker[1]; return ""; }
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return "";
    }
    return line;
  }).join("\n");
}

function links(text, report) {
  const definitions = new Map();
  const normalize = (name) => name.trim().replace(/\s+/g, " ").toLowerCase();
  const body = withoutFences(text).replace(/^ {0,3}\[([^\]\n]+)\]:\s*(?:<([^>\n]+)>|(\S+)).*$/gm, (_all, name, angle, plain) => {
    definitions.set(normalize(name), angle ?? plain);
    return "";
  });
  const found = [];
  for (const match of body.matchAll(/!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g)) found.push(match[1] ?? match[2]);
  for (const match of body.matchAll(/!?\[([^\]\n]+)\]\[([^\]\n]*)\]/g)) {
    const key = normalize(match[2] || match[1]);
    if (!definitions.has(key)) report(`undefined Markdown reference ${key}`);
    else found.push(definitions.get(key));
  }
  for (const match of body.matchAll(/(?<!!)\[([^\]\n]+)\](?![\[(])/g)) {
    const target = definitions.get(normalize(match[1]));
    if (target) found.push(target);
  }
  return found;
}

function headingIds(text) {
  const used = new Set();
  for (const match of withoutFences(text).matchAll(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/gm)) {
    const base = match[1].replace(/<[^>]*>/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[`*_~]/g, "").toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, "").replace(/\s/g, "-");
    let slug = base;
    for (let number = 1; used.has(slug); number++) slug = `${base}-${number}`;
    used.add(slug);
  }
  for (const match of text.matchAll(/<(?:a|h[1-6])\b[^>]*(?:id|name)=["']([^"']+)["']/gi)) used.add(match[1]);
  return used;
}

export function validateWiki(root, directory) {
  root = path.resolve(root);
  directory = path.resolve(directory);
  const errors = [];
  const documents = new Map();
  const ids = new Map();
  const rootReal = realpathSync(root);
  const stats = { markdownFiles: 0, bytes: 0, localLinks: 0, sourcePaths: 0, reachable: 0 };
  const label = (file) => path.relative(root, file).split(path.sep).join("/");
  const report = (file, message) => errors.push(`${label(file)}: ${message}`);
  const resolveFile = (from, target) => {
    const file = path.resolve(from, target);
    if (!inside(root, file)) return { problem: `path leaves repository: ${target}` };
    if (!existsSync(file)) return { problem: `missing path: ${target}` };
    if (!inside(rootReal, realpathSync(file))) return { problem: `symlink leaves repository: ${target}` };
    return { file };
  };
  for (const file of markdownFiles(directory)) {
    const text = read(file);
    const parsed = frontmatter(text, (message) => report(file, message));
    const doc = { ...parsed, links: new Set() };
    documents.set(file, doc);
    stats.markdownFiles++;
    stats.bytes += Buffer.byteLength(text);
    if (doc.meta.id) {
      if (ids.has(doc.meta.id)) report(file, `duplicate document id ${doc.meta.id} (also ${label(ids.get(doc.meta.id))})`);
      else ids.set(doc.meta.id, file);
    }
    for (const source of doc.meta.source ?? []) {
      stats.sourcePaths++;
      const result = resolveFile(root, source);
      if (result.problem) report(file, `source ${result.problem}`);
    }
  }
  const anchors = new Map();
  for (const [file, doc] of documents) {
    for (const id of doc.meta.related ?? []) {
      if (!ids.has(id)) report(file, `unknown related id ${id}`);
      if (id === doc.meta.id) report(file, `related id points to itself: ${id}`);
    }
    for (const raw of links(doc.body, (message) => report(file, message))) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) continue;
      let target;
      try { target = decodeURIComponent(raw); }
      catch { report(file, `invalid encoded link ${raw}`); continue; }
      const hash = target.indexOf("#");
      const fragment = hash < 0 ? "" : target.slice(hash + 1);
      const pathname = (hash < 0 ? target : target.slice(0, hash)).split("?")[0];
      const result = pathname ? resolveFile(path.dirname(file), pathname) : { file };
      stats.localLinks++;
      if (result.problem) { report(file, `link ${result.problem}`); continue; }
      const destination = result.file;
      doc.links.add(destination);
      if (fragment && destination.endsWith(".md") && lstatSync(destination).isFile()) {
        if (!anchors.has(destination)) anchors.set(destination, headingIds(documents.get(destination)?.body ?? read(destination)));
        if (!anchors.get(destination).has(fragment)) report(file, `missing heading #${fragment} in ${label(destination)}`);
      }
    }
  }
  const entry = path.join(directory, "README.md");
  const visited = new Set();
  const queue = [entry];
  if (!documents.has(entry)) errors.push("missing root README.md");
  while (queue.length) {
    const file = queue.pop();
    if (visited.has(file) || !documents.has(file)) continue;
    visited.add(file);
    queue.push(...documents.get(file).links);
  }
  stats.reachable = visited.size;
  for (const file of documents.keys()) if (!visited.has(file)) report(file, "orphaned document: unreachable from root README.md");
  return { errors, stats };
}

function selfTest() {
  const root = mkdtempSync(path.join(tmpdir(), "aws-studio-knowledge-"));
  const directory = path.join(root, "docs", "wiki");
  const header = (id, related) => `---\nid: ${id}\nsummary: Fixture.\nread_when:\n  - Testing\nsource:\n  - src/entry.ts\nrelated:\n  - ${related}\n---\n`;
  const rootText = header("doc.root", "doc.leaf") + "# Router\n\n[Leaf](leaf.md#contract)\n\n[Source](../../src/entry.ts)\n\n```md\n[Ignored](missing.md)\n```\n";
  const leafText = header("doc.leaf", "doc.root") + "# Contract\n\n[Router](README.md)\n";
  const write = (name, text) => writeFileSync(path.join(directory, name), text);
  const check = () => validateWiki(root, directory);
  let count = 0;
  try {
    mkdirSync(path.join(root, "src"), { recursive: true });
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(root, "src", "entry.ts"), "// fixture\n");
    const reset = () => { for (const entry of readdirSync(directory)) rmSync(path.join(directory, entry), { recursive: true }); write("README.md", rootText); write("leaf.md", leafText); };
    const expect = (name, mutate, error) => {
      reset(); mutate();
      const { errors } = check();
      if (error) assert.ok(errors.some((message) => message.includes(error)), `${name}: expected ${error}; got ${errors.join("; ")}`);
      else assert.deepEqual(errors, [], name);
      count++;
    };
    expect("valid links, anchors, source and fenced example", () => {});
    expect("broken link", () => write("README.md", rootText.replace("leaf.md#contract", "missing.md")), "link missing path");
    expect("broken anchor", () => write("README.md", rootText.replace("#contract", "#missing")), "missing heading");
    expect("stale source", () => write("leaf.md", leafText.replace("src/entry.ts", "src/gone.ts")), "source missing path");
    expect("duplicate id", () => write("leaf.md", leafText.replace("id: doc.leaf", "id: doc.root")), "duplicate document id");
    expect("unknown graph id", () => write("leaf.md", leafText.replace("  - doc.root", "  - doc.missing")), "unknown related id");
    expect("orphan", () => write("orphan.md", header("doc.orphan", "doc.root") + "# Orphan\n[Router](README.md)\n"), "orphaned document");
    expect("missing schema", () => write("leaf.md", "# Contract\n"), "missing frontmatter");
    expect("path containment", () => write("README.md", rootText + "\n[Outside](../../../outside.md)\n"), "path leaves repository");
    expect("valid reference link", () => write("README.md", rootText.replace("[Leaf](leaf.md#contract)", "[Leaf][target]\n\n[target]: leaf.md#contract")));
    expect("undefined reference", () => write("README.md", rootText + "\n[Leaf][unknown]\n"), "undefined Markdown reference");
  } finally { rmSync(root, { recursive: true, force: true }); }
  console.log(`Knowledge checker: ${count} regression fixtures passed.`);
}

if (path.resolve(process.argv[1] ?? "") === ownFile) {
  if (process.argv.includes("--self-test")) selfTest();
  else {
    const directory = path.dirname(ownFile);
    const { errors, stats } = validateWiki(path.resolve(directory, "../.."), directory);
    if (errors.length) { for (const error of errors) console.error(error); process.exitCode = 1; }
    else console.log(`Knowledge check passed: ${stats.markdownFiles} Markdown files, ${stats.localLinks} local links, ${stats.sourcePaths} source references, ${stats.reachable} reachable pages, ${Math.round(stats.bytes / 1024)} KiB.`);
  }
}
