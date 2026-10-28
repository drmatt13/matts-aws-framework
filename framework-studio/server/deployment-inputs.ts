import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import type { DeploymentInputEntry, DeploymentInputFile } from "../shared/deployment-inputs";
import type { InputModePolicy, Mode, ModeModel, ModelEdge, ModelResource, SourceLocation } from "../shared/model";
import { inputRequirements } from "./input-requirements";
import { listResourceDeclarations, resolveInput, type InputResolution } from "../../packages/framework/src/config/resources";
import { DATABASE_SETTING_INPUTS } from "../../packages/framework/src/config/database";
import { deploymentInputs } from "../../cdk-app/deployment-inputs";

export const deploymentInputPath = (mode: Mode) => `cdk-app/.env.${mode}`;
export const deploymentInputTemplate = (mode: Mode) => `${deploymentInputPath(mode)}.template`;

/** Fixed local files only, with no symlink traversal and no arbitrary read/write path API. */
export function inputText(root: string, relative: string): string | undefined {
  const directory = path.join(root, "cdk-app");
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new Error("CDK input files must stay inside the repository.");
  const file = path.join(root, relative);
  if (!existsSync(file)) return undefined;
  if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) throw new Error("CDK inputs must be regular local files.");
  return readFileSync(file, "utf8");
}

/** The mode's inputs file (`-c prodDeployment` picks `.env.prod`, otherwise `.env.dev`), after refusing a link out of the repository. */
export function selectedDeploymentInput(root: string, mode: Mode): string {
  inputText(root, deploymentInputPath(mode));
  return deploymentInputPath(mode);
}

/** Explicit bootstrap only. Never called by snapshot evaluation or synthesis. */
export function createDeploymentInput(root: string, mode: Mode): { file: string; created: boolean } {
  const file = deploymentInputPath(mode);
  if (inputText(root, file) !== undefined) return { file, created: false };
  const template = inputText(root, deploymentInputTemplate(mode));
  if (template === undefined) throw new Error(`Missing ${deploymentInputTemplate(mode)}.`);
  // Exclusive and private: an inputs file is never overwritten, and production is never seeded from development.
  writeFileSync(path.join(root, file), template, { flag: "wx", mode: 0o600 });
  return { file, created: true };
}

/** Locate assignments without mistaking lines inside multiline values for parameters. */
function assignmentLines(text: string): Map<string, number> {
  const result = new Map<string, number>();
  let quote: string | undefined;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    let tail = line;
    if (!quote) {
      const match = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      result.set(match[1]!, index + 1);
      tail = match[2]!;
      if (!["\"", "'", "`"].includes(tail[0] ?? "")) continue;
      quote = tail[0]; tail = tail.slice(1);
    }
    for (let at = 0; at < tail.length; at++) {
      if (tail[at] === "\\" && quote === "\"") { at++; continue; }
      if (tail[at] === quote) { quote = undefined; break; }
    }
  }
  return result;
}

export const sensitiveName = (name: string) => /SECRET|PASSWORD|TOKEN|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY|API_KEY/i.test(name);

const MODES = ["dev", "prod"] as const;
const lineStatus = (value: string | undefined) => value === undefined ? "missing" as const : value.trim() === "" ? "empty" as const : "configured" as const;

/**
 * An authored input's policy in both graphs. A declaration that differs between them carries
 * `modes`; one that does not is read from each graph's own answer, which is also how a legacy
 * `PROD_DEPLOYMENT ? undefined : resource.fromEnv(...)` shows as absent from production.
 */
function inputModes(resource: ModelResource, models?: Readonly<Record<Mode, ModeModel>>): Readonly<Record<Mode, InputModePolicy>> {
  if (resource.modes) return resource.modes;
  const own: InputModePolicy = { present: !resource.absent, required: !resource.absent && !!resource.required, ...(resource.default !== undefined && !resource.absent ? { default: resource.default } : {}) };
  const read = (mode: Mode): InputModePolicy => {
    const graph = models?.[mode];
    if (!graph || graph.status !== "ok" || graph.stale) return own;
    const found = graph.resources.find((item) => item.id === resource.id);
    if (!found || found.absent) return { present: false, required: false };
    return { present: true, required: !!found.required, ...(found.default !== undefined ? { default: found.default } : {}) };
  };
  return { dev: read("dev"), prod: read("prod") };
}

