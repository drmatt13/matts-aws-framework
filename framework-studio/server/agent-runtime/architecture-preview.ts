import { createHash } from "node:crypto";
import type { ArchitectureChange, ArchitectureModePreview } from "../../shared/architecture-preview";
import type { Mode } from "../../shared/model";

export const ARCHITECTURE_PREVIEW_PROTOCOL = 1;
export const ARCHITECTURE_PREVIEW_MARKER = "STUDIO_ARCHITECTURE_PREVIEW_V1=";
export const ARCHITECTURE_PREVIEW_ARTIFACT_MARKER = "STUDIO_ARCHITECTURE_PREVIEW_ARTIFACT_V1=";
export const ARCHITECTURE_PREVIEW_LIMIT = 4 * 1024 * 1024;
export const ARCHITECTURE_PREVIEW_LIMITATIONS = [
  "A sandboxed declaration preview is advisory. It does not synthesize CloudFormation, establish effective IAM, query AWS, or authorize operations.",
  "Both modes use synthetic deployment inputs. Private input-dependent lanes remain unknown; no authored environment files are read.",
  "Native CDK source enrichment, local services, deployed state, and live database data are not included.",
  "Configuration is executable code and can influence its own output. Review source and validation independently of this preview.",
] as const;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type RecordValue = { [key: string]: Json };
export interface ArchitectureEvaluation {
  readonly mode: Mode;
  readonly status: "ok" | "error";
  readonly unresolvedConditions: boolean;
  readonly diagnostics: readonly string[];
  readonly entities: ReadonlyMap<string, { readonly entity: ArchitectureChange["entity"]; readonly id: string; readonly value: RecordValue }>;
}
const groups = [
  ["targets", "target", "ref"], ["routes", "route", "id"], ["resources", "resource", "id"],
  ["edges", "relationship", "id"], ["workflows", "workflow", "ref"], ["networks", "network", "id"],
] as const;
const omitted = new Set(["implementation", "source", "evidence", "removal", "bindingSetting", "stackUsage", "stackOutputs", "inputChoices", "inputSources"]);
function object(value: unknown): value is RecordValue { return !!value && typeof value === "object" && !Array.isArray(value); }
function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function architectureDigest(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function bounded(value: Json, depth = 0): void {
  if (depth > 40) throw new Error("Architecture output exceeds the nesting limit.");
  if (typeof value === "string" && value.length > 128_000) throw new Error("Architecture output contains an oversized value.");
  if (Array.isArray(value)) { if (value.length > 20_000) throw new Error("Architecture output exceeds the collection limit."); for (const entry of value) bounded(entry, depth + 1); }
  else if (object(value)) { if (Object.keys(value).length > 20_000) throw new Error("Architecture output exceeds the object limit."); for (const entry of Object.values(value)) bounded(entry, depth + 1); }
}
/** Only JSON from a completed restricted worker enters this parser. */
export function parseArchitectureEvaluation(output: string, mode: Mode): ArchitectureEvaluation {
  if (Buffer.byteLength(output) > ARCHITECTURE_PREVIEW_LIMIT) throw new Error("Architecture output exceeds the byte limit.");
  const records = output.split("\n").filter(line => line.startsWith(ARCHITECTURE_PREVIEW_MARKER));
  if (records.length !== 1) throw new Error("Architecture worker returned no unique result.");
  const parsed: unknown = JSON.parse(records[0]!.slice(ARCHITECTURE_PREVIEW_MARKER.length));
  if (!object(parsed) || parsed.version !== ARCHITECTURE_PREVIEW_PROTOCOL || parsed.mode !== mode || !object(parsed.model) || typeof parsed.unresolvedConditions !== "boolean") throw new Error("Architecture worker protocol does not match this Studio version.");
  bounded(parsed);
  const model = parsed.model;
  if (model.mode !== mode || model.status !== "ok" && model.status !== "error" || model.stale === true || !Array.isArray(model.diagnostics)) throw new Error("Architecture worker returned an invalid or stale model.");
  const entities = new Map<string, { entity: ArchitectureChange["entity"]; id: string; value: RecordValue }>();
  const add = (entity: ArchitectureChange["entity"], id: unknown, value: RecordValue) => {
    if (typeof id !== "string" || !id || id.length > 2048 || /[\x00-\x1f]/.test(id)) throw new Error("Architecture output has an invalid entity identity.");
    const key = `${entity}:${id}`;
    if (entities.has(key) || entities.size >= 20_000) throw new Error("Architecture output contains duplicate or excessive entities.");
    const selected = Object.fromEntries(Object.entries(value).filter(([field]) => !omitted.has(field)));
    entities.set(key, { entity, id, value: selected });
  };
  for (const [name, entity, identity] of groups) {
    const values = model[name] ?? (name === "networks" ? [] : undefined);
    if (!Array.isArray(values)) throw new Error(`Architecture output is missing ${name}.`);
    for (const value of values) { if (!object(value)) throw new Error(`Architecture output contains invalid ${name}.`); add(entity, value[identity], value); }
  }
  if (model.managedDatabase !== undefined) { if (!object(model.managedDatabase)) throw new Error("Invalid database projection."); add("database", model.managedDatabase.id, model.managedDatabase); }
  if (model.defaults !== undefined) { if (!Array.isArray(model.defaults)) throw new Error("Invalid defaults projection."); add("defaults", "framework-defaults", { groups: model.defaults }); }
  if (model.tagging !== undefined) { if (!object(model.tagging)) throw new Error("Invalid tag projection."); for (const [id, tags] of Object.entries(model.tagging)) { if (!object(tags)) throw new Error("Invalid tag projection."); add("tags", id, tags); } }
  const diagnostics = model.diagnostics.map(value => {
    if (!object(value) || typeof value.message !== "string" || value.severity !== "error" && value.severity !== "warning") throw new Error("Invalid architecture diagnostic.");
    return `${value.severity}: ${value.message}`.slice(0, 4000);
  }).slice(0, 100);
  return { mode, status: model.status, unresolvedConditions: parsed.unresolvedConditions, diagnostics, entities };
}
function implications(entity: ArchitectureChange["entity"], kind: ArchitectureChange["kind"], fields: readonly string[]): string[] {
  const notes: string[] = [];
  if (kind === "remove" && ["resource", "target", "database", "network"].includes(entity)) notes.push("Declaration removal can remove infrastructure; review a production synth separately.");
  if (fields.includes("constructId")) notes.push("Construct identity changed; deployed resource replacement may result.");
  if (entity === "relationship" || fields.some(field => ["access", "secrets", "authorizations", "permissionSources", "auth", "userPool"].includes(field))) notes.push("Review permission and access implications; this is not an effective IAM comparison.");
  if (entity === "network" || fields.some(field => ["placement", "networkId", "subnet"].includes(field))) notes.push("Network reachability or cost may change.");
  if (fields.includes("lanes")) notes.push("Deployment intent changed; private conditional inputs remain unresolved.");
  if (entity === "database") notes.push("Schema migration and database application require separate review and authorization.");
  return notes;
}
export function compareArchitectureEvaluations(baseline: ArchitectureEvaluation, candidate: ArchitectureEvaluation): ArchitectureModePreview {
  if (baseline.mode !== candidate.mode) throw new Error("Architecture modes cannot be compared across lanes.");
  const diagnostics = [...baseline.diagnostics.map(text => `Baseline: ${text}`), ...candidate.diagnostics.map(text => `Proposed: ${text}`)];
  // A failed config often projects no entities. Reporting those as deletions is misleading.
  if (baseline.status !== "ok" || candidate.status !== "ok") return { mode: baseline.mode, status: "unavailable", changes: [], diagnostics };
  const changes: ArchitectureChange[] = [];
  for (const key of [...new Set([...baseline.entities.keys(), ...candidate.entities.keys()])].sort()) {
    const before = baseline.entities.get(key), after = candidate.entities.get(key), selected = after ?? before!;
    if (before && after && canonical(before.value) === canonical(after.value)) continue;
    const kind = !before ? "add" : !after ? "remove" : "modify";
    const fields = before && after ? [...new Set([...Object.keys(before.value), ...Object.keys(after.value)])].filter(field => canonical(before.value[field] ?? null) !== canonical(after.value[field] ?? null)).sort() : Object.keys(selected.value).sort();
    changes.push({ entity: selected.entity, id: selected.id, kind, fields, implications: implications(selected.entity, kind, fields) });
  }
  const partial = baseline.unresolvedConditions || candidate.unresolvedConditions;
  if (partial) diagnostics.push("Conditional deployment inputs are unknown. Conditional lane values are provisional.");
  return { mode: baseline.mode, status: partial ? "partial" : "ready", changes, diagnostics };
}
