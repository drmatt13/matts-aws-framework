/** Opt-in native CLI probe. Only disposable source and sentinels are touched.
 * node --import tsx framework-studio/server/agent-runtime/providers/probe.ts --boundary-only
 * node --import tsx framework-studio/server/agent-runtime/providers/probe.ts --coding
 */
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executionPolicy, providerEnvironment } from "../policy";
import { CodexConnection, probeCodexBoundary, runCodex } from "./codex";
import { runClaude } from "./claude";
import { freezeAgentProposal, loadAgentWorkspace, prepareAgentWorkspace, readSourceManifest } from "../workspace";
import { frameworkValidationCommands, resolveValidationCommand, runValidation } from "./validation";

async function main() {
  const resumeAt = process.argv.indexOf("--resume-existing");
  if (resumeAt >= 0) {
    const selected = process.argv[resumeAt + 1], sessionAt = process.argv.indexOf("--session"), sessionId = process.argv[sessionAt + 1];
    if (!selected || !path.isAbsolute(selected) || sessionAt < 0 || !/^[A-Za-z0-9-]{8,100}$/.test(sessionId ?? "")) throw new Error("Resume requires an absolute disposable fixture and its saved native session id.");
    const directory = realpathSync(selected), temporary = realpathSync(tmpdir());
    if (path.dirname(directory) !== temporary || !path.basename(directory).startsWith("studio-native-agent-probe-")) throw new Error("Resume probes accept only an owned temporary native-agent fixture.");
    const cwd = realpathSync(path.join(directory, "candidate")), scratchDir = path.join(directory, "scratch"), before = readFileSync(path.join(cwd, "math.cjs"), "utf8");
    const provider = process.argv.includes("--claude") ? "claude" : "codex", controller = new AbortController(), cancel = process.argv.includes("--cancel");
    const owned: number[] = []; let cancellationRequested = false;
    const watchdog = setTimeout(() => controller.abort(), 120_000);
    try {
      const result = await (provider === "claude" ? runClaude : runCodex)({ provider, cwd, scratchDir, sessionId, signal: controller.signal,
        prompt: cancel
          ? "Do not modify source. Run this long-running disposable test command once and wait for it: node -e \"console.log('studio-cancellation-sentinel');setInterval(()=>{},1000)\". The host will cancel it."
          : "Continue the previous coding session. Inspect math.cjs, run node --test math.test.cjs and report the result. Do not change any source or install anything.",
        onExecution: identity => { owned.push(identity.pid); process.stdout.write(JSON.stringify({ phase: "owned_execution", identity }) + "\n"); },
        onEvent: event => {
          process.stdout.write(JSON.stringify(event) + "\n");
          if (cancel && event.type === "command" && event.data.phase === "started" && String(event.data.command).includes("studio-cancellation-sentinel")) {
            cancellationRequested = true; setTimeout(() => controller.abort(), 200);
          }
        }, approve: async () => true,
      }, executionPolicy(cwd, scratchDir));
      let ownedTethersStopped = true;
      for (const pid of owned) { try { process.kill(pid, 0); ownedTethersStopped = false; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") ownedTethersStopped = false; } }
      const sourceUnchanged = readFileSync(path.join(cwd, "math.cjs"), "utf8") === before;
      process.stdout.write(JSON.stringify({ result, cancellationRequested, ownedTethersStopped, sourceUnchanged }) + "\n");
      if (result.status !== (cancel ? "cancelled" : "completed") || cancel && !cancellationRequested || !ownedTethersStopped || !sourceUnchanged || result.sessionId !== sessionId) process.exitCode = 1;
    } finally { clearTimeout(watchdog); }
    return;
  }
  const existingAt = process.argv.indexOf("--validate-existing");
  if (existingAt >= 0) {
    const selected = process.argv[existingAt + 1];
    if (!selected || !path.isAbsolute(selected)) throw new Error("--validate-existing requires an absolute private task directory.");
    const workspace = loadAgentWorkspace(selected), scratchDir = path.join(workspace.directory, "validation-probe-scratch");
    const commands = process.argv.includes("--framework") ? frameworkValidationCommands(JSON.parse(readFileSync(path.join(workspace.workingDirectory, "package.json"), "utf8")).scripts, workspace.workingDirectory) : [{ file: "node", args: ["--conditions=development", "--import", "tsx", "--test", "math.test.cjs", "framework-studio/test/deployment-availability.test.ts"] }];
    if (!commands) throw new Error("This fixture does not declare the supported exact framework checks.");
    let exitCode = 0;
    for (const command of commands) {
      const result = await runValidation({ provider: "codex", cwd: workspace.workingDirectory, scratchDir, signal: new AbortController().signal,
        command: resolveValidationCommand(command), onEvent: event => { process.stdout.write(JSON.stringify(event) + "\n"); } });
      exitCode = result.exitCode; if (exitCode !== 0) break;
    }
    process.stdout.write(JSON.stringify({ validationExit: exitCode, capturedSourceDigest: workspace.baseline.digest, privateDependencyDigest: workspace.dependencyDigest }) + "\n");
    process.exitCode = exitCode === 0 ? 0 : 1;
    return;
  }
  if (!process.argv.includes("--boundary-only") && !process.argv.includes("--coding")) throw new Error("Choose --boundary-only or --coding explicitly. Coding uses your saved native CLI login.");
  const provider = process.argv.includes("--claude") ? "claude" : "codex";
  if (provider === "claude" && process.argv.includes("--boundary-only")) throw new Error("Claude boundary checks require a native model tool turn. Use --claude --coding.");
  const directory = mkdtempSync(path.join(tmpdir(), "studio-native-agent-probe-"));
  const repository = process.argv.includes("--current-repository") ? realpathSync(process.cwd()) : undefined;
  // Explicit opt-in captures saved dirty/untracked source with private dependencies.
  // Capture itself performs before/after consistency checks and never changes Git.
  const workspace = repository ? await prepareAgentWorkspace(repository, { storageDirectory: path.join(directory, "tasks"), taskId: "monorepo-probe" }) : undefined;
  const cwd = workspace?.workingDirectory ?? path.join(directory, "candidate"), scratchDir = path.join(directory, "scratch");
  if (!workspace) mkdirSync(cwd);
  mkdirSync(scratchDir);
  process.stdout.write(JSON.stringify({ phase: "prepared", directory, sourceDigest: workspace?.baseline.digest, dependencyDigest: workspace?.dependencyDigest, sourceFiles: workspace && Object.keys(workspace.baseline.files).length }) + "\n");
  const policy = executionPolicy(cwd, scratchDir);
  // Fake inputs exercise the same environment scrub used by production. The
  // native sentinel checks that none reach sandboxed descendants.
  policy.environment = { ...providerEnvironment(policy.scratchDir, { ...process.env, AWS_SECRET_ACCESS_KEY: "studio-disposable-credential", OPENAI_API_KEY: "studio-disposable-credential", DATABASE_URL: "studio-disposable-database" }), PATH: policy.environment.PATH };
  if (process.argv.includes("--boundary-only")) {
    const connection = new CodexConnection(policy, async () => {}, { isolatedConfig: process.argv.includes("--isolated-config") });
    try { await connection.initialize(); await probeCodexBoundary(connection, policy); process.stdout.write(JSON.stringify({ boundary: "passed", directory }) + "\n"); }
    finally { connection.transport.stop(); await connection.transport.closed; }
    return;
  }
  writeFileSync(path.join(cwd, "math.cjs"), "exports.add = (a, b) => a - b;\n");
  writeFileSync(path.join(cwd, "math.test.cjs"), "const test = require('node:test'); const assert = require('node:assert/strict'); const { add } = require('./math.cjs'); test('adds positive and negative values', () => { assert.equal(add(4, 3), 7); assert.equal(add(-4, 3), -1); });\n");
  const result = await (provider === "codex" ? runCodex : runClaude)({ provider, cwd, scratchDir, signal: new AbortController().signal,
    prompt: "Run node --test math.test.cjs first and observe the failure. Repair math.cjs without weakening the test, then run the test again and report the outcome. Do not use Git or install anything." +
      (workspace ? " This is a private copy of the developer's current monorepo, including saved dirty/untracked files and private node_modules. Also run node --conditions=development --import tsx --test framework-studio/test/deployment-availability.test.ts using its copied dependencies and @repo/framework workspace link. Do not edit any other source." : ""),
    onEvent: event => { process.stdout.write(JSON.stringify(event) + "\n"); },
    // Only this deliberately disposable source fixture may approve shell work.
    // runClaude still refuses requests outside its immutable maximum policy.
    approve: async () => true,
  }, policy);
  process.stdout.write(JSON.stringify({ result, directory, source: readFileSync(path.join(cwd, "math.cjs"), "utf8") }) + "\n");
  if (result.status === "completed") {
    const validation = await runValidation({ provider: "codex", cwd, scratchDir, signal: new AbortController().signal,
      command: resolveValidationCommand({ file: "node", args: workspace
        ? ["--conditions=development", "--import", "tsx", "--test", "math.test.cjs", "framework-studio/test/deployment-availability.test.ts"]
        : ["--test", "math.test.cjs"] }),
      onEvent: event => { process.stdout.write(JSON.stringify(event) + "\n"); } });
    if (workspace) {
      const proposal = await freezeAgentProposal(workspace), liveUnchanged = readSourceManifest(repository!).digest === workspace.baseline.digest;
      process.stdout.write(JSON.stringify({ validationExit: validation.exitCode, proposal: proposal.changes.map(change => change.path), liveUnchanged }) + "\n");
      if (!liveUnchanged) process.exitCode = 1;
    } else process.stdout.write(JSON.stringify({ validationExit: validation.exitCode }) + "\n");
    if (validation.exitCode !== 0) process.exitCode = 1;
  }
  if (result.status !== "completed") process.exitCode = 1;
}
void main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : "Probe failed"}\n`); process.exitCode = 1; });
