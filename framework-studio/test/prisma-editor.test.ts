import assert from "./support/assert";
import { createRequire } from "node:module";
import { after, afterEach, before, test } from "node:test";
import { createElement as h, createRef } from "react";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import { StringStream } from "@codemirror/language";
import { format } from "@prisma/orm-framework/psl-parser/format";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { editorChange, type PrismaEditorHandle } from "../src/views/PrismaEditor";
import { prismaCompletions, prismaDefinition, prismaFold, prismaSymbols, prismaToken } from "../src/views/prisma-language";

const require = createRequire(import.meta.url);
let ui: typeof import("@testing-library/react");
let component: typeof import("../src/views/PrismaEditor");
let dom: { window: Window & typeof globalThis };

before(async () => {
  const { JSDOM } = require("jsdom");
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of ["window", "self", "document", "navigator", "Window", "HTMLElement", "Element", "Node", "Text", "MutationObserver", "DOMRect", "Range", "getComputedStyle"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: dom.window.requestAnimationFrame.bind(dom.window) });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: dom.window.cancelAnimationFrame.bind(dom.window) });
  dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
  ui = require("@testing-library/react");
  component = await import("../src/views/PrismaEditor");
});
afterEach(() => ui.cleanup());
after(() => dom.window.close());

const contract = `// use prisma-8
// Keep comments and physical names.
enum Role {
  MEMBER
  ADMIN
}
model User {
  id Uuid @id
  nickname String? @map("display_name") // keep this explanation
  joinedAt TimestamptzString(6) @default(now())
  role Role @default(MEMBER)
  @@map("users")
}
model Project {
  ownerId Uuid @map("owner_id")
  owner User @relation(fields: [ownerId], references: [id])
  slug String
  @@id([ownerId, slug], map: "projects_pkey")
}
`;

test("Prisma 8 lexical highlighting covers constructors, annotations and source comments", () => {
  const line = '  joinedAt temporal.timestamptzString(6, onCreate: now) @map("joined_at") // field';
  const stream = new StringStream(line, 2, 2);
  const state = { multilineString: false, afterAttribute: false, afterDeclaration: false, depth: 1 };
  const tokens: { text: string; style: string | null }[] = [];
  while (!stream.eol()) {
    stream.start = stream.pos;
    const style = prismaToken(stream, state);
    tokens.push({ text: line.slice(stream.start, stream.pos), style });
  }
  assert.deepEqual(tokens.filter(token => ["timestamptzString", "6", "map", '"joined_at"', "// field"].includes(token.text)), [
    { text: "timestamptzString", style: "functionName" },
    { text: "6", style: "number" }, { text: "map", style: "meta" },
    { text: '"joined_at"', style: "string" }, { text: "// field", style: "comment" },
  ]);
});

test("native parser reconstructs navigation for enum types, composite keys and owning relationships", () => {
  assert.equal(parse(contract, "contract.prisma").diagnostics.length, 0);
  assert.ok(prismaSymbols(contract).some(symbol => symbol.name === "Role"));
  const modelReference = contract.indexOf("owner User") + "owner ".length;
  assert.equal(prismaDefinition(contract, modelReference)?.name, "User");
  const fieldReference = contract.indexOf("[ownerId]") + 2;
  assert.equal(prismaDefinition(contract, fieldReference)?.from, contract.indexOf("ownerId Uuid"));
  const targetField = contract.indexOf("references: [id]") + "references: [".length;
  assert.equal(prismaDefinition(contract, targetField)?.from, contract.indexOf("id Uuid"));
  const enumReference = contract.indexOf("role Role") + 6;
  assert.equal(prismaDefinition(contract, enumReference)?.name, "Role");
  const unknown = contract + "\nmodel Unfinished {\n  draft String?\n";
  assert.ok(prismaSymbols(unknown).some(symbol => symbol.name === "draft"), "recovered invalid drafts remain navigable");
});

test("native formatter preserves comments, mappings and Prisma 8 constructor syntax", () => {
  const formatted = format(contract, { indent: 2 });
  assert.equal(parse(formatted, "contract.prisma").diagnostics.length, 0);
  for (const text of ['// Keep comments and physical names.', '@map("display_name")', '// keep this explanation', 'TimestamptzString(6)', '@@id([ownerId, slug], map: "projects_pkey")']) assert.ok(formatted.includes(text), text);
  assert.throws(() => format('model User { id String @id\n broken ???'), /parse errors/i);
});

test("completion names its syntax capability and does not insert into strings or comments", () => {
  const complete = (text: string) => prismaCompletions(new CompletionContext(EditorState.create({ doc: text }), text.length, true));
  assert.ok(complete("model User {\n  joinedAt Timest")?.options.some(option => option.label === "TimestamptzString"));
  assert.ok(complete("model User {\n  id Uuid @ma")?.options.some(option => option.label === "@map"));
  assert.equal(complete("// model User"), null);
  assert.equal(complete('model User {\n id Uuid @map("unfinished'), null);
  assert.ok(complete(`${contract}\nmodel Other {\n user Us`)?.options.some(option => option.label === "User"));
});

