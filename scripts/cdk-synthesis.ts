import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

export interface CdkSynthesisRequest {
  repositoryRoot: string;
  outputDirectory: string;
  context: Readonly<Record<string, string | boolean>>;
  environment?: NodeJS.ProcessEnv;
  profile?: string;
  timeoutMs?: number;
}
/** Synthesis only. Mode/input policy belongs to the caller; no deployment or secret synchronization. */
export function runCdkSynthesis(request: CdkSynthesisRequest): Promise<void> {
  const cdk = createRequire(path.join(request.repositoryRoot, "cdk-app/package.json")).resolve("aws-cdk/bin/cdk");
  const args = [cdk, "synth", "--quiet", "--output", request.outputDirectory,
    ...(request.profile ? ["--profile", request.profile] : []),
    ...Object.entries(request.context).flatMap(([key, value]) => ["--context", `${key}=${value}`])];
  return new Promise((accept, reject) => {
    let output = "";
    let timedOut = false;
    const child = spawn(process.execPath, args, { cwd: path.join(request.repositoryRoot, "cdk-app"),
      env: { ...process.env, ...request.environment, FORCE_COLOR: "0", NO_COLOR: "1" }, shell: false, windowsHide: true });
    const append = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-32_000); };
    child.stdout.on("data", append); child.stderr.on("data", append);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, request.timeoutMs ?? 10 * 60_000);
    child.once("error", () => { clearTimeout(timer); reject(new Error("Unable to start the local CDK CLI.")); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) accept();
      else {
        const clean = output.replace(/\u001b\[[0-9;]*m/g, "");
        const errors = clean.split(/\r?\n/).filter((line) => /^\s*(?:[\w.]*Error:|ERROR\b|\[ERROR\]|✘|\[Error at)/.test(line)).slice(-8).join("\n");
        reject(new Error(timedOut ? "Synthesis exceeded its time limit." : `CDK synthesis failed (exit ${code ?? "unknown"}).\n${errors || clean.slice(-3000)}`));
      }
    });
  });
}
