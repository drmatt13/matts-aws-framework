/**
 * A synthesized template's resource dependency graph, as CloudFormation orders
 * it: an edge for every Ref, Fn::GetAtt and Fn::Sub reference to another
 * resource, and for every DependsOn.
 *
 * CDK refuses a cycle between stacks at synthesis, but a cycle between
 * resources inside one stack is only found by CloudFormation, at deploy time,
 * as "Circular dependency between resources". This finds it in a test instead.
 */
export interface TemplateJson {
  readonly Resources: Record<string, { readonly Type: string; readonly Properties?: unknown; readonly DependsOn?: string | readonly string[] }>;
}

export function resourceGraph(template: TemplateJson): Map<string, Set<string>> {
  const ids = new Set(Object.keys(template.Resources));
  const graph = new Map<string, Set<string>>();
  for (const [id, resource] of Object.entries(template.Resources)) {
    const edges = new Set<string>();
    const add = (target: string): void => {
      if (ids.has(target) && target !== id) edges.add(target);
    };
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (value === null || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "Ref" && typeof child === "string") add(child);
        else if (key === "Fn::GetAtt") add(Array.isArray(child) ? String(child[0]) : String(child).split(".")[0]);
        else if (key === "Fn::Sub") {
          const text = Array.isArray(child) ? String(child[0]) : String(child);
          for (const match of text.matchAll(/\$\{([A-Za-z0-9]+)(?:\.[^}]*)?\}/g)) add(match[1]);
          if (Array.isArray(child)) walk(child[1]);
        } else walk(child);
      }
    };
    walk(resource.Properties);
    for (const dependency of [resource.DependsOn ?? []].flat()) add(dependency);
    graph.set(id, edges);
  }
  return graph;
}

/** A cycle in the graph, as the logical ids along it, or undefined. */
export function findCycle(graph: ReadonlyMap<string, ReadonlySet<string>>): readonly string[] | undefined {
  const done = new Set<string>();
  const visit = (id: string, trail: readonly string[]): readonly string[] | undefined => {
    if (trail.includes(id)) return [...trail.slice(trail.indexOf(id)), id];
    if (done.has(id)) return undefined;
    for (const next of graph.get(id) ?? []) {
      const cycle = visit(next, [...trail, id]);
      if (cycle) return cycle;
    }
    done.add(id);
    return undefined;
  };
  for (const id of graph.keys()) {
    const cycle = visit(id, []);
    if (cycle) return cycle;
  }
  return undefined;
}

/** Whether `from` reaches `to` through any chain of references. */
export function reaches(graph: ReadonlyMap<string, ReadonlySet<string>>, from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === to && id !== from) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of graph.get(id) ?? []) stack.push(next);
  }
  return false;
}
