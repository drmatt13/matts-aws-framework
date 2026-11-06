import path from "node:path";
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { executionPolicy } from "../policy";
import { CodexConnection, probeCodexBoundary } from "./codex";
import type { AgentProvider, ProviderEvent, ProviderOptions } from "./types";
import { installedNpm } from "./toolchain";
import { emitText } from "./events";

export interface ValidationOptions {
  provider: AgentProvider;
  cwd: string;
  scratchDir: string;
  command: { file: string; args: string[] };
  signal: AbortSignal;
  onEvent: (event: ProviderEvent) => void | Promise<void>;
  onExecution?: ProviderOptions["onExecution"];
  /** Host-owned evaluator closure only. Never accept these grants from a task. */
  readOnlyCwd?: boolean;
  readPaths?: string[];
  timeoutMs?: number;
  outputBytesCap?: number;
}
export interface ValidationResult { exitCode: number; stdout: string; stderr: string; outputTruncated?: boolean }

/** Preserve this repository's exact framework checks without tsx CLI's Unix
 * socket launcher. Custom scripts and npm lifecycle hooks keep their npm path.
 * The supported Node loader executes both authored entries in the same sandbox.
 */
export function frameworkValidationCommands(scripts: Record<string, unknown> | undefined, cwd: string): { file: string; args: string[] }[] | undefined {
  if (!scripts || scripts["framework:check"] !== "tsx packages/framework/scripts/generate-contracts.ts --check && tsx packages/framework/scripts/check-local.ts"
    || Object.hasOwn(scripts, "preframework:check") || Object.hasOwn(scripts, "postframework:check")) return undefined;
  const entries = ["packages/framework/scripts/generate-contracts.ts", "packages/framework/scripts/check-local.ts"];
  try {
    const root = realpathSync(cwd);
    for (const entry of entries) {
      const file = path.join(root, entry), stat = lstatSync(file);
      if (!stat.isFile() || stat.nlink !== 1 || realpathSync(file) !== file) return undefined;
    }
  } catch { return undefined; }
  return entries.map((entry, index) => ({ file: "node", args: ["--import", "tsx", entry, ...(index === 0 ? ["--check"] : [])] }));
}

export function resolveValidationCommand(command: { file: string; args: string[] }): { file: string; args: string[] } {
  if (command.file === "npm") return { file: process.execPath, args: [installedNpm().entry, ...command.args] };
  if (command.file === "node" || command.file === process.execPath) return { file: process.execPath, args: [...command.args] };
  throw new Error("Final validation supports only the installed Node and npm executables.");
}

/** Uses the native command sandbox; never directly spawns authored project code. */
export async function runValidation(options: ValidationOptions): Promise<ValidationResult> {
  if (options.provider !== "codex") throw new Error("Independent validation currently requires the verified Codex sandbox.");
  if (options.signal.aborted) throw new Error("Validation cancelled.");
  if (!path.isAbsolute(options.command.file)) throw new Error("Validation requires an absolute trusted executable path.");
  const timeoutMs = options.timeoutMs ?? 10 * 60_000, requestedCap = options.outputBytesCap ?? 32_768;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60_000 || !Number.isSafeInteger(requestedCap) || requestedCap < 1 || requestedCap > 8 * 1024 * 1024) throw new Error("Validation limits are invalid.");
  // Installed native command/exec empirically stalls at >=64KiB captured output.
  // Large trusted projections use a scratch artifact and a small JSON receipt.
  const outputBytesCap = Math.min(requestedCap, 32_768);
  const policy = executionPolicy(options.cwd, options.scratchDir, { readOnlyCwd: options.readOnlyCwd, readPaths: options.readPaths });
  const command = [options.command.file === process.execPath ? path.join(policy.runtimeDirectory, "node") : options.command.file, ...options.command.args];
  const connection = new CodexConnection(policy, async () => {}, { isolatedConfig: true });
  let activeProcessId: string | undefined, stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    if (activeProcessId) await connection.request("command/exec/terminate", { processId: activeProcessId }, 1500).catch(() => {});
    connection.transport.stop(); await connection.transport.closed;
  })();
  const abort = () => { void stop(); };
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    if (options.onExecution) await options.onExecution(connection.transport.executionIdentity());
    await connection.initialize();
    await probeCodexBoundary(connection, policy);
    await options.onEvent({ type: "command", data: { phase: "started", validation: true, command: [options.command.file, ...options.command.args], cwd: policy.cwd } });
    if (options.signal.aborted) throw new Error("Validation cancelled.");
    activeProcessId = randomUUID();
    const result = await connection.request("command/exec", { command, cwd: policy.cwd, processId: activeProcessId,
      permissionProfile: policy.profile, env: policy.commandEnvironment, timeoutMs, outputBytesCap }, timeoutMs + 5000);
    activeProcessId = undefined;
    if (typeof result.exitCode !== "number") throw new Error("Validation returned no exit status.");
    const stdout = String(result.stdout ?? ""), stderr = String(result.stderr ?? "");
    const value = { exitCode: result.exitCode, stdout, stderr, outputTruncated: Buffer.byteLength(stdout) >= outputBytesCap || Buffer.byteLength(stderr) >= outputBytesCap };
    await emitText(options.onEvent, "command", { phase: "output", validation: true }, "stdout", stdout);
    await emitText(options.onEvent, "command", { phase: "output", validation: true }, "stderr", stderr);
    await options.onEvent({ type: "command", data: { phase: "completed", validation: true, exitCode: value.exitCode, outputTruncated: value.outputTruncated } });
    return value;
  } finally {
    options.signal.removeEventListener("abort", abort); await stop();
  }
}
