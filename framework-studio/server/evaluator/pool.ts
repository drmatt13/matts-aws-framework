import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Mode, ModeModel } from "../../shared/model";
import { writeModeInputs, readModeWebSocketApi } from "../inputs";
import type { PreflightRequest, PreflightResult } from "../model/preflight";
import { failedModel } from "../model/project";

/**
 * The dev and prod evaluators, kept alive between questions and replaced
 * whenever the source changes.
 *
 * Each is a fresh `node --import tsx` process, so a reload is a new module
 * graph rather than a cache to invalidate. A process that hangs or dies is
 * reported as a failed model, never as a stale one.
 */

const EVALUATOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "evaluate.ts");
const LOAD_TIMEOUT_MS = 60_000;
const PREFLIGHT_TIMEOUT_MS = 30_000;

interface Pending {
  readonly resolve: (result: PreflightResult) => void;
  readonly timer: NodeJS.Timeout;
}

class Evaluator {
  private child: ChildProcess | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  readonly model: Promise<ModeModel>;

  constructor(
    readonly mode: Mode,
    repositoryRoot: string,
    webSocketApi: boolean,
    log: (line: string) => void,
    overrides: Readonly<Record<string, string>> = {},
  ) {
    this.model = new Promise<ModeModel>((resolve) => {
      const started = Date.now();
      const child = fork(EVALUATOR, [], {
        cwd: repositoryRoot,
        execArgv: ["--import", "tsx"],
        env: {
          ...process.env,
          FRAMEWORK_INPUTS_FILE: writeModeInputs(repositoryRoot, mode),
          FRAMEWORK_MODE: mode,
          STUDIO_MODE: mode,
          STUDIO_WEBSOCKET_API: webSocketApi ? "true" : "false",
          STUDIO_REPOSITORY_ROOT: repositoryRoot,
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      this.child = child;
      child.send({ type: "load", overrides });
      const relay = (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split(/\r?\n/)) if (line.trim()) log(`[${mode}] ${line}`);
      };
      child.stdout?.on("data", relay);
      child.stderr?.on("data", relay);
      const timer = setTimeout(() => {
        resolve(failedModel(mode, new Error(`The ${mode} evaluation did not finish within ${LOAD_TIMEOUT_MS / 1000}s.`), Date.now() - started));
        child.kill();
      }, LOAD_TIMEOUT_MS);
      child.on("message", (message: { type?: string; id?: number; model?: ModeModel; result?: PreflightResult }) => {
        if (message.type === "model" && message.model) {
          clearTimeout(timer);
          resolve(message.model);
        } else if (message.type === "preflight" && typeof message.id === "number" && message.result) {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          pending.resolve(message.result);
        }
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        resolve(failedModel(mode, new Error(`The ${mode} evaluator exited (${signal ?? `code ${code}`}) before answering.`), Date.now() - started));
        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.resolve({ mode, ok: false, diagnostics: [{ severity: "error", stage: "load", message: "The evaluator exited before answering." }] });
          this.pending.delete(id);
        }
        this.child = undefined;
      });
    });
  }

  preflight(request: PreflightRequest): Promise<PreflightResult> {
    const child = this.child;
    if (!child?.connected) {
      return Promise.resolve({ mode: this.mode, ok: false, diagnostics: [{ severity: "error", stage: "load", message: "The evaluator is not running." }] });
    }
    const id = this.nextId++;
    return new Promise<PreflightResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ mode: this.mode, ok: false, diagnostics: [{ severity: "error", stage: "validate", message: `The ${this.mode} preflight did not answer within ${PREFLIGHT_TIMEOUT_MS / 1000}s.` }] });
      }, PREFLIGHT_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      child.send({ type: "preflight", id, request });
    });
  }

  /** Stops the process, resolving once it has exited. */
  dispose(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      if (child.connected) child.disconnect();
      child.kill();
    });
  }
}

export interface Evaluation {
  readonly dev: ModeModel;
  readonly prod: ModeModel;
  readonly preflight: (request: PreflightRequest) => Promise<{ readonly dev: PreflightResult; readonly prod: PreflightResult }>;
}

/** Starts a dev and a prod evaluator and waits for both models. */
export class EvaluatorPool {
  private current: { dev: Evaluator; prod: Evaluator } | undefined;

  constructor(
    private readonly repositoryRoot: string,
    private readonly log: (line: string) => void = () => {},
  ) {}

  async evaluate(webSocketApi: boolean, overrides: Readonly<Record<string, string>> = {}): Promise<Evaluation> {
    void this.dispose();
    const pair = {
      dev: new Evaluator("dev", this.repositoryRoot, readModeWebSocketApi(this.repositoryRoot, "dev", webSocketApi), this.log, overrides),
      prod: new Evaluator("prod", this.repositoryRoot, readModeWebSocketApi(this.repositoryRoot, "prod", webSocketApi), this.log, overrides),
    };
    this.current = pair;
    const [dev, prod] = await Promise.all([pair.dev.model, pair.prod.model]);
    return {
      dev,
      prod,
      preflight: async (request) => {
        const [devResult, prodResult] = await Promise.all([pair.dev.preflight(request), pair.prod.preflight(request)]);
        return { dev: devResult, prod: prodResult };
      },
    };
  }

  /** Stops both evaluators, resolving once both have exited. */
  dispose(): Promise<void> {
    const current = this.current;
    this.current = undefined;
    return current ? Promise.all([current.dev.dispose(), current.prod.dispose()]).then(() => undefined) : Promise.resolve();
  }
}
