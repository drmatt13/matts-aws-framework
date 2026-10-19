import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import type { DeploymentInputFile } from "../shared/deployment-inputs";
import type { Mode, ModeModel, ModelEdge, ModelResource, SourceLocation } from "../shared/model";
import { inputRequirements } from "./input-requirements";

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

export function withDeploymentInputs(root: string, model: ModeModel, models?: Readonly<Record<Mode, ModeModel>>): ModeModel {
  const catalog = model.resources.filter((resource) => !resource.deploymentFile);
  const expected = new Map<string, ModelResource[]>();
  for (const resource of catalog) if (resource.fromEnv) expected.set(resource.fromEnv, [...(expected.get(resource.fromEnv) ?? []), resource]);
  const files: DeploymentInputFile[] = (["dev", "prod"] as const).map((mode) => {
    const file = deploymentInputPath(mode);
    try {
      const text = inputText(root, file);
      const parsed = parseEnv(text ?? "");
      const template = parseEnv(inputText(root, deploymentInputTemplate(mode)) ?? "");
      const locations = assignmentLines(text ?? "");
      const requirements = inputRequirements(models?.[mode] ?? model, parsed, mode, file);
      return { mode, path: file, template: deploymentInputTemplate(mode), exists: text !== undefined,
        entries: [...new Set([...Object.keys(parsed), ...Object.keys(template), ...expected.keys()])].sort().map((name) => {
          const targets = expected.get(name) ?? [];
          const value = parsed[name];
          const line = locations.get(name);
          const source: SourceLocation | undefined = line ? { file, line, column: 1, start: 0, end: 0 } : undefined;
          return { name, status: value === undefined ? "missing" as const : value.trim() === "" ? "empty" as const : "configured" as const,
            sensitive: targets.some((target) => target.kind === "secret") || sensitiveName(name), defaulted: !parsed[name]?.trim() && targets.some((target) => target.default !== undefined),
            targets: targets.map((target) => target.id), requirements: targets.flatMap((target) => requirements.get(target.id) ? [requirements.get(target.id)!] : []), ...(source ? { source } : {}) };
        }) };
    } catch {
      const requirements = inputRequirements(models?.[mode] ?? model, {}, mode, file, false);
      return { mode, path: file, template: deploymentInputTemplate(mode), exists: false,
        entries: [...expected].map(([name, targets]) => ({ name, status: "missing" as const, sensitive: targets.some((target) => target.kind === "secret") || sensitiveName(name), defaulted: false, targets: targets.map((target) => target.id), requirements: targets.flatMap((target) => requirements.get(target.id) ? [requirements.get(target.id)!] : []) })),
        problem: `Could not read ${file}. Check that it is a regular local dotenv file.` };
    }
  });
  const resources: ModelResource[] = catalog.map((resource) => resource.fromEnv ? { ...resource,
    inputRequirement: files.find((file) => file.mode === model.mode)?.entries.find((entry) => entry.name === resource.fromEnv)?.requirements?.find((requirement) => requirement.resource === resource.id),
    inputSources: files.flatMap((file) => file.entries.filter((entry) => entry.name === resource.fromEnv).map((entry) => ({ file: file.path, entry }))) } : resource);
  // A file belongs to its own environment's graph and is absent from the other's, as any resource a graph does
  // not hold is: every view follows `absent`, so the file's connections recede in the other environment too.
  for (const file of files) resources.push({ id: `envfile:${file.mode}`, path: [`.env.${file.mode}`], kind: "envFile", absent: file.mode !== model.mode, deploymentFile: file });
  const edges: ModelEdge[] = files.flatMap((file) => file.entries.flatMap((entry) => entry.targets.filter((to) => entry.status !== "missing" || entry.requirements?.some((item) => item.resource === to && item.required)).map((to) => ({
    id: `input-source:${file.mode}:${entry.name}:${to}`, relation: "supplies" as const, from: `envfile:${file.mode}`, to, provenance: "source" as const,
    inputRequirement: entry.requirements?.find((item) => item.resource === to),
    label: entry.name, source: entry.source, detail: `${file.path}: ${entry.status}${entry.defaulted ? "; declaration default applies" : ""}. Required links can represent an unfilled input; values are excluded.`,
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
