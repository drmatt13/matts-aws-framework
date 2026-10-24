import assert from "node:assert/strict";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { getFrameworkTargets, type FrameworkConfig } from "../src/config/index";
import { assertTargetArtifacts, createTargetArtifactValidator, type TargetSourceHost } from "../src/config/source";

/** Synthetic source-artifact work only; no filesystem writes, AWS or database. */
const option = (name: string, fallback: string) => process.argv.find(argument => argument.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
const sizes = option("--sizes", "20,100,500").split(",").map(Number);
const samples = Number(option("--samples", "5"));
assert.ok(sizes.every(size => Number.isInteger(size) && size > 0 && size <= 2000));
assert.ok(Number.isInteger(samples) && samples > 0 && samples <= 100);
const standalone = process.argv.includes("--standalone");
const host: TargetSourceHost = { exists: () => true, isDirectory: () => true, realpath: file => file, entries: () => ["index.ts"] };
const records: { size: number; sample: number; warmup: boolean; durationMs: number; cpu: NodeJS.CpuUsage; rssBytes: number }[] = [];
for (const size of sizes) {
  const config = {
    defaults: { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: {} } },
    http: Object.fromEntries(Array.from({ length: size }, (_, index) => [`/fixture-${index}`, { directory: `/lambda_functions/http_functions/fixture-${index}`, methods: ["GET"] }])),
    webSocket: {}, events: {}, services: {}, tasks: {}, workflows: {},
  } as FrameworkConfig;
  for (let sample = 0; sample <= samples; sample++) {
    const cpu = process.cpuUsage(), started = performance.now();
    const targets = getFrameworkTargets(config);
    const check = standalone
      ? (target: typeof targets[number], directory: string) => assertTargetArtifacts(config, target, directory, host)
      : createTargetArtifactValidator(config, host);
    for (const target of targets) check(target, `/fixture/${target.id}`);
    records.push({ size, sample, warmup: sample === 0, durationMs: performance.now() - started, cpu: process.cpuUsage(cpu), rssBytes: process.memoryUsage().rss });
  }
}
console.log(JSON.stringify({
  environment: { node: process.version, platform: process.platform, arch: process.arch, os: os.release(), cpu: os.cpus()[0]?.model, cores: os.cpus().length, memoryBytes: os.totalmem() },
  mode: standalone ? "standalone-per-target" : "batch-per-operation",
  note: "First sample per size warms the process and is excluded from summaries. This measures in-memory source validation, not disk access or whole generation. RSS is a process snapshot, not retained heap.",
  summaries: sizes.map(size => {
    const values = records.filter(record => record.size === size && !record.warmup).map(record => record.durationMs).sort((a, b) => a - b);
    return { size, samples: values.length, medianMs: values[Math.floor(values.length / 2)], maxMs: values.at(-1) };
  }),
  records,
}, null, 2));
