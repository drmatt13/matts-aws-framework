import path from "node:path";
import ts from "typescript";
import { locateConfigSource } from "../../../packages/framework/scripts/config-source";
import type { DraftEdit } from "../../shared/api";
import type { StudioState } from "../snapshot";
import { SourceFiles, entryValue, findEntry } from "../source";
import { declarationObject, propertyAt, hasComments } from "../source/syntax";
import { parseOrigin } from "../model/origin";
import { assertWritable, toRelative } from "../files";
import { insertExpression } from "../resources-source";
import { removeProperty } from "./splice";
import { resourceAlias, addResourceImport } from "./resource-alias";
import { EditError } from "./io";

export function planDeploy(root: string, state: StudioState, edit: Extract<DraftEdit, { kind: "deploy" }>, overrides: Map<string, string>): void {
  const model = state.snapshot.models.dev;
  const target = model.targets.find(item => item.ref === edit.target);
  if (!target) throw new EditError(422, "Select a workload with an editable Deploy setting.");
  const value = edit.value;
  let resource: typeof model.resources[number] | undefined;
  if (typeof value === "string") {
    if (!["both", "local-only", "cloud-only", "none", "inherit"].includes(value)) throw new EditError(422, "Choose a supported deployment setting.");
  } else {
    if (!value || Object.keys(value).length !== 1 || !value.when || Object.keys(value.when).some(key => !["resource", "equals"].includes(key))) throw new EditError(422, "Choose one input and a matching value.");
    resource = model.resources.find(item => item.id === value.when.resource);
    const versions = Object.values(state.snapshot.models).map(graph => graph.resources.find(item => item.id === value.when.resource));
    if (!resource || resource.kind !== "input" || (!resource.fromEnv && resource.authoredValue === undefined) || versions.some(item => !item || item.absent)) throw new EditError(422, "Deployment conditions require a non-secret input declared in both environments.");
    if (typeof value.when.equals !== "string" || !value.when.equals.trim() || value.when.equals !== value.when.equals.trim() || resource.values && !resource.values.includes(value.when.equals)) throw new EditError(422, "Choose a non-empty matching value from the input's allowed values.");
  }
  for (const origin of target.origins) {
    const files = new SourceFiles(overrides), parsed = parseOrigin(origin);
    const located = locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root, host: files.host() });
    const entry = parsed && findEntry(located, parsed), expression = entry && entryValue(files, entry);
    if (!entry || !expression || !parsed) throw new EditError(422, "This workload declaration cannot be located.");
    const declaration = declarationObject(expression, parsed.section, parsed.chain);
    if ("unsupported" in declaration) throw new EditError(422, declaration.unsupported);
    const position = propertyAt(declaration.object, ["deploy"]);
    if (!["literal", "absent", "condition"].includes(position.editability.kind)) throw new EditError(422, "This Deploy setting is computed. Edit it in source.");
    const file = assertWritable(root, toRelative(root, entry.file)), source = files.get(file);
    let text = files.text(file);
    const { alias, imported } = resourceAlias(root, file, source, text);
    if (value === "inherit") {
      if (position.property) text = removeProperty(text, source, position.container, position.property);
    } else {
      const next = typeof value === "string" ? JSON.stringify(value) : `{ when: { resource: ${alias}${resource!.path.map(part => `[${JSON.stringify(part)}]`).join("")}, equals: ${JSON.stringify(value.when.equals)} } }`;
      if (position.property) {
        if (hasComments(position.property.initializer.getText(source))) throw new EditError(422, "This Deploy setting has comments. Edit it in source to preserve them.");
        text = text.slice(0, position.property.initializer.getStart(source)) + next + text.slice(position.property.initializer.end);
      } else text = insertExpression(text, source, position.container, position.missing, next);
      if (resource && !imported) text = addResourceImport(root, file, text, alias);
    }
    overrides.set(file, text);
  }
}
