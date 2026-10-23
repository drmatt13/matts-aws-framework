import { spawn } from "node:child_process";
import { cpSync, existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { writeModeInputs } from "../inputs";
import { sha256, toRelative } from "../files";
import { EditError } from "./io";

/** Generator-owned output only. Creation runs the real generator; these files
 * are never authored by templates or accepted as HTTP write destinations. */
export function isCreationGeneratedFile(relative: string): boolean {
  return /^packages\/framework\/src\/generated\/(?:target-ids|agentcore|event-replay|vpc-endpoint-services)\.ts$/.test(relative)
    || /^packages\/api-contract\/src\/generated\/(?:framework-(?:contracts|routes)|contracts\/[A-Za-z0-9_-]+)\.ts$/.test(relative)
    || relative === "docker-compose.services.yml"
    || /^cdk-app\/ecs_containers\/(?:[A-Za-z0-9_-]+\/)+\.env\.example$/.test(relative)
    || relative === "package-lock.json";
}
function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: false });
    let output = "";
    let stdout = "";
    const append = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-6000); };
    child.stdout.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString("utf8")).slice(-6000); append(chunk); }); child.stderr.on("data", append);
    const timeout = setTimeout(() => { child.kill(); reject(new EditError(422, "Creation artifact generation timed out. Nothing was written.")); }, 90_000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => { clearTimeout(timeout); if (code === 0) resolve(stdout); else reject(new EditError(422, `Creation artifact generation failed. ${output.trim()}`)); });
  });
}
/** A private copy contains authored source and manifests, never authored env
 * values, dependencies, database artifacts or deployment outputs. Generation
 * writes there first so its exact results join the same review and journal. */
export async function generateCreationArtifacts(root: string, overrides: ReadonlyMap<string, string>, removedSourceFiles: readonly string[] = []): Promise<{ overrides: Map<string, string>; before: Map<string, string | null>; inputs: Record<string, string>; deletions: Map<string, string> }> {
  const parent = path.join(root, ".cache/framework-studio/previews");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, "creation-"));
  const skip = new Set(["node_modules", ".git", ".cache", ".framework", "cdk.out", "dist", "build", "coverage"]);
  const filter = (source: string): boolean => {
    const name = path.basename(source);
    return !skip.has(name) && (!name.startsWith(".env") || name === ".env.example");
  };
  try {
    for (const relative of ["framework.config.ts", "framework-config", "cdk-app/lambda_functions", "cdk-app/ecs_containers", "agents", "packages/framework/src/generated", "packages/api-contract/src/generated", "package.json", "package-lock.json", "docker-compose.yml", "docker-compose.services.yml"]) {
      const source = path.join(root, relative);
      if (existsSync(source)) cpSync(source, path.join(directory, relative), { recursive: true, filter, dereference: false });
    }
    // npm's lockfile generator must see every workspace manifest, including
    // workspaces unrelated to the new resource, so it cannot drop their links.
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { workspaces: string[] };
    for (const relative of globSync(manifest.workspaces.map((pattern) => `${pattern}/package.json`), { cwd: root })) {
      const destination = path.join(directory, relative);
      mkdirSync(path.dirname(destination), { recursive: true });
      cpSync(path.join(root, relative), destination);
    }
    const inputs: Record<string, string> = {};
    const baseline = new Map<string, string>();
    const capture = (folder: string): void => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new EditError(422, "Creation generation cannot read linked source files.");
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) capture(file);
        else if (entry.isFile()) {
          const text = readFileSync(file, "utf8");
          inputs[toRelative(directory, file)] = sha256(text);
          if (isCreationGeneratedFile(toRelative(directory, file))) baseline.set(toRelative(directory, file), text);
        }
      }
    };
    capture(directory);
    for (const file of removedSourceFiles) {
      const removed = path.join(directory, toRelative(root, file)); rmSync(removed, { force: true });
      for (let folder = path.dirname(removed); folder !== directory; folder = path.dirname(folder)) { try { rmdirSync(folder); } catch { break; } }
    }
    for (const [file, text] of overrides) {
      const destination = path.join(directory, toRelative(root, file));
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, text);
    }
    const env = { ...process.env, FRAMEWORK_MODE: "dev", FRAMEWORK_INPUTS_FILE: writeModeInputs(directory, "dev") };
    if ([...overrides.keys()].some((file) => path.basename(file) === "package.json")) {
      // npm 10 loses native libc metadata. Refuse it before touching the copy.
      const npm = process.env.npm_execpath;
      const command = npm ? process.execPath : "npm";
      const prefix = npm ? [npm] : [];
      const version = await run(command, [...prefix, "--version"], directory, env);
      if (!version.trim().startsWith("11.")) throw new EditError(422, "Start Studio with npm 11 to preserve native lockfile metadata.");
      await run(command, [...prefix, "install", "--package-lock-only", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], directory, env);
    }
    // Resolve the implementation from this running Studio, even when its
    // repository target is a disposable integration-test copy.
    const generator = path.resolve(__dirname, "../../..", "packages/framework/scripts/generate-contracts.ts");
    await run(process.execPath, ["--import", "tsx", generator, "--repository-root", directory], directory, env);
    const result = new Map<string, string>();
    const before = new Map<string, string | null>();
    const visit = (folder: string): void => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (skip.has(entry.name) || entry.isSymbolicLink()) continue;
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (entry.isFile()) {
          const relative = toRelative(directory, file);
          if (!isCreationGeneratedFile(relative)) continue;
          const text = readFileSync(file, "utf8");
          const original = baseline.get(relative) ?? null;
          if (original !== text) { result.set(path.join(root, relative), text); before.set(path.join(root, relative), original); }
        }
      }
    };
    visit(directory);
    const deletions = new Map<string, string>();
    for (const [relative, bytes] of baseline) if (!existsSync(path.join(directory, relative))) deletions.set(path.join(root, relative), bytes);
    return { overrides: result, before, inputs, deletions };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
