import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { locateConfigSource } from "../../../packages/framework/scripts/config-source";
import type { StudioState } from "../snapshot";
import { SourceFiles, entryValue, findEntry } from "../source";
import { parseOrigin } from "../model/origin";
import { assertWritable, toRelative } from "../files";
import { assertCreationFile } from "./creation";
import { EditError } from "./io";
import { removeProperty } from "./splice";

export function planWorkloadRemoval(root: string, state: StudioState, targetRef: string, overrides: Map<string, string>): readonly { file: string; before: string; after: null }[] {
  const models = Object.values(state.snapshot.models), target = models.flatMap(model => model.targets).find(target => target.ref === targetRef);
  if (!target) throw new EditError(404, "Select a declared workload to review removal.");
  const routes = new Set(models.flatMap(model => model.routes).filter(route => route.target === targetRef).map(route => route.id));
  const incoming = models.flatMap(model => model.edges).filter(edge => edge.to === targetRef && edge.from !== targetRef && !routes.has(edge.from));
  if (incoming.length) throw new EditError(422, `Disconnect consumers before removing ${targetRef}: ${[...new Set(incoming.map(edge => edge.from))].join(", ")}. No code or AWS resources were removed.`);
  for (const origin of target.origins) {
    const files = new SourceFiles(overrides), parsed = parseOrigin(origin), located = locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root, host: files.host() });
    const entry = parsed && findEntry(located, parsed), value = entry && entryValue(files, entry);
    if (!entry || !value || !parsed || parsed.chain.length || !ts.isPropertyAssignment(value.parent) || !ts.isObjectLiteralExpression(value.parent.parent)) throw new EditError(422, "This declaration is computed or nested. Disconnect it and remove its owning declaration in source.");
    const file = assertWritable(root, toRelative(root, entry.file));
    overrides.set(file, removeProperty(files.text(file), files.get(file), value.parent.parent, value.parent));
  }
  if (!target.directory) return [];
  const directory = path.resolve(root, target.kind === "agent" ? target.directory.slice(1) : `cdk-app${target.directory}`);
  const others = models.flatMap(model => model.targets).filter(item => item.ref !== targetRef && item.directory).map(item => path.resolve(root, item.kind === "agent" ? item.directory!.slice(1) : `cdk-app${item.directory}`));
  if (others.some(other => other === directory || other.startsWith(directory + path.sep) || directory.startsWith(other + path.sep))) throw new EditError(422, "This implementation directory is shared. Separate its source ownership before removal.");
  const changes: { file: string; before: string; after: null }[] = [];
  let total = 0;
  const visit = (folder: string): void => {
    if (!existsSync(folder)) return;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isSymbolicLink() || lstatSync(file).isSymbolicLink()) throw new EditError(422, "Archive contains a symbolic link. Archive this source manually before removing its declaration.");
      if (entry.isDirectory()) { if (["node_modules", ".git", ".cache"].includes(entry.name)) throw new EditError(422, "Remove local dependencies/cache from this implementation directory before reviewing its source archive."); visit(file); continue; }
      const relative = toRelative(root, file), archive = `archived-workloads/${target.kind}/${target.id}/${path.relative(directory, file).replaceAll("\\", "/")}`;
      assertCreationFile(root, relative); const destination = assertCreationFile(root, archive);
      const bytes = readFileSync(file); total += bytes.length;
      if (changes.length >= 250 || total > 5_000_000 || bytes.includes(0) || !Buffer.from(bytes.toString("utf8")).equals(bytes)) throw new EditError(422, "This implementation needs a manual source archive (binary or large file set). No files were changed.");
      const text = bytes.toString("utf8");
      if (existsSync(destination) && readFileSync(destination, "utf8") !== text) throw new EditError(422, `Archive destination ${archive} contains different user code. Choose source ownership in your editor before removal.`);
      overrides.set(destination, text); changes.push({ file, before: text, after: null });
    }
  };
  visit(directory);
  return changes;
}
