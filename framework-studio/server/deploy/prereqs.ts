import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { DockerView, PrerequisiteView } from "../../shared/deploy";
import type { CommandResult, Runner, Tools } from "./process";

/**
 * What this machine has, asked of each tool: never inferred from the platform.
 *
 * Docker is needed for local development always, and for a deployment only
 * when it builds an image that is not yet in ECR (or bundles Python with
 * requirements), so a stopped engine is a warning here, and a blocker only for
 * the operations that need it.
 */

const firstLine = (text: string) => text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
const lastLine = (text: string) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() ?? "";
const major = (version: string) => Number(/(\d+)/.exec(version)?.[1] ?? 0);

function parseJson(text: string): any {
  try { return JSON.parse(text); } catch { return undefined; }
}

const ENGINE_DOWN = /Cannot connect to the Docker daemon|error during connect|daemon (is )?not running|dockerDesktopLinuxEngine|docker_engine|The system cannot find the file specified|Is the docker daemon running/i;

export function engineState(result: CommandResult): Pick<DockerView, "engine" | "serverVersion" | "platform" | "os" | "problem"> {
  if (result.missing) return { engine: "missing", problem: "Docker is not installed, or not on PATH." };
  const version = parseJson(result.stdout.trim().split(/\r?\n/)[0] ?? "") ?? parseJson(result.stdout);
  if (version?.Server) {
    return {
      engine: "running",
      serverVersion: String(version.Server.Version ?? ""),
      os: version.Server.Os ? String(version.Server.Os) : undefined,
      platform: version.Server.Platform?.Name ? String(version.Server.Platform.Name) : undefined,
    };
  }
  if (version || ENGINE_DOWN.test(result.stderr)) return { engine: "stopped", problem: "The Docker engine is not running." };
  return { engine: "unknown", problem: lastLine(result.stderr) || "Docker did not answer." };
}

export async function probeDocker(tools: Tools, run: Runner, env: NodeJS.ProcessEnv): Promise<DockerView> {
  const version = await run(tools.docker(["version", "--format", "{{json .}}"], env), { timeoutMs: 15_000 });
  const engine = engineState(version);
  if (engine.engine === "missing") return { ...engine, desktop: false };
  const [context, compose, desktop] = await Promise.all([
    run(tools.docker(["context", "show"], env), { timeoutMs: 10_000 }),
    run(tools.docker(["compose", "version", "--short"], env), { timeoutMs: 10_000 }),
    run(tools.docker(["desktop", "version"], env), { timeoutMs: 10_000 }),
  ]);
  const composeVersion = compose.code === 0 ? firstLine(compose.stdout).replace(/^v/, "") : undefined;
  return {
    ...engine,
    ...(context.code === 0 && firstLine(context.stdout) ? { context: firstLine(context.stdout) } : {}),
    ...(composeVersion ? { composeVersion } : {}),
    desktop: desktop.code === 0,
  };
}

/** Whether `docker compose watch --no-up` exists: watching runs beside a detached stack. */
async function watchesSeparately(tools: Tools, run: Runner, env: NodeJS.ProcessEnv): Promise<boolean> {
  const help = await run(tools.docker(["compose", "watch", "--help"], env), { timeoutMs: 10_000 });
  return help.code === 0 && /--no-up\b/.test(help.stdout);
}

function workspaceManifests(root: string): string[] {
  const manifest = parseJson(existsSync(path.join(root, "package.json")) ? readFileSync(path.join(root, "package.json"), "utf8") : "") ?? {};
  const patterns: string[] = Array.isArray(manifest.workspaces) ? manifest.workspaces : Array.isArray(manifest.workspaces?.packages) ? manifest.workspaces.packages : [];
  const files: string[] = [];
  for (const pattern of patterns) {
    if (pattern.endsWith("/*")) {
      const parent = path.join(root, pattern.slice(0, -2));
      if (!existsSync(parent)) continue;
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(path.join(parent, entry.name, "package.json"))) files.push(`${pattern.slice(0, -2)}/${entry.name}/package.json`);
      }
    } else if (existsSync(path.join(root, pattern, "package.json"))) {
      files.push(`${pattern}/package.json`);
    }
  }
  return files;
}

/**
 * npm's hidden lockfile is written at the end of every install: a lockfile or a
 * manifest newer than it was changed after the last install.
 */
