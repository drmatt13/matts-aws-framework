import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { TETHER } from "../deploy/process";
import { buildArchitectureProjector } from "./architecture-preview-runner";
import { AgentTaskStore } from "./store";
import { readSourceManifest } from "./workspace";
import { readAgentRuntimeRelease, releaseHash, type AgentRuntimeRelease } from "./runtime-release-manifest";

/** Pin the executable control plane before admitting source changes. No live
 * package symlink or TypeScript loader is retained by the detached host. */
export async function pinAgentRuntime(root: string, state: string): Promise<AgentRuntimeRelease> {
  const store = new AgentTaskStore(state, root); store.close(); // Validates private canonical state and checkout identity.
  const before = readSourceManifest(root).digest;
  const buildRoot = path.resolve(__dirname, "../../.."), buildBefore = readSourceManifest(buildRoot).digest;
  const protocolSource = await readFile(path.join(buildRoot, "framework-studio/shared/agent-runtime.ts"), "utf8");
  const protocol = Number(/export const AGENT_RUNTIME_VERSION = (\d+) as const;/.exec(protocolSource)?.[1]);
  if (!Number.isSafeInteger(protocol) || protocol < 1) throw new Error("The target agent protocol could not be verified before pinning.");
  const [host, projector, tether] = await Promise.all([
    build({ entryPoints: [path.join(__dirname, "host.ts")], bundle: true, platform: "node", format: "cjs", target: "node24", write: false, metafile: true, external: ["esbuild"], logLevel: "silent" }),
    buildArchitectureProjector(), readFile(TETHER),
  ]);
  const imports = Object.values(host.metafile!.outputs).flatMap(output => output.imports.filter(item => item.external).map(item => item.path));
  if (imports.some(name => !name.startsWith("node:") && name !== "esbuild") || host.outputFiles.length !== 1) throw new Error("The agent host has an unpinned runtime dependency.");
  if (before !== readSourceManifest(root).digest || buildBefore !== readSourceManifest(buildRoot).digest) throw new Error("Studio source changed while pinning its agent runtime. Retry after saved source is stable.");
  const contents = { "host.cjs": Buffer.from(host.outputFiles[0]!.contents), "projector.cjs": projector.bytes, "tether.mjs": tether };
  const files = Object.fromEntries(Object.entries(contents).map(([name, bytes]) => [name, releaseHash(bytes)]));
  const digest = releaseHash(JSON.stringify({ version: 1, protocol, files }));
  const releases = path.join(state, "releases"); await mkdir(releases, { recursive: true, mode: 0o700 });
  const final = path.join(releases, digest);
  try { return readAgentRuntimeRelease(final); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = await mkdtemp(path.join(releases, ".building-"));
  try {
    for (const [name, bytes] of Object.entries(contents)) await writeFile(path.join(temporary, name), bytes, { flag: "wx", mode: 0o400 });
    await writeFile(path.join(temporary, "release.json"), JSON.stringify({ version: 1, protocol, files, digest }), { flag: "wx", mode: 0o400 });
    try { await rename(temporary, final); }
    catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    return readAgentRuntimeRelease(final);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
