import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";

const execute = promisify(execFile);
const builds = new Set<AbortController>();
let stoppingBuilds = false;

/** Bounded build output kept on a failure, newest lines last. */
const BUILD_DIAGNOSTIC_LINES = 40;
const BUILD_DIAGNOSTIC_CHARACTERS = 2_000;
/** A CLI error is one or two lines; a build's is a transcript. */
const CLI_DIAGNOSTIC_LINES = 3;

/**
 * Cancels every build, for shutdown only.
 *
 * A single run's stop cancels its own build through the signal it passes to
 * {@link dockerBuild}. This is the other case: the process is going away, and
 * nothing it is building can still be launched.
 */
export function cancelDockerBuilds(): void {
  stoppingBuilds = true;
  for (const controller of builds) controller.abort();
}

export async function docker(...args: string[]): Promise<string> {
  const build = args[0] === "build" ? new AbortController() : undefined;
  if (build && stoppingBuilds) throw new Error("Local runner is shutting down.");
  if (build) builds.add(build);
  try {
    const result = await execute("docker", args, { maxBuffer: 10 * 1024 * 1024, signal: build?.signal });
    return (args[0] === "logs" ? result.stdout + result.stderr : result.stdout).trim();
  } catch (error) {
    // What the daemon said, never how it was asked: an execFile error message
    // repeats the whole command, and a `docker run` command line carries the
    // task's resolved environment. Its *stderr* carries neither, and without it
    // a failure like "No such image" reads as "check the logs" - which is how
    // one went undiagnosed until an image went missing under a moving tag.
    throw new Error(`Docker ${args[0]} failed: ${daemonMessage(error)}`);
  } finally {
    if (build) builds.delete(build);
  }
}

/** Values use the CLI's inherited environment; argv contains names only. */
export async function dockerWithEnvironment(args: readonly string[], environment: Readonly<Record<string, string>>): Promise<string> {
  try {
    const result = await execute("docker", [...args], { env: { ...process.env, ...environment }, maxBuffer: 10 * 1024 * 1024 });
    return result.stdout.trim();
  } catch { throw new Error(`Docker ${args[0]} failed while starting a workload. Check the daemon and image configuration.`); }
}

/** Preserve the image's platform paths and home directory. */
export function containerEnvironment(environment: Readonly<Record<string, string>>): Record<string, string> {
  const hostOnly = new Set(["PATH", "Path", "HOME", "USERPROFILE", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR"]);
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !hostOnly.has(key)));
}

/** The tail of what the CLI printed on stderr, with the command left out. */
function daemonMessage(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr ?? "";
  const lines = stderr.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) return "the Docker CLI reported no detail. Check the daemon and container logs.";
  const message = lines.slice(-CLI_DIAGNOSTIC_LINES).join(" ");
  return message.length > BUILD_DIAGNOSTIC_CHARACTERS
    ? message.slice(-BUILD_DIAGNOSTIC_CHARACTERS)
    : message;
}

/**
 * `docker build`, cancellable by the caller that asked for it.
 *
 * Two things the shared command cannot do. It takes a signal, so stopping one
 * task really stops that task's build rather than every build in the process.
 * And it reports what the builder said: a build's arguments are paths, tags and
 * labels — never resolved task environment — so a bounded tail of its output is
 * safe to show, and a build failure without one is undiagnosable.
 */
export async function dockerBuild(args: readonly string[], signal?: AbortSignal): Promise<string> {
  if (stoppingBuilds) throw new Error("Local runner is shutting down.");
  if (signal?.aborted) throw signal.reason as Error;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  builds.add(controller);
  try {
    const result = await execute("docker", [...args], {
      maxBuffer: 10 * 1024 * 1024,
      signal: controller.signal,
    });
    // BuildKit writes its progress to stderr and the image reference to stdout.
    return (result.stdout + result.stderr).trim();
  } catch (error) {
    if (controller.signal.aborted) {
      throw (signal?.reason as Error | undefined) ?? new Error("The build was cancelled.");
    }
    throw new Error(`Docker build failed.\n${buildDiagnostics(error)}`);
  } finally {
    builds.delete(controller);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** The tail of what the builder printed, without the command that ran it. */
function buildDiagnostics(error: unknown): string {
  const streams = error as { stderr?: string; stdout?: string };
  const output = `${streams?.stdout ?? ""}\n${streams?.stderr ?? ""}`.trim();
  if (output.length === 0) return "The Docker builder produced no output.";
  const tail = output.split(/\r?\n/).slice(-BUILD_DIAGNOSTIC_LINES).join("\n");
  return tail.length > BUILD_DIAGNOSTIC_CHARACTERS
    ? tail.slice(-BUILD_DIAGNOSTIC_CHARACTERS)
    : tail;
}

export async function composeIdentity(command = docker): Promise<{ projectName: string; network: string; awsConfigSource?: string }> {
  if (!process.env.HOSTNAME) throw new Error("Runner container identity is unavailable.");
  const [container] = JSON.parse(await command("inspect", process.env.HOSTNAME));
  const projectName = container?.Config?.Labels?.["com.docker.compose.project"];
  const networks = Object.keys(container?.NetworkSettings?.Networks ?? {});
  if (!projectName || networks.length !== 1) throw new Error("Runner must belong to one Compose project and network.");
  return { projectName, network: networks[0], awsConfigSource: container.Mounts?.find((mount: { Destination: string }) => mount.Destination === "/root/.aws")?.Source };
}

export function forwardLines(stream: NodeJS.ReadableStream, prefix: string): () => void {
  const lines = createInterface({ input: stream });
  lines.on("line", line => process.stdout.write(`[${prefix}] ${line}\n`));
  return () => lines.close();
}

export function followContainerLogs(container: string, prefix: string): () => Promise<void> {
  const child = spawn("docker", ["logs", "--follow", container], { stdio: ["ignore", "pipe", "pipe"] });
  const close = [forwardLines(child.stdout, prefix), forwardLines(child.stderr, prefix)];
  child.on("error", () => console.error(`[${prefix}] Unable to follow Docker logs.`));
  const finished = new Promise<void>(resolve => { child.once("close", () => resolve()); child.once("error", () => resolve()); });
  return async () => {
    // A short task can exit before its log client starts. Let buffered output
    // drain before stopping the follower, including its final partial line.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([finished, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]);
    if (timer) clearTimeout(timer);
    child.kill();
    close.forEach(stop => stop());
  };
}
