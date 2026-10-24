import assert from "node:assert/strict";
import os from "node:os";
import { performance } from "node:perf_hooks";
import type { FrameworkConfig } from "@repo/framework/config";
import { projectModel } from "../server/model/project";

/** Projection only: synthetic declarations, no files, AWS, Docker or database. */
const option = (name: string, fallback: string) => process.argv.find(argument => argument.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
const sizes = option("--sizes", "100,500").split(",").map(Number);
const samples = Number(option("--samples", "3"));
assert.ok(sizes.every(size => Number.isInteger(size) && size > 0 && size <= 2000));
assert.ok(Number.isInteger(samples) && samples > 0 && samples <= 100);
const records: { size: number; sample: number; durationMs: number; declarationEnumerations: number; cpu: NodeJS.CpuUsage; rssBytes: number }[] = [];
for (const size of sizes) {
  let enumerations = 0;
  const declarations = Object.fromEntries(Array.from({ length: size }, (_, index) => [`/fixture-${index}`, { directory: `/lambda_functions/http_functions/fixture-${index}`, methods: ["GET"] }]));
  const config = {
    defaults: { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: {} } },
    http: new Proxy(declarations, { ownKeys(target) { enumerations++; return Reflect.ownKeys(target); } }),
    webSocket: {}, events: {}, services: {}, tasks: {}, workflows: {},
  } as FrameworkConfig;
  for (let sample = 0; sample < samples; sample++) {
    enumerations = 0;
    const cpu = process.cpuUsage(), started = performance.now();
    const model = projectModel(config, { mode: "dev" });
    assert.equal(model.targets.length, size);
    records.push({ size, sample, durationMs: performance.now() - started, declarationEnumerations: enumerations, cpu: process.cpuUsage(cpu), rssBytes: process.memoryUsage().rss });
  }
}
console.log(JSON.stringify({
  environment: { node: process.version, platform: process.platform, arch: process.arch, os: os.release(), cpu: os.cpus()[0]?.model, cores: os.cpus().length, memoryBytes: os.totalmem() },
  note: "Fresh declaration config per size; every projection refreshes its operation snapshots. First JIT-cold sample is included. This excludes source discovery, implementation health and browser rendering. RSS is a process snapshot, not retained heap.",
  summaries: sizes.map(size => {
    const values = records.filter(record => record.size === size).map(record => record.durationMs).sort((a, b) => a - b);
    return { size, samples: values.length, medianMs: values[Math.floor(values.length / 2)], maxMs: values.at(-1) };
  }),
  records,
}, null, 2));
