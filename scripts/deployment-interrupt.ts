import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";

/**
 * How the deploy wrapper stops when it is interrupted.
 *
 * The first Ctrl+C stops the step that is running and refuses to start another,
 * so a deployment never begins after the developer asked to stop, even when the
 * signal arrives between steps (while secrets synchronize, say). The step's
 * failure unwinds the wrapper's own cleanup. A second Ctrl+C kills the step,
 * cleans up at once and exits.
 */

export interface InterruptOptions {
  readonly spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  readonly exit?: (code: number) => void;
  readonly log?: (line: string) => void;
}

const INTERRUPTED = "Deployment was interrupted.";

export class DeploymentInterrupt {
  /** Work an immediate exit must still undo: the temporary assembly, the lock. */
  readonly cleanups = new Set<() => void>();
  private interrupted = false;
  private current: ChildProcess | undefined;

  constructor(private readonly options: InterruptOptions = {}) {}

  get isInterrupted(): boolean {
    return this.interrupted;
  }

  handle(signal: NodeJS.Signals): void {
    if (!this.interrupted) {
      this.interrupted = true;
      (this.options.log ?? console.error)("Interrupted. No further step will start. If CloudFormation had already started a deployment, it continues in AWS: check the stacks before deploying again.");
      this.current?.kill(signal);
      return;
    }
    this.current?.kill("SIGKILL");
    for (const cleanup of this.cleanups) {
      try { cleanup(); } catch { /* Best effort on the way out. */ }
    }
    (this.options.exit ?? process.exit)(130);
  }

  assertContinuing(): void {
    if (this.interrupted) throw new Error(INTERRUPTED);
  }

  /** Capture review evidence while preserving the ordinary live diagnostic log. */
  capture(file: string, args: readonly string[], cwd: string): Promise<{ code: number | null; output: string }> {
    this.assertContinuing();
    return new Promise((accept, reject) => {
      const child = (this.options.spawn ?? nodeSpawn)(process.execPath, [file, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
      this.current = child;
      let output = "";
      const collect = (chunk: Buffer) => { output += chunk.toString(); process.stdout.write(chunk); };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.once("error", () => { this.current = undefined; reject(new Error("Unable to start deployment review tooling.")); });
      child.once("exit", (code) => {
        this.current = undefined;
        if (this.interrupted) reject(new Error(INTERRUPTED));
        else accept({ code, output });
      });
    });
  }

  /** Runs a Node script to completion; refuses to start once interrupted. */
  run(file: string, args: readonly string[], cwd: string): Promise<void> {
    if (this.interrupted) return Promise.reject(new Error(INTERRUPTED));
    return new Promise((accept, reject) => {
      const child = (this.options.spawn ?? nodeSpawn)(process.execPath, [file, ...args], { cwd, stdio: "inherit", env: process.env });
      this.current = child;
      child.once("error", () => { this.current = undefined; reject(new Error("Unable to start deployment tooling.")); });
      child.once("exit", (code) => {
        this.current = undefined;
        if (code === 0 && !this.interrupted) accept();
        else reject(new Error(this.interrupted ? INTERRUPTED : `Deployment tooling exited with status ${code}.`));
      });
    });
  }
}