test("folding skips closing braces in strings and comments", () => {
  const text = 'model Example {\n  value String @default("}") // }\n}\n';
  const fold = prismaFold(text, 0, text.indexOf("\n"));
  assert.deepEqual(fold, { from: text.indexOf("{") + 1, to: text.lastIndexOf("}") });
  assert.equal(prismaFold(text, text.indexOf("  value"), text.indexOf("\n}")), null);
});

test("minimal document replacement preserves unchanged comments and mapped column text", () => {
  const next = contract.replace("nickname String?", "displayName String?");
  const change = editorChange(contract, next)!;
  assert.equal(contract.slice(0, change.from) + change.insert + contract.slice(change.to), next);
  assert.ok(!change.insert.includes("@map"));
  assert.equal(editorChange(contract, contract), null);
});

test("validation rerenders retain the editor, selection, invalid draft and undo history", async () => {
  const ref = createRef<PrismaEditorHandle>();
  const changes: string[] = [];
  const props = { ref, value: contract, onChange: (text: string) => changes.push(text) };
  const mounted = ui.render(h(component.PrismaEditor, props));
  const content = ui.screen.getByRole("textbox", { name: "Prisma schema source" });
  const offset = contract.indexOf("nickname");
  ui.act(() => ref.current!.replace(offset, offset + "nickname".length, "displayName"));
  const draft = changes.at(-1)!;
  ui.act(() => ref.current!.reveal(offset, offset + "displayName".length, false));
  mounted.rerender(h(component.PrismaEditor, { ...props, value: draft, diagnostics: [{ from: offset, to: offset + 3, severity: "error", message: "Example validation problem" }] }));
  assert.equal(ui.screen.getByRole("textbox", { name: "Prisma schema source" }), content);
  assert.deepEqual(ref.current!.getSelection(), { from: offset, to: offset + "displayName".length });
  ui.act(() => ref.current!.replace(draft.length, draft.length, "\nmodel Broken { ???"));
  const invalid = changes.at(-1)!;
  mounted.rerender(h(component.PrismaEditor, { ...props, value: invalid, diagnostics: [] }));
  assert.ok(content.textContent?.includes("model Broken { ???"));
  ui.act(() => ref.current!.undo());
  assert.equal(changes.at(-1), draft);
  ui.act(() => ref.current!.undo());
  assert.equal(changes.at(-1), contract);
  ui.act(() => ref.current!.redo());
  assert.equal(changes.at(-1), draft);
});

test("external draft changes do not echo onChange and formatting is one undoable action", () => {
  const ref = createRef<PrismaEditorHandle>();
  const changes: string[] = [];
  const props = { ref, value: contract, onChange: (text: string) => changes.push(text) };
  const mounted = ui.render(h(component.PrismaEditor, props));
  const external = contract.replace("nickname", "displayName");
  mounted.rerender(h(component.PrismaEditor, { ...props, value: external }));
  assert.equal(changes.length, 0);
  ui.act(() => ref.current!.replaceDocument(format(external)));
  assert.equal(changes.length, 1);
  ui.act(() => ref.current!.undo());
  assert.equal(changes.at(-1), external);
});

test("review and format shortcuts never write source and read-only sessions reject visual edits", () => {
  const ref = createRef<PrismaEditorHandle>();
  let reviews = 0, formats = 0, changes = 0;
  ui.render(h(component.PrismaEditor, { ref, value: contract, readOnly: true, onChange: () => changes++, onSave: () => reviews++, onFormat: () => formats++ }));
  const content = ui.screen.getByRole("textbox", { name: "Prisma schema source" });
  const modifier = process.platform === "darwin" ? { metaKey: true } : { ctrlKey: true };
  ui.fireEvent.keyDown(content, { key: "s", code: "KeyS", ...modifier });
  ui.fireEvent.keyDown(content, { key: "F", code: "KeyF", keyCode: 70, ...modifier, shiftKey: true });
  assert.equal(reviews, 1);
  assert.equal(formats, 1);
  ui.act(() => ref.current!.replace(0, 0, "forbidden"));
  ui.act(() => ref.current!.replaceDocument("forbidden"));
  assert.equal(changes, 0);
});

test("familiar search and replace edits the draft with native undo", async () => {
  const ref = createRef<PrismaEditorHandle>();
  const changes: string[] = [];
  ui.render(h(component.PrismaEditor, { ref, value: contract, onChange: (text: string) => changes.push(text) }));
  const content = ui.screen.getByRole("textbox", { name: "Prisma schema source" });
  const modifier = process.platform === "darwin" ? { metaKey: true } : { ctrlKey: true };
  ui.fireEvent.keyDown(content, { key: "h", code: "KeyH", ...modifier });
  const search = await ui.screen.findByPlaceholderText("Find");
  const replacement = ui.screen.getByPlaceholderText("Replace");
  ui.fireEvent.change(search, { target: { value: "nickname" } });
  ui.fireEvent.change(replacement, { target: { value: "displayName" } });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "replace all" }));
  assert.ok(changes.at(-1)?.includes("displayName String?"));
  assert.ok(changes.at(-1)?.includes('@map("display_name")'), "physical mapping survives text replacement");
  ui.act(() => ref.current!.undo());
  assert.equal(changes.at(-1), contract);
});
