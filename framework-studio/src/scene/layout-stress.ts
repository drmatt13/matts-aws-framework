import type { Point } from "./camera";

/**
 * Weighted stress majorization over island centres.
 *
 * Islands are few (usually under twenty), so the layout works on the complete distance matrix:
 * every pair gets an ideal separation, the graph-theoretic distance along connections whose
 * own length shrinks as the connection strengthens. Majorization (SMACOF) then moves each
 * island to the weighted average of where every other island says it should be. It is
 * deterministic, needs no step size and converges monotonically, unlike a force simulation.
 *
 * Distances are layout units, where an isometric diamond is close to a square, so one ideal
 * length serves every direction; exact projected shapes are enforced separately.
 */
export interface StressGraph {
  readonly size: number;
  /** Ideal centre distance for every pair, row-major. */
  readonly distance: Float64Array;
  /** Majorization weight for every pair, row-major: near pairs and strong links count most. */
  readonly weight: Float64Array;
}
export interface StressLink { readonly a: number; readonly b: number; readonly strength: number }

/**
 * Ideal distances: adjacent islands want their rims a little apart, more for weak links;
 * other pairs take the shortest path through such links. Pairs in different components rest
 * a fixed margin apart with little weight, so an unconnected island settles on the periphery
 * of the arrangement instead of drifting away from it.
 */
export function stressGraph(radius: readonly number[], links: readonly StressLink[], gap: number): StressGraph {
  const n = radius.length, distance = new Float64Array(n * n).fill(Infinity), weight = new Float64Array(n * n);
  const strongest = Math.max(1e-9, ...links.map((link) => link.strength));
  const bonus = new Float64Array(n * n);
  for (let i = 0; i < n; i++) distance[i * n + i] = 0;
  for (const { a, b, strength } of links) {
    if (a === b) continue;
    const share = strength / strongest;
    const length = radius[a]! + radius[b]! + gap + 10 / (1 + 3 * share);
    if (length < distance[a * n + b]!) distance[a * n + b] = distance[b * n + a] = length;
    bonus[a * n + b] = bonus[b * n + a] = Math.max(bonus[a * n + b]!, Math.sqrt(share));
  }
  // Floyd–Warshall: the island graph is small.
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) {
    const ik = distance[i * n + k]!;
    if (ik === Infinity) continue;
    for (let j = 0; j < n; j++) {
      const through = ik + distance[k * n + j]!;
      if (through < distance[i * n + j]!) distance[i * n + j] = through;
    }
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (i === j) continue;
    const at = i * n + j;
    const apart = distance[at] === Infinity;
    if (apart) distance[at] = radius[i]! + radius[j]! + gap * 3;
    // Kamada–Kawai weighting, with direct links counted up to twice and strangers lightly.
    weight[at] = (apart ? 0.15 : 1 + bonus[at]!) / distance[at]! ** 2;
  }
  return { size: n, distance, weight };
}

/**
 * Classical MDS by power iteration: a deterministic starting arrangement that already
 * reflects the whole distance matrix, so majorization begins near a good basin.
 */
export function classicalScaling(graph: StressGraph): Point[] {
  const { size: n, distance } = graph;
  if (n === 1) return [{ x: 0, y: 0 }];
  const squared = new Float64Array(n * n), row = new Float64Array(n);
  let total = 0;
  for (let at = 0; at < n * n; at++) { squared[at] = distance[at]! ** 2; row[Math.floor(at / n)] += squared[at]!; total += squared[at]!; }
  const b = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) b[i * n + j] = -0.5 * (squared[i * n + j]! - row[i]! / n - row[j]! / n + total / (n * n));
  // Shift by a Gershgorin bound so the largest eigenvalue of B is also the dominant one.
  let shift = 0;
  for (let i = 0; i < n; i++) { let sum = 0; for (let j = 0; j < n; j++) sum += Math.abs(b[i * n + j]!); shift = Math.max(shift, sum); }
  const vectors: Float64Array[] = [], values: number[] = [];
  for (let k = 0; k < 2; k++) {
    let v = Float64Array.from({ length: n }, (_, i) => Math.cos(i * 1.618 + k * 0.7) + 0.01 * i);
    for (let iteration = 0; iteration < 200; iteration++) {
      const next = new Float64Array(n);
      for (let i = 0; i < n; i++) { let sum = shift * v[i]!; for (let j = 0; j < n; j++) sum += b[i * n + j]! * v[j]!; next[i] = sum; }
      for (const other of vectors) { let dot = 0; for (let i = 0; i < n; i++) dot += next[i]! * other[i]!; for (let i = 0; i < n; i++) next[i] -= dot * other[i]!; }
      let norm = 0; for (let i = 0; i < n; i++) norm += next[i]! ** 2;
      norm = Math.sqrt(norm);
      if (norm < 1e-12) break;
      for (let i = 0; i < n; i++) next[i] /= norm;
      v = next;
    }
    let value = 0;
    for (let i = 0; i < n; i++) { let sum = 0; for (let j = 0; j < n; j++) sum += b[i * n + j]! * v[j]!; value += v[i]! * sum; }
    vectors.push(v); values.push(Math.max(0, value));
  }
  return Array.from({ length: n }, (_, i) => ({ x: vectors[0]![i]! * Math.sqrt(values[0]!), y: vectors[1]![i]! * Math.sqrt(values[1]!) }));
}

export interface MajorizeOptions {
  readonly iterations: number;
  /** Islands that never move. */
  readonly fixed?: readonly boolean[];
  /** A pull toward a remembered centre, for stability across edits. */
  readonly anchors?: readonly ({ readonly point: Point; readonly weight: number } | undefined)[];
  /** Runs after each sweep; non-overlap and other projections belong here. */
  readonly project?: (positions: Point[], iteration: number) => void;
}
/** Localized SMACOF (Gauss–Seidel), in a fixed island order for reproducible results. */
export function majorize(graph: StressGraph, start: readonly Point[], options: MajorizeOptions): Point[] {
  const { size: n, distance, weight } = graph;
  const positions = start.map((p) => ({ x: p.x, y: p.y }));
  for (let iteration = 0; iteration < options.iterations; iteration++) {
    for (let i = 0; i < n; i++) {
      if (options.fixed?.[i]) continue;
      const anchor = options.anchors?.[i];
      let x = anchor ? anchor.point.x * anchor.weight : 0, y = anchor ? anchor.point.y * anchor.weight : 0, total = anchor?.weight ?? 0;
      const p = positions[i]!;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const q = positions[j]!, w = weight[i * n + j]!, d = distance[i * n + j]!;
        let dx = p.x - q.x, dy = p.y - q.y, length = Math.hypot(dx, dy);
        // Coincident islands separate along a fixed, index-derived direction.
        if (length < 1e-9) { dx = Math.cos(i * 2.399 + j); dy = Math.sin(i * 2.399 + j); length = 1; }
        x += w * (q.x + d * dx / length); y += w * (q.y + d * dy / length); total += w;
      }
      if (total > 0) positions[i] = { x: x / total, y: y / total };
    }
    options.project?.(positions, iteration);
  }
  return positions;
}

/** Weighted stress, normalized so different arrangements of one graph compare directly. */
export function stress(graph: StressGraph, positions: readonly Point[]): number {
  const { size: n, distance, weight } = graph;
  let sum = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const p = positions[i]!, q = positions[j]!;
    sum += weight[i * n + j]! * (Math.hypot(p.x - q.x, p.y - q.y) - distance[i * n + j]!) ** 2;
  }
  return sum;
}
