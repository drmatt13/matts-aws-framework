import { randomUUID } from "node:crypto";
import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import type { DeploymentInputApply, DeploymentInputDetails, DeploymentInputEdit, DeploymentInputFileEdits, DeploymentInputPlan } from "../shared/deployment-inputs";
import type { Mode, Snapshot } from "../shared/model";
import { deploymentInputPath, inputText, sensitiveName } from "./deployment-inputs";
import { EditError } from "./edits/io";
import { diffOf } from "./edits/plan";
import { sha256 } from "./files";
import { domainSettingsProblems } from "../shared/domain-settings";

export function inputMode(value: unknown): Mode {
  if (value !== "dev" && value !== "prod") throw new EditError(400, "Choose development or production inputs.");
  return value;
}
export function readInputEdits(value: unknown): DeploymentInputEdit[] {
  if (!Array.isArray(value) || !value.length || value.length > 200) throw new EditError(400, "Review between 1 and 200 environment variable changes.");
  return value.map((edit: unknown) => {
    const item = edit as Record<string, unknown> | undefined;
    if (!item || typeof item.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.name) || typeof item.value !== "string" || item.value.includes("\0") || (item.create !== undefined && item.create !== true) || (item.remove !== undefined && item.remove !== true)) throw new EditError(400, "Use an environment variable name and a text value without null characters.");
    if (item.remove && (item.create || item.value !== "")) throw new EditError(400, "A removal cannot create a variable or supply a value.");
    return { name: item.name, value: item.value, ...(item.create ? { create: true as const } : {}), ...(item.remove ? { remove: true as const } : {}) };
  });
}
/** One review covers one or both files, each once, within the same total edit limit. */
export function readInputFiles(value: unknown): DeploymentInputFileEdits[] {
  if (!Array.isArray(value) || !value.length || value.length > 2) throw new EditError(400, "Review changes to one or both CDK environment files.");
  const files = value.map((file: unknown) => {
    const item = file as Record<string, unknown> | undefined;
    return { mode: inputMode(item?.mode), hash: String(item?.hash ?? ""), edits: readInputEdits(item?.edits) };
  });
  if (new Set(files.map((file) => file.mode)).size !== files.length) throw new EditError(400, "Review each environment file once.");
  if (files.reduce((sum, file) => sum + file.edits.length, 0) > 200) throw new EditError(400, "Review between 1 and 200 environment variable changes.");
  return files;
}

/** Node's dotenv reader does not support every JavaScript string escape. Round-trip
 * the chosen literal before writing, so punctuation and multiline values stay exact. */
