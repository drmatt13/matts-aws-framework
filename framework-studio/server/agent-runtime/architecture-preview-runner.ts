import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ArchitecturePreview } from "../../shared/architecture-preview";
import type { Mode } from "../../shared/model";
import { architectureDigest, ARCHITECTURE_PREVIEW_ARTIFACT_MARKER, ARCHITECTURE_PREVIEW_MARKER, ARCHITECTURE_PREVIEW_LIMIT, ARCHITECTURE_PREVIEW_LIMITATIONS, compareArchitectureEvaluations, parseArchitectureEvaluation } from "./architecture-preview";
import { readEvaluationArtifact } from "../evaluator/result-artifact";
import { loadAgentProposal, materializeAgentRevision, readSourceManifest, type AgentProposal, type AgentWorkspace } from "./workspace";
import { runValidation, type ValidationOptions, type ValidationResult } from "./providers/validation";
import type { ProviderOptions } from "./providers/types";

export interface ArchitecturePreviewOptions {
  readonly workspace: AgentWorkspace;
  readonly proposal: AgentProposal;
  readonly signal: AbortSignal;
  readonly onExecution?: ProviderOptions["onExecution"];
  /** Pinned control-plane release asset; never supplied by a task request. */
  readonly projectorAsset?: { readonly file: string; readonly digest: string };
  /** Test seam. Production must retain the native restricted command boundary. */
  readonly run?: (options: ValidationOptions) => Promise<ValidationResult>;
}

/** Capture at control-plane release creation, before executing candidate code. */
export async function buildArchitectureProjector(): Promise<{ bytes: Buffer; digest: string }> {
  const { build } = await import("esbuild");
  const worker = fileURLToPath(new URL("./architecture-preview-worker.ts", import.meta.url));
  const result = await build({ bundle: true, platform: "node", format: "cjs", target: "node22", write: false, logLevel: "silent",
    stdin: { contents: `const [mode, inputs, artifact] = process.argv.slice(2); if (!['dev','prod'].includes(mode) || !inputs || !artifact) throw new Error('Invalid architecture mode or output'); process.env.FRAMEWORK_MODE=mode; process.env.FRAMEWORK_INPUTS_FILE=inputs; require(${JSON.stringify(worker)}).runArchitectureWorker(mode, artifact);`, resolveDir: path.dirname(worker), loader: "js" },
    plugins: [{ name: "candidate-framework-singleton", setup(builder) {
      builder.onResolve({ filter: /^@repo\/framework\/config$/ }, () => ({ path: "candidate-framework", namespace: "candidate-framework" }));
      builder.onLoad({ filter: /.*/, namespace: "candidate-framework" }, () => ({ contents: `module.exports = require('node:module').createRequire(require('node:path').join(process.cwd(), 'package.json'))('@repo/framework/config');`, loader: "js" }));
      builder.onResolve({ filter: /packages\/framework\/src\/database-pool$/ }, () => ({ path: "candidate-database-pool", namespace: "candidate-database-pool" }));
      builder.onLoad({ filter: /.*/, namespace: "candidate-database-pool" }, () => ({ contents: `module.exports = require('node:module').createRequire(require('node:path').join(process.cwd(), 'package.json'))('@repo/framework/config');`, loader: "js" }));
    } }],
  });
  if (result.outputFiles?.length !== 1) throw new Error("Could not pin the architecture projection toolchain.");
  const bytes = Buffer.from(result.outputFiles[0]!.contents);
  return { bytes, digest: architectureDigest(bytes) };
}

/** Large models travel in a bounded scratch file; stdout carries only its receipt. */
export function readArchitecturePreviewArtifact(output: string, file: string, mode: Mode) {
  if (Buffer.byteLength(output) > ARCHITECTURE_PREVIEW_LIMIT) throw new Error("Architecture worker output exceeds the byte limit.");
  const records = output.split("\n").filter(line => line.startsWith(ARCHITECTURE_PREVIEW_ARTIFACT_MARKER));
  if (records.length !== 1 || records[0]!.length > 1024) throw new Error("Architecture worker returned no unique bounded artifact receipt.");
  const receipt: unknown = JSON.parse(records[0]!.slice(ARCHITECTURE_PREVIEW_ARTIFACT_MARKER.length));
  const json = readEvaluationArtifact(file, receipt, ARCHITECTURE_PREVIEW_LIMIT - 1024);
  return parseArchitectureEvaluation(`${ARCHITECTURE_PREVIEW_MARKER}${json}\n`, mode);
}
async function pinnedProjector(directory: string, asset?: ArchitecturePreviewOptions["projectorAsset"]): Promise<{ file: string; digest: string }> {
  const compiled = asset ? { bytes: await readFile(asset.file), digest: asset.digest } : await buildArchitectureProjector();
  if (architectureDigest(compiled.bytes) !== compiled.digest) throw new Error("The pinned architecture projector changed. Restart from a verified control-plane release.");
  const { bytes, digest } = compiled, file = path.join(directory, "projector.cjs");
  await writeFile(file, bytes, { flag: "wx", mode: 0o400 });
  for (const mode of ["dev", "prod"] as const) await writeFile(path.join(directory, `${mode}.env`), `PROD_DEPLOYMENT=${mode === "prod" ? "true" : "false"}\n`, { flag: "wx", mode: 0o400 });
  return { file, digest };
}

