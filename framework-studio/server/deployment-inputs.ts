import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import type { DeploymentInputFile } from "../shared/deployment-inputs";
import type { Mode, ModeModel, ModelEdge, ModelResource, SourceLocation } from "../shared/model";
import { inputRequirements } from "./input-requirements";

export const deploymentInputPath = (mode: Mode) => `cdk-app/.env.${mode}`;
export const deploymentInputExample = (mode: Mode) => `${deploymentInputPath(mode)}.example`;

/** Fixed local files only, with no symlink traversal and no arbitrary read/write path API. */
export function inputText(root: string, relative: string): string | undefined {
  const directory = path.join(root, "cdk-app");
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new Error("CDK input files must stay inside the repository.");
  const file = path.join(root, relative);
  if (!existsSync(file)) return undefined;
  if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) throw new Error("CDK inputs must be regular local files.");
  return readFileSync(file, "utf8");
}

export function selectedDeploymentInput(root: string, mode: Mode): string {
  if (inputText(root, deploymentInputPath(mode)) !== undefined) return deploymentInputPath(mode);
  inputText(root, "cdk-app/.env");
  return "cdk-app/.env";
}

/** Explicit bootstrap only. Never called by snapshot evaluation or synthesis. */
export function createDeploymentInput(root: string, mode: Mode): { file: string; created: boolean } {
  const file = deploymentInputPath(mode);
  if (inputText(root, file) !== undefined) return { file, created: false };
  const example = inputText(root, deploymentInputExample(mode));
  if (example === undefined) throw new Error(`Missing ${deploymentInputExample(mode)}.`);
  const active = inputText(root, "cdk-app/.env");
  const activeValues = parseEnv(active ?? "");
  const activeMode = activeValues.PROD_DEPLOYMENT?.trim().toLowerCase() === "true" ? "prod" : "dev";
  let text = example;
  if (active !== undefined && activeMode === mode) {
    // Preserve authored bytes and credentials in their own environment. Never copy dev inputs to prod.
    const missing = Object.entries(parseEnv(example)).filter(([name]) => activeValues[name] === undefined);
    text = `${active}\n# Missing defaults from ${deploymentInputExample(mode)}\n${missing.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n")}\n`;
  }
  writeFileSync(path.join(root, file), `${text}\nPROD_DEPLOYMENT=${mode === "prod"}\n`, { flag: "wx", mode: 0o600 });
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
      const template = parseEnv(inputText(root, deploymentInputExample(mode)) ?? "");
      const locations = assignmentLines(text ?? "");
      const synthesisSource = selectedDeploymentInput(root, mode);
      const effectiveValues = synthesisSource === file ? parsed : parseEnv(inputText(root, synthesisSource) ?? "");
      const requirements = inputRequirements(models?.[mode] ?? model, effectiveValues, mode, synthesisSource);
      return { mode, path: file, example: deploymentInputExample(mode), exists: text !== undefined,
        synthesisSource, entries: [...new Set([...Object.keys(parsed), ...Object.keys(template), ...expected.keys()])].sort().map((name) => {
          const targets = expected.get(name) ?? [];
          const value = parsed[name];
          const line = locations.get(name);
          const source: SourceLocation | undefined = line ? { file, line, column: 1, start: 0, end: 0 } : undefined;
          return { name, status: value === undefined ? "missing" as const : value.trim() === "" ? "empty" as const : "configured" as const,
            sensitive: targets.some((target) => target.kind === "secret") || sensitiveName(name), defaulted: !value?.trim() && targets.some((target) => target.default !== undefined),
            targets: targets.map((target) => target.id), requirements: targets.flatMap((target) => requirements.get(target.id) ? [requirements.get(target.id)!] : []), ...(source ? { source } : {}) };
        }) };
    } catch {
      return { mode, path: file, example: deploymentInputExample(mode), exists: false, synthesisSource: file, entries: [], problem: `Could not read ${file}. Check that it is a regular local dotenv file.` };
    }
  });
  const resources: ModelResource[] = catalog.map((resource) => resource.fromEnv ? { ...resource,
    inputRequirement: files.find((file) => file.mode === model.mode)?.entries.find((entry) => entry.name === resource.fromEnv)?.requirements?.find((requirement) => requirement.resource === resource.id),
    inputSources: files.flatMap((file) => file.entries.filter((entry) => entry.name === resource.fromEnv).map((entry) => ({ file: file.path, entry }))) } : resource);
  for (const file of files) resources.push({ id: `envfile:${file.mode}`, path: [`.env.${file.mode}`], kind: "envFile", absent: false, deploymentFile: file });
  const edges: ModelEdge[] = files.flatMap((file) => file.entries.flatMap((entry) => entry.targets.filter((to) => entry.status !== "missing" || entry.requirements?.some((item) => item.resource === to && item.required)).map((to) => ({
    id: `input-source:${file.mode}:${entry.name}:${to}`, relation: "supplies" as const, from: `envfile:${file.mode}`, to, provenance: "source" as const,
    inputRequirement: entry.requirements?.find((item) => item.resource === to),
    label: entry.name, source: entry.source, detail: `${file.path}: ${entry.status}${entry.defaulted ? "; declaration default applies" : ""}. Required links can represent an unfilled input; values are excluded.`,
  }))));
  return { ...model, resources, edges: [...model.edges.filter((edge) => edge.relation !== "supplies"), ...edges] };
}
