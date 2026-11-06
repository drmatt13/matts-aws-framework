import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { TETHER } from "../../deploy/process";
import { randomUUID } from "node:crypto";

/** Bounded, sequential JSONL transport. A failed durable consumer stops execution. */
export class JsonLinesProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<number | null>;
  /** Process teardown without waiting for a pending UI permission callback. */
  readonly exited: Promise<number | null>;
  private queue = Promise.resolve();
  private pending = "";
  private readonly decoder = new StringDecoder("utf8");
  private failed?: Error;
  private stopping = false;
  private outputBytes = 0;
  private stderrPrefix = "";
  constructor(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
    private readonly receive: (message: Record<string, any>) => Promise<void>,
    private readonly diagnostic: (text: string) => Promise<void>) {
    // The tether owns the native process group and kills it on stdin EOF even
    // when this host is killed. Only the tether signals its still-owned group.
    this.child = spawn(process.execPath, [TETHER, "--forward-input", file, ...args], { cwd, env, shell: false, windowsHide: true, stdio: "pipe" });
    this.exited = new Promise(resolve => { this.child.once("close", resolve); });
    this.closed = new Promise(resolve => {
      this.child.once("error", error => { this.fail(error); });
      this.child.once("close", code => {
        this.pending += this.decoder.end();
        if (this.pending.trim() && !this.failed) this.consume(this.pending);
        this.queue.finally(() => { resolve(code); });
      });
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.outputBytes += chunk.length;
      if (this.outputBytes > 32 * 1024 * 1024) return this.fail(new Error("Provider output exceeded the 32 MiB task limit."));
      this.pending += this.decoder.write(chunk);
      if (this.pending.length > 2 * 1024 * 1024) return this.fail(new Error("Provider JSON frame exceeded the 2 MiB limit."));
      let at: number;
      while ((at = this.pending.indexOf("\n")) >= 0) {
        const line = this.pending.slice(0, at); this.pending = this.pending.slice(at + 1);
        if (line.trim()) this.consume(line);
      }
    });
    // Retain a bounded prefix only in memory. Expose classifications, never raw
    // provider stderr: configuration errors can include account/secret values.
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.outputBytes += chunk.length;
      if (this.stderrPrefix.length < 8192) this.stderrPrefix += chunk.toString("utf8").slice(0, 8192 - this.stderrPrefix.length);
      if (this.outputBytes > 32 * 1024 * 1024) this.fail(new Error("Provider output exceeded the task limit."));
    });
    this.child.stdin.on("error", error => { if (!this.stopping) this.fail(error); });
  }
  private consume(line: string) {
    this.child.stdout.pause();
    this.queue = this.queue.then(async () => {
      if (this.failed) return;
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid provider JSON message.");
      await this.receive(parsed as Record<string, any>);
    }).catch(error => this.fail(error instanceof Error ? error : new Error("Provider event persistence failed.")))
      // Even after failure drain the OS pipe: child `close` waits for its stdio
      // EOF. Leaving stdout paused can deadlock cancellation after the process
      // and every descendant are already gone. Failed consumers remain skipped.
      .finally(() => { this.child.stdout.resume(); });
  }
  send(message: unknown) { if (!this.stopping && !this.child.stdin.destroyed) this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  executionIdentity() {
    if (!this.child.pid || process.platform === "win32") throw new Error("Provider execution identity is unavailable.");
    const result = spawnSync("/bin/ps", ["-p", String(this.child.pid), "-o", "uid=", "-o", "lstart="], {
      encoding: "utf8", timeout: 3000, env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" }, windowsHide: true,
    });
    const match = result.status === 0 && /^(\d+)\s+(.+)$/.exec(result.stdout.trim());
    if (!match || typeof process.getuid !== "function" || Number(match[1]) !== process.getuid()) throw new Error("Provider process identity could not be verified.");
    return { pid: this.child.pid, uid: Number(match[1]), started: match[2].replace(/\s+/g, " ").trim(), token: randomUUID() };
  }
  error() { return this.failed; }
  setupFailure() {
    const text = this.stderrPrefix;
    const categories: string[] = [];
    if (/unknown feature|unrecognized feature/i.test(text)) categories.push("unsupported feature");
    if (/unexpected argument|unrecognized option|unknown option/i.test(text)) categories.push("unsupported argument");
    if (/missing field|did not match any variant|invalid type/i.test(text)) categories.push("invalid configuration schema");
    if (/parse|invalid.*override|toml/i.test(text)) categories.push("configuration parsing");
    if (/permission denied|operation not permitted|EACCES|EPERM/i.test(text)) categories.push("operating system permission denied");
    if (/No such file|ENOENT|not found/i.test(text)) categories.push("required executable or file unavailable");
    if (/dyld|library not loaded/i.test(text)) categories.push("runtime library unavailable");
    if (/panicked|abort|stack trace/i.test(text)) categories.push("native runtime failure");
    return categories.length ? categories.join(", ") : text ? "unclassified native startup diagnostic (details withheld)" : "no native diagnostic";
  }
  fail(error: Error) { if (!this.failed) { this.failed = error; void this.diagnostic(error.message).catch(() => {}); } this.stop(); this.child.stdout.resume(); }
  stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.child.stdin.end();
  }
}
