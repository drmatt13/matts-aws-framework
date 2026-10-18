import { performance } from "node:perf_hooks";
import path from "node:path";
import { SnapshotBuilder } from "../server/snapshot";
import { buildScene } from "../src/scene/build";
import { measureSceneLayout } from "../src/scene/layout-quality";

void (async () => {
  const builder = new SnapshotBuilder(path.resolve(__dirname, "../.."));
  try {
    const snapshot = (await builder.refresh()).snapshot;
    const results = [];
    for (const mode of ["dev", "prod"] as const) for (const aspect of [16 / 9, 0.9]) {
      const options = { layoutModels: Object.values(snapshot.models), layoutSettings: { aspect } };
      const baseline = buildScene(snapshot.models[mode], { ...options, semanticLayout: true });
      const started = performance.now();
      const optimized = buildScene(snapshot.models[mode], options);
      const ms = performance.now() - started;
      const before = measureSceneLayout(baseline, aspect), after = measureSceneLayout(optimized, aspect);
      results.push({ mode, aspect, ms: Math.round(ms), evaluations: optimized.layout.evaluations, before, after });
    }
    process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  } finally { await builder.dispose(); }
})();