export function dependencyState(root: string): Omit<PrerequisiteView, "id" | "label"> {
  const hidden = path.join(root, "node_modules", ".package-lock.json");
  if (!existsSync(hidden)) {
    return { status: "fail", summary: "Dependencies are not installed.", detail: "node_modules has no record of an install.", remedy: { kind: "deps-install", params: {} } };
  }
  const installed = statSync(hidden).mtimeMs;
  const changed = ["package-lock.json", "package.json", ...workspaceManifests(root)]
    .filter((file) => existsSync(path.join(root, file)) && statSync(path.join(root, file)).mtimeMs > installed + 2000);
  if (changed.length) {
    return {
      status: "warn",
      summary: `${changed[0]} changed after the last install.`,
      detail: `Changed since npm last installed: ${changed.join(", ")}. Install so builds and synthesis use the declared versions.`,
      remedy: { kind: "deps-install", params: {} },
    };
  }
  return { status: "ok", summary: "Installed, and current with package-lock.json." };
}

export async function probePrerequisites(tools: Tools, run: Runner, env: NodeJS.ProcessEnv, root: string): Promise<{ prerequisites: PrerequisiteView[]; docker: DockerView }> {
  const npmCommand = tools.npm(["--version"], env);
  const [npm, aws, docker] = await Promise.all([
    npmCommand ? run(npmCommand, { timeoutMs: 20_000 }) : Promise.resolve<CommandResult>({ code: null, stdout: "", stderr: "", missing: true }),
    env.FRAMEWORK_AWS_CLI ? Promise.resolve<CommandResult>({ code: 0, stdout: "", stderr: "" }) : run(tools.aws(["--version"], env), { timeoutMs: 20_000 }),
    probeDocker(tools, run, env),
  ]);
  const separateWatch = docker.composeVersion ? await watchesSeparately(tools, run, env) : false;

  const nodeMajor = major(process.versions.node);
  const npmVersion = npm.code === 0 ? firstLine(npm.stdout) : undefined;
  const awsVersion = /aws-cli\/(\S+)/.exec(`${aws.stdout} ${aws.stderr}`)?.[1];

  const prerequisites: PrerequisiteView[] = [
    nodeMajor >= 24
      ? { id: "node", label: "Node.js", status: "ok", summary: `Node ${process.versions.node}` }
      : { id: "node", label: "Node.js", status: "fail", summary: `Node ${process.versions.node}; this repository needs 24 or later.` },
    !npmVersion
      ? { id: "npm", label: "npm", status: "fail", summary: "npm was not found beside Node." }
      : major(npmVersion) >= 11
        ? { id: "npm", label: "npm", status: "ok", summary: `npm ${npmVersion}` }
        : { id: "npm", label: "npm", status: "warn", summary: `npm ${npmVersion}: use npm 11.`, detail: "npm 10 strips the lockfile's libc fields, which the repository's native bindings need." },
    env.FRAMEWORK_AWS_CLI
      ? { id: "aws-cli", label: "AWS CLI", status: "ok", summary: "AWS CLI simulated (FRAMEWORK_AWS_CLI)." }
      : aws.missing || aws.code !== 0
        ? { id: "aws-cli", label: "AWS CLI", status: "fail", summary: "The AWS CLI is not installed.", detail: "Install AWS CLI v2 and reopen Studio: every AWS read and change goes through it." }
        : major(awsVersion ?? "2") >= 2
          ? { id: "aws-cli", label: "AWS CLI", status: "ok", summary: `AWS CLI ${awsVersion ?? ""}`.trim() }
          : { id: "aws-cli", label: "AWS CLI", status: "warn", summary: `AWS CLI ${awsVersion}: version 2 is needed for SSO sign-in.` },
    { id: "dependencies", label: "Dependencies", ...dependencyState(root) },
    docker.engine === "running"
      ? { id: "docker", label: "Docker", status: "ok", summary: `Engine ${docker.serverVersion ?? ""} running${docker.context ? ` (${docker.context})` : ""}.`.replace("  ", " ") }
      : docker.engine === "missing"
        ? { id: "docker", label: "Docker", status: "warn", summary: "Docker is not installed.", detail: "Local development runs in Docker, and deployments that build container images need it." }
        : {
          id: "docker", label: "Docker", status: "warn",
          summary: docker.desktop ? "Docker Desktop is not running." : "The Docker engine is not running.",
          detail: "Local development needs it. A deployment needs it only to build container images not yet in ECR.",
          ...(docker.desktop ? { remedy: { kind: "docker-start" as const, params: {} } } : {}),
        },
    !docker.composeVersion
      ? { id: "compose", label: "Compose", status: docker.engine === "missing" ? "unknown" : "fail", summary: "Docker Compose is not available." }
      : separateWatch
        ? { id: "compose", label: "Compose", status: "ok", summary: `Compose ${docker.composeVersion}` }
        : { id: "compose", label: "Compose", status: "warn", summary: `Compose ${docker.composeVersion} cannot watch a running stack.`, detail: "Update Docker Compose: Studio runs the stack detached and watches it with docker compose watch --no-up." },
  ];
  return { prerequisites, docker };
}
