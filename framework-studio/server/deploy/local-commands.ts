import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandSpec } from "./process";

/**
 * The programs behind local development's persistent processes, started so
 * that they end with Studio.
 *
 * On Windows a Node process takes its Node descendants with it when it exits,
 * however it exits, but not past another program in between: `npm run dev`
 * starts Vite through cmd.exe, and `docker compose` runs Compose as a plugin
 * process of docker.exe. Either would outlive a Studio that was killed. So the
 * web client runs its dev script's program with Node directly, and the watch
 * runs the Compose plugin directly. On macOS and Linux the tether stops them.
 */

const SHELL = /[&|;<>`$"'()\\*?{}[\]!~]/;

function readJson(file: string): any {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
}

/** An installed package's executable for a bin name, looked up from a directory as npm does. */
function binEntry(name: string, from: string): string | undefined {
  for (let directory = from; ; directory = path.dirname(directory)) {
    const manifest = path.join(directory, "node_modules", name, "package.json");
    if (existsSync(manifest)) {
      const bin = readJson(manifest)?.bin;
      const relative = typeof bin === "string" ? bin : bin?.[name];
      return relative ? path.join(path.dirname(manifest), relative) : undefined;
    }
    if (path.dirname(directory) === directory) return undefined;
  }
}

/**
 * client-app's dev script, run as `node <program> <args>` in client-app: the
 * script stays the source of truth. A script that needs a shell is not run
 * this way (the caller falls back to npm).
 */
export function clientCommand(root: string, env: NodeJS.ProcessEnv): CommandSpec | undefined {
  const workspace = path.join(root, "client-app");
  const script: unknown = readJson(path.join(workspace, "package.json"))?.scripts?.dev;
  if (typeof script !== "string" || !script.trim() || SHELL.test(script)) return undefined;
  const [program, ...args] = script.trim().split(/\s+/);
  const entry = binEntry(program!, workspace);
  if (!entry || !existsSync(entry) || !/\.(c|m)?js$/.test(entry)) return undefined;
  return { file: process.execPath, args: [entry, ...args], cwd: workspace, env, display: `npm --workspace client-app run dev (${script})` };
}

/** Where the Docker CLI looks for its Compose plugin, in its own order. */
/** Where an installed Docker keeps its plugins for every user, after the user's own directory. */
export function systemPluginDirectories(env: NodeJS.ProcessEnv): string[] {
  return process.platform === "win32"
    ? [path.join(env.ProgramFiles ?? "C:\\Program Files", "Docker", "cli-plugins"), path.join(env.ProgramFiles ?? "C:\\Program Files", "Docker", "Docker", "resources", "cli-plugins")]
    : ["/usr/local/lib/docker/cli-plugins", "/usr/local/libexec/docker/cli-plugins", "/usr/lib/docker/cli-plugins", "/usr/libexec/docker/cli-plugins", "/Applications/Docker.app/Contents/Resources/cli-plugins"];
}

export function composePlugin(env: NodeJS.ProcessEnv, systemDirectories: readonly string[] = systemPluginDirectories(env)): string | undefined {
  const name = process.platform === "win32" ? "docker-compose.exe" : "docker-compose";
  const home = env.USERPROFILE ?? env.HOME ?? os.homedir();
  const directories = [
    env.DOCKER_CONFIG ? path.join(env.DOCKER_CONFIG, "cli-plugins") : path.join(home, ".docker", "cli-plugins"),
    ...systemDirectories,
  ];
  return directories.map((directory) => path.join(directory, name)).find((file) => existsSync(file));
}