export function withDeploymentInputs(root: string, model: ModeModel, models?: Readonly<Record<Mode, ModeModel>>, comparisons: readonly { readonly input: string; readonly equals: string }[] = []): ModeModel {
  const selectedComparisons = new Map<string, Readonly<Record<string, "holds" | "fails" | "unset">>>();
  const catalog = model.resources.filter((resource) => !resource.deploymentFile).map((resource) =>
    resource.fromEnv && (resource.kind === "input" || resource.kind === "secret") ? { ...resource, modes: inputModes(resource, models) } : resource);
  const read = (mode: Mode) => {
    const file = deploymentInputPath(mode);
    try {
      const text = inputText(root, file);
      return { file, text, parsed: parseEnv(text ?? "") as Record<string, string | undefined>, locations: assignmentLines(text ?? "") };
    } catch {
      return { file, text: undefined, parsed: {} as Record<string, string | undefined>, locations: new Map<string, number>(), problem: `Could not read ${file}. Check that it is a regular local dotenv file.` };
    }
  };
  const inputs = { dev: read("dev"), prod: read("prod") };
  const own = inputs[model.mode];
  // Each input's state in this graph, by the framework's own resolver. Only the state leaves:
  // values stay here, and a secret's value is never read.
  // Required means required by the declaration or by a consumer active in this graph.
  const requirementsFor = Object.fromEntries(MODES.map((mode) => [mode, inputRequirements(models?.[mode] ?? model, inputs[mode].problem ? {} : inputs[mode].parsed as Record<string, string>, mode, inputs[mode].file, !inputs[mode].problem)])) as Record<Mode, ReturnType<typeof inputRequirements>>;
  const resolutions = new Map<string, InputResolution>();
  for (const resource of catalog) if (resource.fromEnv && (resource.kind === "input" || resource.kind === "secret")) {
    const required = !!requirementsFor[model.mode].get(resource.id)?.required;
    const declared = { fromEnv: resource.fromEnv, ...(resource.absent ? { absent: true as const } : {}), ...(required ? { required: true as const } : {}),
      ...(resource.kind === "input" ? { default: resource.default, values: resource.values } : {}) };
    const resolved = resolveInput(declared, { env: own.parsed });
    resolutions.set(resource.id, resolved);
    if (resource.kind !== "input") continue;
    const value = resolved.state === "supplied" || resolved.state === "fallback" ? resolved.value : undefined;
    selectedComparisons.set(resource.id, Object.fromEntries(comparisons.filter((condition) => condition.input === resource.fromEnv).map((condition) => [condition.equals,
      value === undefined ? "unset" : value === condition.equals ? "holds" : "fails",
    ])));
  }
  // Both files list the same names: each file's own lines, the other file's lines, and every input
  // the catalog declares. The catalog is the one exception — an input declared `.only()` the other
  // graph is not offered to this file, and is flagged if a line for it is written here anyway.
  // Either graph may be the only one holding a legacy conditional declaration, so both catalogs count.
  const inputsById = new Map<string, ModelResource>();
  for (const resource of [...catalog, ...MODES.flatMap((mode) => models?.[mode].resources ?? [])]) {
    if (resource.fromEnv && (resource.kind === "input" || resource.kind === "secret") && !inputsById.has(resource.id)) inputsById.set(resource.id, { ...resource, modes: inputModes(resource, models) });
  }
  const declared = new Map<string, ModelResource[]>();
  for (const resource of inputsById.values()) declared.set(resource.fromEnv!, [...(declared.get(resource.fromEnv!) ?? []), resource]);
  const written = new Set(MODES.flatMap((mode) => Object.keys(inputs[mode].parsed)));
  // Variables the catalog does not declare but the application does read: its deployment settings,
  // and the production database's overrides with the declaration's values as their defaults.
  // They are listed when a file writes them; their own declarations supply default, choices and note.
  const owned = new Map<string, { owner: NonNullable<DeploymentInputEntry["owner"]>; default?: string; choices?: readonly string[]; note?: string; productionOnly?: true }>();
  for (const reference of listResourceDeclarations(deploymentInputs(model.mode))) owned.set(reference.fromEnv!, { owner: "deployment", ...(reference.default === undefined ? {} : { default: reference.default }), ...(reference.values ? { choices: reference.values } : {}), ...(reference.note ? { note: reference.note } : {}) });
  const database = (models?.prod ?? model).managedDatabase;
  for (const [field, name] of Object.entries(DATABASE_SETTING_INPUTS) as [keyof typeof DATABASE_SETTING_INPUTS, string][]) {
    const value = database?.settings[field];
    owned.set(name, { owner: "database", productionOnly: true,
      ...(value === undefined ? {} : { default: Array.isArray(value) ? value.join(",") : String(value) }), ...(typeof value === "boolean" ? { choices: ["true", "false"] } : {}) });
  }
  const files: DeploymentInputFile[] = MODES.map((mode) => {
    const { file, text, parsed, locations, problem } = inputs[mode];
    const counterpart = inputs[mode === "dev" ? "prod" : "dev"].parsed;
    const requirements = requirementsFor[mode];
    const names = new Set([...written, ...declared.keys()].filter((name) => {
      const targets = declared.get(name);
      return !targets || targets.some((target) => target.modes![mode].present) || parsed[name] !== undefined;
    }));
    const entries = [...names].sort().map((name) => {
      const targets = declared.get(name) ?? [];
      const present = targets.filter((target) => target.modes![mode].present);
      const known = targets.length ? undefined : owned.get(name);
      const unread = !!known?.productionOnly && mode === "dev";
      const fallback = known ? unread ? undefined : known.default : present.find((target) => target.kind === "input" && target.modes![mode].default !== undefined)?.modes![mode].default;
      const choices = known ? known.choices : present.find((target) => target.values)?.values;
      const status = lineStatus(parsed[name]);
      const line = locations.get(name);
      const source: SourceLocation | undefined = line ? { file, line, column: 1, start: 0, end: 0 } : undefined;
      return { name, status, counterpart: lineStatus(counterpart[name]),
        sensitive: targets.some((target) => target.kind === "secret") || sensitiveName(name),
        defaulted: status !== "configured" && fallback !== undefined,
        targets: targets.map((target) => target.id),
        ...(fallback !== undefined ? { default: fallback } : {}),
        ...(choices ? { choices } : {}),
        ...((targets.length && !present.length) || (unread && status !== "missing") ? { notRead: true as const } : {}),
        ...(known ? { owner: known.owner, ...(known.note ? { note: known.note } : {}) } : {}),
        requirements: present.flatMap((target) => requirements.get(target.id) ? [requirements.get(target.id)!] : []),
        ...(source ? { source } : {}) };
    });
    return { mode, path: file, template: deploymentInputTemplate(mode), exists: text !== undefined, entries, ...(problem ? { problem } : {}) };
  });
  const resources: ModelResource[] = catalog.map((resource) => resource.fromEnv ? { ...resource,
    inputComparisons: selectedComparisons.get(resource.id),
    ...(resolutions.has(resource.id) ? { inputState: resolutions.get(resource.id)!.state } : {}),
    inputRequirement: files.find((file) => file.mode === model.mode)?.entries.find((entry) => entry.name === resource.fromEnv)?.requirements?.find((requirement) => requirement.resource === resource.id),
    inputSources: files.flatMap((file) => file.entries.filter((entry) => entry.name === resource.fromEnv).map((entry) => ({ file: file.path, entry }))) } : resource);
  // A file belongs to its own environment's graph and is absent from the other's, as any resource a graph does
  // not hold is: every view follows `absent`, so the file's connections recede in the other environment too.
  for (const file of files) resources.push({ id: `envfile:${file.mode}`, path: [file.path], kind: "envFile", absent: file.mode !== model.mode, deploymentFile: file });
  const lineState = (entry: DeploymentInputEntry) => entry.status === "configured" ? "set" : entry.defaulted ? `blank, so the default ${entry.default} applies` : entry.status === "empty" ? "blank" : "not written";
  const edges: ModelEdge[] = files.flatMap((file) => file.entries.flatMap((entry) => entry.notRead ? [] : entry.targets.filter((to) => entry.status !== "missing" || entry.requirements?.some((item) => item.resource === to && item.required)).map((to) => ({
    id: `input-source:${file.mode}:${entry.name}:${to}`, relation: "supplies" as const, from: `envfile:${file.mode}`, to, provenance: "source" as const,
    inputRequirement: entry.requirements?.find((item) => item.resource === to),
    label: entry.name, source: entry.source, detail: `${file.path}: ${lineState(entry)}. Required links can represent an unfilled input; values are excluded.`,
  }))));
  const byResource = new Map(resources.map((resource) => [resource.id, resource]));
  const reads = model.edges.filter((edge) => edge.relation !== "supplies").map((edge) => {
    if (edge.relation !== "env" && edge.relation !== "secret") return edge;
    const { inputRequirement: _previous, ...plain } = edge;
    const resource = byResource.get(edge.to) ?? byResource.get(edge.from);
    const requirement = resource?.inputRequirement;
    const consumer = edge.to === resource?.id ? edge.from : edge.to;
    return requirement?.status === "missing" && (resource?.required || requirement.consumers?.includes(consumer)) ? { ...plain, inputRequirement: requirement } : plain;
  });
  return { ...model, resources, edges: [...reads, ...edges] };
}
