import { randomUUID } from "node:crypto";
import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import type { DeploymentInputApply, DeploymentInputDetails, DeploymentInputEdit, DeploymentInputPlan } from "../shared/deployment-inputs";
import type { Mode, Snapshot } from "../shared/model";
import { deploymentInputPath, inputText, sensitiveName } from "./deployment-inputs";
import { EditError } from "./edits/io";
import { diffOf } from "./edits/plan";
import { sha256 } from "./files";

export function inputMode(value: unknown): Mode {
  if (value !== "dev" && value !== "prod") throw new EditError(400, "Choose development or production inputs.");
  return value;
}
export function readInputEdits(value: unknown): DeploymentInputEdit[] {
  if (!Array.isArray(value) || !value.length || value.length > 200) throw new EditError(400, "Review between 1 and 200 environment variable changes.");
  return value.map((edit: unknown) => {
    const item = edit as Record<string, unknown> | undefined;
    if (!item || typeof item.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.name) || typeof item.value !== "string" || item.value.includes("\0") || (item.create !== undefined && item.create !== true)) throw new EditError(400, "Use an environment variable name and a text value without null characters.");
    return { name: item.name, value: item.value, ...(item.create ? { create: true as const } : {}) };
  });
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
  const replacements = new Map(edits.map((edit) => [edit.name, assignment(edit.name, edit.value)]));
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
    else if (!seen.has(name)) { output.push(`${replacement}${newline}`); seen.add(name); }
  }
  let after = output.join("");
  for (const [name, replacement] of replacements) if (!seen.has(name)) { if (after && !after.endsWith("\n")) after += newline; after += replacement + newline; }
  const parsed = parseEnv(after);
  const original = parseEnv(before);
  if (edits.some((edit) => parsed[edit.name] !== edit.value) || Object.keys(original).some((name) => !replacements.has(name) && parsed[name] !== original[name])) throw new EditError(422, "The dotenv edit could not preserve the file's values. Edit this file in your editor.");
  return after;
}

interface PrivatePlan { readonly mode: Mode; readonly revision: string; readonly hash: string; readonly after: string }
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
  details(mode: Mode): DeploymentInputDetails {
    const text = this.text(mode);
    const catalog = this.builder.current?.snapshot.models[mode].resources ?? [];
    return { file: deploymentInputPath(mode), hash: sha256(text), entries: Object.entries(parseEnv(text)).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => ({ name, value: value!, sensitive: sensitiveName(name) || catalog.some((resource) => resource.kind === "secret" && resource.fromEnv === name) })) };
  }
  plan(mode: Mode, edits: readonly DeploymentInputEdit[], hash: string, revision: string): DeploymentInputPlan {
    const before = this.text(mode);
    if (this.builder.current?.snapshot.revision !== revision || sha256(before) !== hash) throw new EditError(409, "This inputs file or configuration changed. Discard the draft and reload before editing.");
    const names = new Set<string>();
    const parsed = parseEnv(before);
    for (const edit of edits) {
      if (names.has(edit.name)) throw new EditError(422, "Each environment variable can appear only once in a draft.");
      names.add(edit.name);
      if (edit.create ? Object.hasOwn(parsed, edit.name) : !Object.hasOwn(parsed, edit.name)) throw new EditError(409, "A variable already exists or is no longer present. Reload the inputs file.");
      if (edit.name === "PROD_DEPLOYMENT" && edit.value !== String(mode === "prod")) throw new EditError(422, "PROD_DEPLOYMENT must match the environment file's mode.");
    }
    const after = updateInputText(before, edits);
    const file = deploymentInputPath(mode);
    const response: DeploymentInputPlan = { planId: randomUUID(), ok: true,
      summaries: edits.map((edit) => `${edit.create ? "Add" : "Update"} ${edit.name}`),
      // Do not put any dotenv value (including unrecognized secrets) in a diff.
      changes: [{ file, diff: diffOf(file, edits.filter((edit) => !edit.create).map((edit) => `${edit.name}=<value hidden>`).join("\n"), edits.map((edit) => `${edit.name}=<${edit.create ? "new" : "updated"} value hidden>`).join("\n")) }],
    };
    if (this.plans.size >= 20) this.expirePlans();
    this.plans.set(response.planId, { mode, revision, hash, after });
    return response;
  }
  async apply(id: string): Promise<DeploymentInputApply> {
    const plan = this.plans.get(id);
    if (!plan) throw new EditError(410, "This inputs review expired. Review the draft again.");
    const file = deploymentInputPath(plan.mode);
    if (this.builder.current?.snapshot.revision !== plan.revision || sha256(this.text(plan.mode)) !== plan.hash) throw new EditError(409, "The inputs file or configuration changed since review. Nothing was written.");
    // A private sibling on the same filesystem is atomically renamed into place.
    const temporary = path.join(this.root, "cdk-app", `.env.studio-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, plan.after, { flag: "wx", mode: 0o600 });
      if (sha256(this.text(plan.mode)) !== plan.hash) throw new EditError(409, "The inputs file changed during apply. Nothing was written.");
      renameSync(temporary, path.join(this.root, file));
    } catch (error) {
      if (error instanceof EditError) throw error;
      throw new EditError(500, "Could not save the inputs file. Check local file permissions and review again.");
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    this.ownWrites.set(file, sha256(plan.after));
    this.expirePlans();
    const state = await this.builder.refresh().catch(() => undefined);
    return {
      status: "applied",
      message: `Saved ${file}.${state ? "" : " Studio could not refresh the configuration. Reload Studio after resolving the refresh failure."} Synthesis and deployment are separate actions.`,
      revision: state?.snapshot.revision ?? plan.revision,
    };
  }
}
