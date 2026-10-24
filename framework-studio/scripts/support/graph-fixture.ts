import type { Mode, ModeModel, ModelEdge, ModelResource, ModelRoute, ModelTarget } from "../../shared/model";

/** Deterministic presentation-only stress fixture. Never evaluated, saved or deployed. */
export function graphFixture(size: number, mode: Mode = "dev"): ModeModel {
  if (!Number.isInteger(size) || size < 3) throw new Error("Graph fixture size must be an integer of at least three entities.");
  const count = Math.floor(size / 3);
  const targets: ModelTarget[] = Array.from({ length: count }, (_, at) => ({
    ref: `lambda:fixture-${at}`, kind: "lambda", id: `fixture-${at}`, role: "http", title: `Fixture handler ${at}`,
    origins: [`http[\"/fixture/${at}\"]`], constructId: `Fixture${at}`, constructIdPinned: false,
    lanes: { deploy: "both", origin: "declared", local: true, cloud: true, dev: true, prod: true },
    compute: { kind: "lambda", implementation: "typescript", packaging: "zip", runtime: "nodejs24.x", architecture: "arm64", memorySize: 256, timeoutSeconds: 30, logRetentionDays: 7, subnet: "none" },
    placement: { kind: "outside", reason: "Synthetic benchmark fixture" }, environment: [], secrets: [], access: [], requirements: 0, outputs: [],
  }));
  const routes: ModelRoute[] = targets.map((target, at) => ({ id: `route:http:/fixture/${at}`, kind: "http", path: `/fixture/${at}`, browserPath: `/api/fixture/${at}`, auth: false, target: target.ref, origin: target.origins[0]! }));
  const resources: ModelResource[] = Array.from({ length: size - count * 2 }, (_, at) => ({ id: `resource:fixture${at}`, kind: "stack", path: [`fixture${at}`], stackClass: `FixtureStack${at}`, absent: false }));
  const edges: ModelEdge[] = [];
  const add = (relation: ModelEdge["relation"], from: string, to: string, label: string) => edges.push({ id: `${relation}:${from}->${to}#${edges.length}`, relation, from, to, provenance: "declared", label });
  for (const [at, target] of targets.entries()) {
    add("routes", routes[at]!.id, target.ref, "Routes to");
    add("grant", target.ref, resources[at % resources.length]!.id, "grantRead");
    add("grant", target.ref, resources[(at * 7 + 3) % resources.length]!.id, "grantWrite");
  }
  return { mode, status: "ok", targets, routes, resources, edges, workflows: [], fields: {}, diagnostics: [], evaluatedInMs: 0 };
}
