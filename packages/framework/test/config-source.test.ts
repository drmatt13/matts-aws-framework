import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  locateConfigSource,
  readSectionKeys,
  type ConfigSourceHost,
} from "../scripts/config-source";

/**
 * Where each declaration was written, read the same way its keys are.
 *
 * The locator is the key reader with positions kept: it follows the same
 * composition, refuses the same shapes with the same messages, and answers
 * with spans a tool can point at — which is what lets an editor or a
 * diagnostic name a line instead of a section key.
 */

const repositoryRoot = path.resolve(__dirname, "..", "..", "..");
const configFile = path.join(repositoryRoot, "framework.config.ts");

function slice(file: string, span: { readonly start: number; readonly end: number }): string {
  return readFileSync(file, "utf8").slice(span.start, span.end);
}

function memoryHost(files: Record<string, string>): ConfigSourceHost {
  const absolute = new Map(
    Object.entries(files).map(([name, text]) => [path.resolve("/repo", name), text]),
  );
  return {
    readFile: (file) => {
      const text = absolute.get(path.resolve(file));
      if (text === undefined) throw new Error(`no fixture ${file}`);
      return text;
    },
    exists: (file) => absolute.has(path.resolve(file)),
  };
}

test("every key the reader finds is located, in the same order", () => {
  const keys = readSectionKeys(configFile, { repositoryRoot });
  const located = locateConfigSource(configFile, { repositoryRoot });
  for (const [section, sectionKeys] of Object.entries(keys)) {
    const entries = located.sections[section as keyof typeof keys];
    assert.deepEqual(entries.map((entry) => entry.key), sectionKeys, section);
  }
});

test("an entry's spans point at its key and its declaration in the module that wrote it", () => {
  const { sections } = locateConfigSource(configFile, { repositoryRoot });
  const graphql = sections.http.find((entry) => entry.key === "/graphql");
  assert.ok(graphql);
  assert.equal(
    path.relative(repositoryRoot, graphql.file).replaceAll("\\", "/"),
    "framework-config/http/graphql.ts",
  );
  assert.equal(slice(graphql.file, graphql.keySpan), '"/graphql"');
  assert.match(slice(graphql.file, graphql.valueSpan), /^\{\s*directory: "\/lambda_functions\/http_functions\/graphql-api"/);

  for (const entries of Object.values(sections)) {
    for (const entry of entries) {
      const written = slice(entry.file, entry.keySpan).replace(/^["']|["']$/g, "");
      assert.equal(written, entry.key, `${entry.section}["${entry.key}"]`);
      assert.ok(entry.line >= 1 && entry.column >= 1);
    }
  }
});

test("workflow call spans are located in an isolated section module", () => {
  const host = memoryHost({
    "framework.config.ts": 'import { flows } from "./flows"; export default defineFrameworkConfig({ workflows: [flows] });',
    "flows.ts": 'export const flows = { process: workflow<{ message: string }>(() => succeed({}), { timeoutSeconds: 60 }) };',
  });
  const located = locateConfigSource(path.resolve("/repo/framework.config.ts"), { repositoryRoot: "/repo", host });
  const entry = located.sections.workflows[0]!;
  assert.equal(entry.key, "process");
  assert.match(host.readFile(entry.file).slice(entry.valueSpan.start, entry.valueSpan.end), /^workflow<\{ message: string \}>\(/);
});

test("the configuration's other properties resolve one hop, like the sections do", () => {
  const { properties } = locateConfigSource(configFile, { repositoryRoot });
  const relative = (file: string) => path.relative(repositoryRoot, file).replaceAll("\\", "/");

  assert.equal(relative(properties.defaults!.file), "framework-config/defaults.ts");
  assert.match(slice(properties.defaults!.file, properties.defaults!.span), /^\{/);
  assert.equal(relative(properties.network!.file), "framework-config/network.ts");
  assert.match(slice(properties.network!.file, properties.network!.span), /^defineNetwork\(\{/);
  assert.equal(relative(properties.resources!.file), "framework-config/resources.ts");
  assert.match(slice(properties.resources!.file, properties.resources!.span), /^defineResources\(\{/);
  assert.equal(relative(properties.database!.file), "framework.config.ts");
  assert.equal(slice(properties.database!.file, properties.database!.span), "resources.rds.database");
});

test("a spread array of modules is followed, and each entry keeps its own file", () => {
  const host = memoryHost({
    "framework.config.ts": `
import { a } from "./sections/a";
import { group } from "./sections/group";
export default defineFrameworkConfig({ defaults, http: [a, ...group] });
`,
    "sections/a.ts": `export const a = { "/one": { directory: "/one" } };`,
    "sections/group.ts": `
import { b } from "./b";
export const group = [b];
`,
    "sections/b.ts": `export const b = {
  // A comment above the entry.
  "/two": { directory: "/two" },
} satisfies HttpSection;`,
  });
  const located = locateConfigSource(path.resolve("/repo", "framework.config.ts"), {
    repositoryRoot: path.resolve("/repo"),
    host,
  });
  assert.deepEqual(
    located.sections.http.map((entry) => [entry.key, path.basename(entry.file), entry.moduleIndex]),
    [["/one", "a.ts", 0], ["/two", "b.ts", 1]],
  );
  const two = located.sections.http[1]!;
  assert.equal(two.line, 3);
  assert.equal(host.readFile(two.file).slice(two.valueSpan.start, two.valueSpan.end), '{ directory: "/two" }');
});

test("a refused shape is refused with the reader's own message", () => {
  const host = memoryHost({
    "framework.config.ts": `
import { a } from "./a";
import { b } from "./b";
export default defineFrameworkConfig({ http: [a, b] });
`,
    "a.ts": `export const a = { "/same": {} };`,
    "b.ts": `export const b = { "/same": {} };`,
  });
  const options = { repositoryRoot: path.resolve("/repo"), host };
  const file = path.resolve("/repo", "framework.config.ts");
  const message = (() => {
    try {
      readSectionKeys(file, options);
    } catch (error) {
      return (error as Error).message;
    }
    return "no error";
  })();
  assert.match(message, /http declares "\/same" in both a\.ts and b\.ts/);
  assert.throws(() => locateConfigSource(file, options), { message });
});
