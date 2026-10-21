import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * How Deploy & Run starts a program: a fixed file and argv, no shell, an
 * explicit working directory and a curated environment.
 *
 * Every repository command is the script its npm entry runs, started with the
 * same tsx. The AWS CLI and Docker are started by name, unless
 * FRAMEWORK_AWS_CLI / FRAMEWORK_DOCKER_CLI name a Node script to run in their
 * place (the tests' simulated account and engine).
 */

export interface CommandSpec {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** What the activity log shows: the command a person would type. */
  readonly display: string;
  /** Started through tether.mjs, so it stops when Studio does, however Studio ends. */
  readonly tethered?: boolean;
}

/** The wrapper that ties a program's life to Studio's: see tether.mjs. */
export const TETHER = path.join(__dirname, "tether.mjs");

/** The same command, run so that it cannot outlive Studio. */
export function tethered(spec: CommandSpec): CommandSpec {
  return { ...spec, file: process.execPath, args: [TETHER, spec.file, ...spec.args], tethered: true };
}

export interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the program could not be started at all (ENOENT). */
  readonly missing?: boolean;
}

/** Runs a command to completion and captures its output. Injected in tests. */
export type Runner = (spec: CommandSpec, options?: { timeoutMs?: number }) => Promise<CommandResult>;

/** Credentials a request must never carry into a child: the selected profile decides. */
const DROPPED = [
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN",
  "AWS_PROFILE", "AWS_DEFAULT_PROFILE",
  // The mode is CDK context, stated per command; a stale variable never decides it.
  "PROD_DEPLOYMENT", "FRAMEWORK_MODE",
  "npm_config_profile",
];

export function studioEnvironment(base: NodeJS.ProcessEnv, options: { readonly profile?: string } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of DROPPED) delete env[key];
  if (options.profile) env.AWS_PROFILE = options.profile;
  env.FORCE_COLOR = "0";
  env.NO_COLOR = "1";
  env.AWS_PAGER = "";
  env.FRAMEWORK_DEPLOY_VIA = "studio";
  return env;
}

export class Tools {
  readonly tsx: string;

  constructor(readonly root: string, private readonly env: NodeJS.ProcessEnv = process.env) {
    this.tsx = createRequire(path.join(root, "package.json")).resolve("tsx/cli");
  }

  /** A repository script, run as its npm entry runs it. */
  script(script: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd = this.root): CommandSpec {
    return { file: process.execPath, args: [this.tsx, path.join(this.root, script), ...args], cwd, env, display: `tsx ${script} ${args.join(" ")}`.trim() };
  }

  /** A plain Node script (dev.mjs is not TypeScript). */
  node(script: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd = this.root): CommandSpec {
    return { file: process.execPath, args: [path.join(this.root, script), ...args], cwd, env, display: `node ${script} ${args.join(" ")}`.trim() };
  }

  docker(args: readonly string[], env: NodeJS.ProcessEnv, cwd = this.root): CommandSpec {
    const fake = this.env.FRAMEWORK_DOCKER_CLI;
    return fake
      ? { file: process.execPath, args: [fake, ...args], cwd, env, display: `docker ${args.join(" ")}` }
      : { file: "docker", args, cwd, env, display: `docker ${args.join(" ")}` };
  }

  aws(args: readonly string[], env: NodeJS.ProcessEnv, cwd = this.root): CommandSpec {
    const fake = this.env.FRAMEWORK_AWS_CLI;
    return fake
      ? { file: process.execPath, args: [fake, ...args], cwd, env, display: `aws ${args.join(" ")}` }
      : { file: "aws", args, cwd, env, display: `aws ${args.join(" ")}` };
  }

  /**
   * npm, by its own entry script: Node refuses to start npm.cmd without a
   * shell on Windows, and a shell is what this module never uses.
   */
  npm(args: readonly string[], env: NodeJS.ProcessEnv, cwd = this.root): CommandSpec | undefined {
    const cli = npmCli(this.env);
    return cli ? { file: process.execPath, args: [cli, ...args], cwd, env, display: `npm ${args.join(" ")}` } : undefined;
  }
}

export function npmCli(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath): string | undefined {
  const bin = path.dirname(execPath);
  const candidates = [
    env.npm_execpath && /npm-cli\.js$/.test(env.npm_execpath) ? env.npm_execpath : undefined,
    path.join(bin, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    // Homebrew installs npm outside Node's own directory and links it as bin/npm beside node.
    linkedNpm(bin),
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
}

function linkedNpm(bin: string): string | undefined {
  if (process.platform === "win32") return undefined;
  try {
    const target = realpathSync(path.join(bin, "npm"));
    return /npm-cli\.js$/.test(target) ? target : undefined;
  } catch {
    return undefined;
  }
}

/** Starts a command with the module's rules: no shell, no window, its own process group on POSIX. */
export function start(spec: CommandSpec): ChildProcess {
  return spawn(spec.file, [...spec.args], {
    cwd: spec.cwd,
    env: spec.env,
    shell: false,
    windowsHide: true,
    // A tethered command is given a pipe it watches: Studio never writes to it.
    stdio: [spec.tethered ? "pipe" : "ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
}

/** Stops a process and everything it started. */
export function stopTree(child: ChildProcess, graceful = true): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    // There is no SIGINT to send a console child on Windows; /T takes its tree.
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, graceful ? "SIGINT" : "SIGKILL");
  } catch {
    child.kill(graceful ? "SIGINT" : "SIGKILL");
  }
  if (graceful) {
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    }, 8000);
    timer.unref();
    child.once("close", () => clearTimeout(timer));
  }
}

const OUTPUT_LIMIT = 32 * 1024 * 1024;

export const runCommand: Runner = (spec, options = {}) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child: ChildProcess;
    try {
      child = start(spec);
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), missing: true });
      return;
    }
    child.stdout!.on("data", (chunk: Buffer) => { if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString("utf8"); });
    child.stderr!.on("data", (chunk: Buffer) => { if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString("utf8"); });
    const timer = options.timeoutMs ? setTimeout(() => stopTree(child, false), options.timeoutMs) : undefined;
    let missing = false;
    child.on("error", (error: NodeJS.ErrnoException) => {
      missing = error.code === "ENOENT";
      stderr += `${error.message}\n`;
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, ...(missing ? { missing } : {}) });
    });
  });

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

/** Splits a stream into lines, without colour codes or carriage-return redraws. */
export function lineSplitter(onLine: (line: string) => void): { push(chunk: Buffer | string): void; flush(): void } {
  let pending = "";
  const emit = (raw: string) => {
    const text = raw.replace(ANSI, "");
    const last = text.split("\r").filter((part) => part.length > 0).pop() ?? "";
    if (last.trim().length > 0) onLine(last.trimEnd());
  };
  return {
    push(chunk) {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) emit(line);
    },
    flush() {
      if (pending) emit(pending);
      pending = "";
    },
  };
}
