import { readAssemblyStacks } from "./cloud-assembly";

import { INFRASTRUCTURE_OWNER, type InfrastructureOwner, type InfrastructureInventory } from "./infrastructure-types";
export type { InfrastructureOwner, InfrastructureInventory, InfrastructureResource } from "./infrastructure-types";

export function infrastructureId(stack: string, logicalId: string, environment = "unresolved"): string {
  return `infra:${encodeURIComponent(environment)}:${encodeURIComponent(stack)}:${encodeURIComponent(logicalId)}`;
}
function owner(value: unknown): value is InfrastructureOwner {
  const v = value as InfrastructureOwner | undefined;
  return !!v && typeof v.entity === "string" && /^(lambda|service|task|workflow|agent|resource|route|island):/.test(v.entity) && ["primary", "supporting"].includes(v.role);
}

/** A values-free inventory. Raw template properties, outputs and metadata never leave this reader. */
export function inspectInfrastructureAssembly(directory: string): InfrastructureInventory {
  const stacks = readAssemblyStacks(directory, { includeNestedStacks: true });
  const result: InfrastructureInventory = { version: 1, stacks: [], resources: [], dependencies: [], notes: [] };
  const exports = new Map<string, string | undefined>();
  const pendingImports: { from: string; name: string; environment: string }[] = [];
  for (const stack of stacks) {
    const declarations = Object.entries(stack.metadata).flatMap(([path, records]) => records
      .filter((record) => record.type === INFRASTRUCTURE_OWNER && owner(record.data))
      .map((record) => ({ path: path.replace(/^\//, ""), owner: record.data as InfrastructureOwner })));
    const resources = Object.entries(stack.template.Resources ?? {}) as [string, Record<string, any>][];
    const environment = stack.artifact.environment ?? "unresolved";
    const ids = new Map(resources.map(([id]) => [id, infrastructureId(stack.id, id, environment)]));
    const paths = new Map<string, string>();
    for (const [path, records] of Object.entries(stack.metadata)) for (const record of records) {
      if (record.type === "aws:cdk:logicalId" && typeof record.data === "string") paths.set(record.data, path.replace(/^\//, ""));
    }
    const paintedPaths = resources.map(([id, resource]) => resource.Metadata?.["aws:cdk:path"] ?? paths.get(id)).filter((path): path is string => typeof path === "string");
    const stackDeclarations = declarations.filter((entry) => entry.owner.stack && paintedPaths.length > 0 && paintedPaths.every((path) => path === entry.path || path.startsWith(`${entry.path}/`)));
    const stackOwners = stackDeclarations.filter((entry) => entry.path.length === Math.max(...stackDeclarations.map((entry) => entry.path.length))).map((entry) => entry.owner.entity);
    result.stacks.push({ id: stack.id, name: stack.artifact.properties?.stackName ?? stack.id, environment: stack.artifact.environment ?? "unresolved",
      dependencies: stack.dependencies.filter((id) => stacks.some((candidate) => candidate.id === id)), owners: [...new Set(stackOwners)].sort() });
    const reference = (from: string, id: string, kind: "reference" | "depends-on" = "reference") => {
      const to = ids.get(id);
      if (to && to !== from) result.dependencies.push({ from, to, kind });
    };
    const scan = (from: string, value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach((child) => scan(from, child)); return; }
      const object = value as Record<string, unknown>;
      if (typeof object.Ref === "string") reference(from, object.Ref);
      const get = object["Fn::GetAtt"];
      if (typeof get === "string") reference(from, get.split(".")[0]!);
      else if (Array.isArray(get) && typeof get[0] === "string") reference(from, get[0]);
      const sub = object["Fn::Sub"];
      const text = typeof sub === "string" ? sub : Array.isArray(sub) ? sub[0] : undefined;
      const variables = Array.isArray(sub) && sub[1] && typeof sub[1] === "object" ? sub[1] : {};
      if (typeof text === "string") for (const match of text.matchAll(/\$\{([^!}][^}]*)\}/g)) {
        if (!(match[1]! in variables)) reference(from, match[1]!.split(".")[0]!);
      }
      if (typeof object["Fn::ImportValue"] === "string") pendingImports.push({ from, name: object["Fn::ImportValue"], environment });
      Object.values(object).forEach((child) => scan(from, child));
    };
    for (const [logicalId, resource] of resources) {
      const tree = stack.treePaths.get(logicalId);
      const path = typeof resource.Metadata?.["aws:cdk:path"] === "string" ? resource.Metadata["aws:cdk:path"] : paths.get(logicalId) ?? (tree?.length === 1 ? tree[0] : undefined);
      const associated = path ? declarations.filter((entry) => path === entry.path || path.startsWith(`${entry.path}/`)) : [];
      // A stack's catalog identity is ownership of the stack, not of every child service.
      const specific = associated.filter((entry) => !entry.owner.stack);
      const nearest = specific.filter((entry) => entry.path.length === Math.max(...specific.map((entry) => entry.path.length)));
      const primary = nearest.some((entry) => entry.owner.role === "primary" && (path === entry.path || path === `${entry.path}/Resource`));
      result.resources.push({ id: ids.get(logicalId)!, stack: stack.id, logicalId, type: typeof resource.Type === "string" ? resource.Type : "Unknown",
        ...(path ? { constructPath: path } : {}), ...(typeof resource.Condition === "string" ? { condition: resource.Condition } : {}),
        classification: nearest.length ? primary ? "framework" : "supporting" : "unowned", owners: [...new Set(nearest.map((entry) => entry.owner.entity))].sort() });
      const depends = resource.DependsOn;
      for (const id of typeof depends === "string" ? [depends] : Array.isArray(depends) ? depends : []) if (typeof id === "string") reference(ids.get(logicalId)!, id, "depends-on");
      scan(ids.get(logicalId)!, resource.Properties);
    }
    for (const entry of declarations.filter((entry) => entry.owner.external)) {
      if (result.resources.some((resource) => resource.stack === stack.id && resource.constructPath && (resource.constructPath === entry.path || resource.constructPath.startsWith(`${entry.path}/`)))) continue;
      result.resources.push({ id: infrastructureId(stack.id, `external:${entry.path}`, environment), stack: stack.id, type: "External reference", constructPath: entry.path,
        classification: "imported", owners: [entry.owner.entity] });
    }
    for (const output of Object.values(stack.template.Outputs ?? {}) as Record<string, any>[]) {
      if (typeof output.Export?.Name !== "string") continue;
      const referenced = typeof output.Value?.Ref === "string" ? output.Value.Ref : output.Value?.["Fn::GetAtt"]?.[0];
      if (typeof referenced === "string" && ids.has(referenced)) {
        const key = `${environment}:${output.Export.Name}`;
        const id = ids.get(referenced)!;
        exports.set(key, exports.has(key) && exports.get(key) !== id ? undefined : id);
      }
    }
  }
  for (const entry of pendingImports) {
    const to = exports.get(`${entry.environment}:${entry.name}`);
    if (to) result.dependencies.push({ from: entry.from, to, kind: "import" });
  }
  result.dependencies = [...new Map(result.dependencies.map((edge) => [`${edge.from}:${edge.to}:${edge.kind}`, edge])).values()];
  result.resources.sort((a, b) => a.id.localeCompare(b.id));
  if (result.resources.some((resource) => resource.classification === "unowned")) result.notes.push("Resources without explicit framework metadata retain unknown ownership. Construct paths are synthesis evidence, not TypeScript source locations.");
  result.notes.push("CloudFormation dependencies describe infrastructure references and ordering, not application invocation or data flow. Conditional resources retain their condition; deployment status is not queried.");
  result.notes.push("Dynamic cross-stack export names and remote nested-stack templates cannot be resolved without additional evidence. Imported references are listed only when explicitly identified during synthesis.");
  return result;
}
