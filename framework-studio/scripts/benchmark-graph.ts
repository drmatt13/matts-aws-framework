import { performance } from "node:perf_hooks";
import os from "node:os";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildScene } from "../src/scene/build";
import { layoutBoard } from "../src/layout";
import { indexModel } from "../src/lookup";
import { searchScene } from "../src/scene/focus";
import { graphFixture } from "./support/graph-fixture";

// One process per invocation makes the cold sample independent of module caches.
// Usage: node --import tsx framework-studio/scripts/benchmark-graph.ts [size|snapshot.json] [samples]
const fixture = process.argv[2] ?? "100", samples = Number(process.argv[3] ?? 5);
if (!Number.isInteger(samples) || samples < 1) throw new Error("Sample count must be a positive integer.");
const input = /^\d+$/.test(fixture) ? undefined : JSON.parse(readFileSync(fixture, "utf8"));
const model = input ? (input.snapshot ?? input).models.dev as ReturnType<typeof graphFixture> : graphFixture(Number(fixture));
const size = model.targets.length + model.routes.length + model.resources.length;
const timed = <T>(run: () => T): { ms: number; value: T } => { const start = performance.now(); const value = run(); return { ms: performance.now() - start, value }; };
const initial = timed(() => buildScene(model));
const results = Array.from({ length: samples }, () => {
  const board = timed(() => layoutBoard(model));
  const scene = timed(() => buildScene(model, { layoutSettings: { previous: initial.value.layout.positions, previousKey: initial.value.layout.topologyKey } }));
  const index = timed(() => indexModel(model));
  const search = timed(() => searchScene(scene.value, model, "fixture 7"));
  return { boardMs: board.ms, retainedSceneMs: scene.ms, indexMs: index.ms, searchMs: search.ms, evaluations: scene.value.layout.evaluations };
});
const summarize = (key: "boardMs" | "retainedSceneMs" | "indexMs" | "searchMs") => {
  const values = results.map(row => row[key]).sort((a, b) => a - b);
  return { medianMs: values[Math.floor(values.length / 2)], maxMs: values.at(-1) };
};
process.stdout.write(JSON.stringify({ environment: { node: process.version, platform: os.platform(), release: os.release(), architecture: os.arch(), cpu: os.cpus()[0]?.model, cpuCount: os.cpus().length, totalMemory: os.totalmem() }, fixture, size, edges: model.edges.length, renderedNodes: initial.value.nodes.length, tiles: initial.value.tiles.length, routeHash: createHash("sha256").update(JSON.stringify(initial.value.routes)).digest("hex"), coldSceneMs: initial.ms, samples, summary: { board: summarize("boardMs"), retainedScene: summarize("retainedSceneMs"), index: summarize("indexMs"), search: summarize("searchMs") }, memory: process.memoryUsage(), results }, null, 2) + "\n");
