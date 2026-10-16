import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import type { CommandInfo, CommandResult } from "../shared/api";

/**
 * The repository commands the studio can run, and no others.
 *
 * Each is the exact script its npm entry runs, started with the same tsx and
 * fixed arguments: no shell, nothing from the request reaches argv, and a
 * command that writes (the generator) runs only when the request says it was
 * confirmed. One command at a time.
 */

export interface CommandDefinition extends CommandInfo {
  /** Each step is a script path and its fixed arguments, run in order until one fails. */
  readonly steps: readonly (readonly string[])[];
}

export const COMMANDS: Readonly<Record<string, CommandDefinition>> = {
  "framework:check": {
    label: "framework:check",
    description: "Checks generated projections are current and runs the framework's local checks. Writes nothing.",
    steps: [
      ["packages/framework/scripts/generate-contracts.ts", "--check"],
      ["packages/framework/scripts/check-local.ts"],
    ],
    writes: false,
  },
  "framework:generate": {
    label: "framework:generate",
    description: "Regenerates target ids, route contracts and docker-compose.services.yml from the config.",
    steps: [["packages/framework/scripts/generate-contracts.ts"]],
    writes: true,
  },
};

const OUTPUT_LIMIT = 256 * 1024;
const TIMEOUT_MS = 5 * 60_000;

export class CommandRunner {
  private running: string | undefined;

  constructor(private readonly repositoryRoot: string) {}

  get busy(): string | undefined {
    return this.running;
  }

  async run(name: string, confirmed: boolean): Promise<CommandResult> {
    const command = COMMANDS[name];
    if (!command) throw Object.assign(new Error(`${name} is not a command the studio runs.`), { status: 404 });
    if (command.writes && !confirmed) {
      throw Object.assign(new Error(`${name} writes files; confirm it first.`), { status: 428 });
    }
    if (this.running) throw Object.assign(new Error(`${this.running} is still running.`), { status: 409 });
    this.running = name;
    const started = Date.now();
    const tsx = createRequire(path.join(this.repositoryRoot, "package.json")).resolve("tsx/cli");
    let output = "";
    let exitCode: number | null = 0;
    try {
      for (const step of command.steps) {
        output += `$ tsx ${step.join(" ")}\n`;
        exitCode = await new Promise<number | null>((resolve) => {
          const child = spawn(process.execPath, [tsx, ...step], {
            cwd: this.repositoryRoot,
            env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
            shell: false,
            windowsHide: true,
          });
          const append = (chunk: Buffer) => {
            if (output.length < OUTPUT_LIMIT) output += chunk.toString("utf8");
          };
          child.stdout.on("data", append);
          child.stderr.on("data", append);
          const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
          child.on("error", (error) => {
            output += `${error.message}\n`;
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            resolve(code);
          });
        });
        if (exitCode !== 0) break;
      }
    } finally {
      this.running = undefined;
    }
    return { command: name, exitCode, output: output.slice(0, OUTPUT_LIMIT), durationMs: Date.now() - started };
  }
}