function assignment(name: string, value: string): string {
  for (const quote of ["'", '"', "`", ""]) {
    const text = `${name}=${quote}${value}${quote}`;
    if ((quote && value.includes(quote)) || (!quote && /[\r\n#]/.test(value))) continue;
    if (parseEnv(text)[name] === value) return text;
  }
  throw new EditError(422, "This value cannot be represented exactly in dotenv syntax. Use the file in your editor for this value.");
}

/** Keep unrelated assignments and comments byte-for-byte. A changed key is written
 * once; duplicate assignments for that key are removed, including multiline spans. */
export function updateInputText(before: string, edits: readonly DeploymentInputEdit[]): string {
  const replacements = new Map(edits.map((edit) => [edit.name, edit.remove ? null : assignment(edit.name, edit.value)]));
  const seen = new Set<string>();
  const lines = before.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const newline = before.includes("\r\n") ? "\r\n" : "\n";
  const output: string[] = [];
  for (let at = 0; at < lines.length; at++) {
    const first = lines[at]!;
    const match = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*([\s\S]*)/.exec(first.replace(/\r?\n$/, ""));
    if (!match) { output.push(first); continue; }
    const name = match[1]!;
    let block = first;
    const tail = match[2]!;
    const quote = ["'", '"', "`"].includes(tail[0] ?? "") ? tail[0] : undefined;
    if (quote) {
      // Use the same closing delimiter as Node's dotenv parser.
      let rest = tail.slice(1);
      while (!rest.includes(quote) && at + 1 < lines.length) { const next = lines[++at]!; block += next; rest += next; }
    }
    const replacement = replacements.get(name);
    if (replacement === undefined) output.push(block);
    else if (!seen.has(name)) { if (replacement !== null) output.push(`${replacement}${newline}`); seen.add(name); }
  }
  let after = output.join("");
  for (const [name, replacement] of replacements) if (!seen.has(name) && replacement !== null) { if (after && !after.endsWith("\n")) after += newline; after += replacement + newline; }
  const parsed = parseEnv(after);
  const original = parseEnv(before);
  if (edits.some((edit) => edit.remove ? Object.hasOwn(parsed, edit.name) : parsed[edit.name] !== edit.value) || Object.keys(original).some((name) => !replacements.has(name) && parsed[name] !== original[name])) throw new EditError(422, "The dotenv edit could not preserve the file's values. Edit this file in your editor.");
  return after;
}

interface PrivatePlan { readonly revision: string; readonly files: readonly { readonly mode: Mode; readonly hash: string; readonly after: string }[] }
interface InputState { readonly current?: { readonly snapshot: Pick<Snapshot, "revision" | "models"> }; refresh(): Promise<{ readonly snapshot: { readonly revision: string } }> }

/** Only the two mode-specific files are writable. Values and private plans remain
 * in memory; no config allowlist expansion, disk journal, evaluator or value log. */
export class DeploymentInputService {
  private readonly plans = new Map<string, PrivatePlan>();
  readonly ownWrites = new Map<string, string>();
  constructor(private readonly root: string, private readonly builder: InputState) {}
  expirePlans(): void { this.plans.clear(); }
  private text(mode: Mode): string {
    inputMode(mode);
    try { const text = inputText(this.root, deploymentInputPath(mode)); if (text !== undefined) return text; }
    catch { throw new EditError(422, "The inputs file must be a readable regular file inside cdk-app."); }
    throw new EditError(404, "Create this environment file from its reference before editing.");
  }
  private sensitive(mode: Mode, name: string): boolean {
    const catalog = this.builder.current?.snapshot.models[mode].resources ?? [];
    return sensitiveName(name) || catalog.some((resource) => resource.kind === "secret" && resource.fromEnv === name);
  }
  /** Every line, with a sensitive value withheld: the browser learns only that it is set. */
  details(mode: Mode): DeploymentInputDetails {
    const text = this.text(mode);
    return { file: deploymentInputPath(mode), hash: sha256(text), entries: Object.entries(parseEnv(text)).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => {
      const sensitive = this.sensitive(mode, name);
      return sensitive && value!.trim() ? { name, value: "", sensitive, hidden: true as const } : { name, value: value!, sensitive };
    }) };
  }
  /** One withheld value, only when someone asks to reveal it. */
  reveal(mode: Mode, name: string): { readonly name: string; readonly value: string } {
    const value = parseEnv(this.text(mode))[name];
    if (typeof name !== "string" || value === undefined) throw new EditError(404, "This variable is not in the selected file.");
    return { name, value };
  }
  /** Every file is checked before any is planned: one stale or invalid file refuses the whole review. */
  plan(files: readonly DeploymentInputFileEdits[], revision: string): DeploymentInputPlan {
    if (this.builder.current?.snapshot.revision !== revision) throw new EditError(409, "This inputs file or configuration changed. Discard the draft and reload before editing.");
    const planned = [...files].sort((a, b) => a.mode.localeCompare(b.mode)).map(({ mode, hash, edits }) => {
      const before = this.text(mode);
      if (sha256(before) !== hash) throw new EditError(409, "This inputs file or configuration changed. Discard the draft and reload before editing.");
      const names = new Set<string>();
      const parsed = parseEnv(before);
      for (const edit of edits) {
        if (edit.remove && (edit.create || edit.value !== "")) throw new EditError(422, "A removal cannot create a variable or supply a value.");
        if (names.has(edit.name)) throw new EditError(422, "Each environment variable can appear only once in a draft.");
        names.add(edit.name);
        if (edit.create ? Object.hasOwn(parsed, edit.name) : !Object.hasOwn(parsed, edit.name)) throw new EditError(409, "A variable already exists or is no longer present. Reload the inputs file.");
        if (edit.name === "PROD_DEPLOYMENT" && edit.value !== String(mode === "prod")) throw new EditError(422, "PROD_DEPLOYMENT must match the environment file's mode.");
      }
      const after = updateInputText(before, edits);
      const domainProblems = domainSettingsProblems(mode, parseEnv(after), edits.map(edit => edit.name));
      if (domainProblems.length) throw new EditError(422, domainProblems.join(" "));
      return { mode, hash, edits, after, file: deploymentInputPath(mode) };
    });
    const response: DeploymentInputPlan = { planId: randomUUID(), ok: true,
      summaries: planned.flatMap(({ edits, file }) => edits.map((edit) => `${edit.remove ? "Remove" : edit.create ? "Add" : "Update"} ${edit.name} ${edit.remove ? "from" : "in"} ${path.basename(file)}`)),
      // Do not put any dotenv value (including unrecognized secrets) in a diff.
      changes: planned.map(({ edits, file }) => ({ file, diff: diffOf(file, edits.filter((edit) => !edit.create).map((edit) => `${edit.name}=<value hidden>`).join("\n"), edits.filter((edit) => !edit.remove).map((edit) => `${edit.name}=<${edit.create ? "new" : "updated"} value hidden>`).join("\n")) })),
    };
    if (this.plans.size >= 20) this.expirePlans();
    this.plans.set(response.planId, { revision, files: planned.map(({ mode, hash, after }) => ({ mode, hash, after })) });
    return response;
  }
  async apply(id: string): Promise<DeploymentInputApply> {
    const plan = this.plans.get(id);
    if (!plan) throw new EditError(410, "This inputs review expired. Review the draft again.");
    const unchanged = () => plan.files.every((file) => sha256(this.text(file.mode)) === file.hash);
    if (this.builder.current?.snapshot.revision !== plan.revision || !unchanged()) throw new EditError(409, "The inputs file or configuration changed since review. Nothing was written.");
    // Private siblings on the same filesystem, each atomically renamed into place once every file is staged.
    const staged = plan.files.map((file) => ({ ...file, path: deploymentInputPath(file.mode), temporary: path.join(this.root, "cdk-app", `.env.studio-${randomUUID()}.tmp`) }));
    const saved: string[] = [];
    try {
      for (const file of staged) writeFileSync(file.temporary, file.after, { flag: "wx", mode: 0o600 });
      if (!unchanged()) throw new EditError(409, "The inputs file changed during apply. Nothing was written.");
      for (const file of staged) {
        renameSync(file.temporary, path.join(this.root, file.path));
        this.ownWrites.set(file.path, sha256(file.after));
        saved.push(file.path);
      }
    } catch (error) {
      if (error instanceof EditError) throw error;
      if (!saved.length) throw new EditError(500, "Could not save the inputs file. Check local file permissions and review again.");
      // Renames do not fail independently in practice, but if one does, say exactly what was written.
      this.expirePlans();
      await this.builder.refresh().catch(() => undefined);
      throw new EditError(500, `Saved ${saved.join(" and ")}, but could not save ${staged.filter((file) => !saved.includes(file.path)).map((file) => file.path).join(" and ")}. Check local file permissions, then review the remaining changes again.`);
    } finally { for (const file of staged) if (existsSync(file.temporary)) unlinkSync(file.temporary); }
    this.expirePlans();
    const state = await this.builder.refresh().catch(() => undefined);
    return {
      status: "applied",
      message: `Saved ${saved.join(" and ")}.${state ? "" : " Studio could not refresh the configuration. Reload Studio after resolving the refresh failure."} Synthesis and deployment are separate actions.`,
      revision: state?.snapshot.revision ?? plan.revision,
    };
  }
}
