import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export interface AssemblyArtifact {
  type: string;
  environment?: string;
  dependencies?: string[];
  properties?: { templateFile?: string; stackName?: string; directoryName?: string; file?: string };
  metadata?: Record<string, { type: string; data: unknown }[]>;
  additionalMetadataFile?: string;
}
export interface AssemblyStack {
  /** Manifest-relative artifact identity, including nested assembly scopes. */
  id: string;
  artifact: AssemblyArtifact;
  directory: string;
  dependencies: string[];
  template: Record<string, any>;
  metadata: NonNullable<AssemblyArtifact["metadata"]>;
  treePaths: ReadonlyMap<string, readonly string[]>;
}

/** Manifest paths are data, never permission to read outside the selected assembly. */
export function assemblyFile(root: string, directory: string, name: string): string {
  if (isAbsolute(name)) throw new Error("An assembly file must use a relative path.");
  const file = realpathSync(resolve(directory, name));
  const inside = relative(realpathSync(root), file);
  if (inside.startsWith("..") || isAbsolute(inside)) throw new Error("An assembly file resolves outside the selected assembly.");
  return file;
}

/** Shared by deployment inspection and Studio. Only manifest-listed artifacts are read. */
export function readAssemblyStacks(directory: string, options: { includeNestedStacks?: boolean } = {}): AssemblyStack[] {
  const root = realpathSync(directory);
  const visited = new Set<string>();
  const stacks: AssemblyStack[] = [];
  const visit = (at: string, prefix: string, inheritedTree: ReadonlyMap<string, readonly string[]> = new Map()): void => {
    const real = realpathSync(at);
    if (visited.has(real)) throw new Error("The cloud assembly contains a repeated or cyclic nested assembly.");
    visited.add(real);
    const manifest = JSON.parse(readFileSync(assemblyFile(root, at, "manifest.json"), "utf8"));
    if (!manifest.artifacts || typeof manifest.artifacts !== "object" || Array.isArray(manifest.artifacts)) throw new Error("The assembly manifest has no artifact table.");
    let treePaths = inheritedTree;
    const tree = (Object.values(manifest.artifacts) as AssemblyArtifact[]).find((artifact) => artifact.type === "cdk:tree");
    if (tree?.properties?.file) {
      const document = JSON.parse(readFileSync(assemblyFile(root, at, tree.properties.file), "utf8"));
      const paths = new Map<string, string[]>();
      const walk = (node: any): void => {
        const id = node?.attributes?.["aws:cdk:cloudformation:logicalId"];
        if (typeof id === "string" && typeof node.path === "string") paths.set(id, [...(paths.get(id) ?? []), node.path]);
        Object.values(node?.children ?? {}).forEach(walk);
      };
      walk(document.tree);
      treePaths = paths;
    }
    const assets: { path: string; keys: string[] }[] = [];
    if (options.includeNestedStacks) for (const artifact of Object.values(manifest.artifacts) as AssemblyArtifact[]) {
      if (artifact.type !== "cdk:asset-manifest" || !artifact.properties?.file) continue;
      const document = JSON.parse(readFileSync(assemblyFile(root, at, artifact.properties.file), "utf8"));
      for (const asset of Object.values(document.files ?? {}) as any[]) if (typeof asset.source?.path === "string") {
        assets.push({ path: asset.source.path, keys: Object.values(asset.destinations ?? {}).flatMap((destination: any) => typeof destination.objectKey === "string" ? [destination.objectKey] : []) });
      }
    }
    const addStack = (stack: AssemblyStack, ancestors = new Set<string>()): void => {
      stacks.push(stack);
      if (!options.includeNestedStacks) return;
      for (const [id, resource] of Object.entries(stack.template.Resources ?? {}) as [string, any][]) {
        if (resource.Type !== "AWS::CloudFormation::Stack") continue;
        const direct = resource.Metadata?.["aws:asset:property"] === "TemplateURL" ? resource.Metadata?.["aws:asset:path"] : undefined;
        const url = JSON.stringify(resource.Properties?.TemplateURL ?? "");
        const matches = assets.filter((asset) => asset.keys.some((key) => key.length > 0 && url.includes(key)));
        // Follow explicit template asset evidence, never unrelated files or a remote URL.
        const asset = typeof direct === "string" ? direct : matches.length === 1 ? matches[0]!.path : undefined;
        if (!asset) continue;
        const file = assemblyFile(root, at, asset);
        if (ancestors.has(file)) throw new Error("Cyclic nested CloudFormation stack templates.");
        addStack({ ...stack, id: `${stack.id}/${id}`, dependencies: [], template: JSON.parse(readFileSync(file, "utf8")),
          artifact: { ...stack.artifact, properties: { ...stack.artifact.properties, stackName: `${stack.artifact.properties?.stackName ?? stack.id}/${id}`, templateFile: asset } } }, new Set([...ancestors, file]));
      }
    };
    for (const [name, artifact] of Object.entries(manifest.artifacts) as [string, AssemblyArtifact][]) {
      if (artifact.type === "cdk:cloud-assembly") {
        if (!artifact.properties?.directoryName) throw new Error(`Nested assembly ${name} has no directory.`);
        visit(assemblyFile(root, at, artifact.properties.directoryName), `${prefix}${name}/`, treePaths);
      } else if (artifact.type === "aws:cloudformation:stack") {
        if (!artifact.properties?.templateFile) throw new Error(`Stack ${name} has no template.`);
        const template = JSON.parse(readFileSync(assemblyFile(root, at, artifact.properties.templateFile), "utf8"));
        const extra = artifact.additionalMetadataFile
          ? JSON.parse(readFileSync(assemblyFile(root, at, artifact.additionalMetadataFile), "utf8")) : {};
        const metadata = { ...artifact.metadata };
        for (const [path, records] of Object.entries(extra) as [string, NonNullable<AssemblyArtifact["metadata"]>[string]][]) {
          metadata[path] = [...new Map([...(metadata[path] ?? []), ...records].map((record) => [JSON.stringify(record), record])).values()];
        }
        addStack({ id: `${prefix}${name}`, artifact, directory: at, template, treePaths,
          dependencies: (artifact.dependencies ?? []).map((id) => `${prefix}${id}`),
          metadata });
      }
    }
  };
  visit(root, "");
  return stacks;
}