/** Evaluates immutable revisions, with no live snapshot caches or condition broker. */
export async function runArchitecturePreview(options: ArchitecturePreviewOptions): Promise<ArchitecturePreview> {
  const { workspace, signal } = options;
  const proposal = loadAgentProposal(options.proposal.directory);
  const identity = { version: 1 as const, proposalDigest: proposal.digest, baselineDigest: proposal.baselineDigest, candidateDigest: proposal.candidateDigest, dependencyDigest: workspace.dependencyDigest };
  const unavailable = (reason: string): ArchitecturePreview => ({ ...identity, status: "unavailable", modes: [], limitations: ARCHITECTURE_PREVIEW_LIMITATIONS, reason });
  if (proposal.digest !== options.proposal.digest || proposal.taskId !== workspace.taskId || proposal.baselineDigest !== workspace.baseline.digest) return unavailable("The immutable proposal no longer matches this task.");
  if (!Object.hasOwn(workspace.baseline.files, "framework.config.ts") && !proposal.changes.some(change => change.path === "framework.config.ts" && change.after)) return unavailable("This project has no framework declaration to preview.");
  if (!workspace.dependencyDigest) return unavailable("A captured private dependency tree is required for architecture evaluation.");
  if (proposal.changes.some(change => /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(change.path))) return unavailable("Dependency manifests changed. Re-provision and attest private dependencies before architecture evaluation.");
  if (signal.aborted) return unavailable("Architecture preview was cancelled.");
  const directory = path.join(workspace.directory, "architecture", randomUUID());
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const toolchain = path.join(directory, "toolchain"); await mkdir(toolchain, { mode: 0o700 });
    const projector = await pinnedProjector(toolchain, options.projectorAsset);
    const baseline = path.join(directory, "baseline"), candidate = path.join(directory, "candidate");
    await materializeAgentRevision(workspace, baseline);
    await materializeAgentRevision(workspace, candidate, proposal);
    const evaluate = async (revision: string, mode: Mode) => {
      if (signal.aborted) throw new Error("Architecture preview was cancelled.");
      const scratchDir = path.join(directory, `${path.basename(revision)}-${mode}-scratch`); await mkdir(scratchDir, { mode: 0o700 });
      const artifactFile = path.join(scratchDir, "architecture.json");
      const localRequire = createRequire(path.join(revision, "package.json"));
      const loader = realpathSync(localRequire.resolve("tsx"));
      if (!loader.startsWith(`${revision}${path.sep}`)) throw new Error("The preview loader escaped its private dependency tree.");
      const result = await (options.run ?? runValidation)({ provider: "codex", cwd: revision, scratchDir,
        command: { file: realpathSync(process.execPath), args: ["--import", loader, projector.file, mode, path.join(toolchain, `${mode}.env`), artifactFile] },
        signal, onExecution: options.onExecution, onEvent: async () => {}, readOnlyCwd: true, readPaths: [toolchain], timeoutMs: 30_000, outputBytesCap: ARCHITECTURE_PREVIEW_LIMIT });
      if (result.exitCode !== 0) throw new Error(`Restricted ${mode} architecture evaluation exited with ${result.exitCode}.`);
      return readArchitecturePreviewArtifact(result.stdout, artifactFile, mode);
    };
    const modes = [];
    for (const mode of ["dev", "prod"] as const) modes.push(compareArchitectureEvaluations(await evaluate(baseline, mode), await evaluate(candidate, mode)));
    if (readSourceManifest(baseline).digest !== proposal.baselineDigest || readSourceManifest(candidate).digest !== proposal.candidateDigest) throw new Error("Read-only architecture source changed during evaluation.");
    return { ...identity, toolchainDigest: projector.digest, status: modes.every(mode => mode.status === "ready") ? "ready" : modes.every(mode => mode.status === "unavailable") ? "unavailable" : "partial", modes, limitations: ARCHITECTURE_PREVIEW_LIMITATIONS };
  } catch (error) { return unavailable(error instanceof Error ? error.message : "Restricted architecture evaluation failed."); }
}
