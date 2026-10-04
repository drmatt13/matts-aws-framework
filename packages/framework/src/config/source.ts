import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import { parseEnv } from "node:util";
import {
  parseSecretBindings,
  SECRET_BINDINGS_FILE,
  type SecretBindingDocument,
} from "./secret-bindings";
import {
  getFrameworkTargets,
  isNodeLambdaRuntime,
  isSourcedTarget,
  resolveLambdaTarget,
  resolveServiceTarget,
  resolveTaskTarget,
  type FrameworkConfig,
  type FrameworkDirectory,
  type NormalizedTarget,
  type TargetReference,
} from "./index";

/**
 * The Node-only half of source resolution.
 *
 * `index.ts` normalizes what the config *says* about a location and never
 * touches a filesystem, which is what lets a browser bundle import it. Turning
 * a framework path into a real directory — and proving it is inside `cdk-app` —
 * happens here, once, so CDK, the generator, the local executor and the
 * container runner cannot disagree about where a target's code lives.
 */

export interface FrameworkRootOptions {
  /** Repository root. Discovered from the current working directory when omitted. */
  readonly repositoryRoot?: string;
}

/** Absolute location of a target's source, with the framework path it came from. */
export interface ResolvedTargetSource {
  readonly reference: TargetReference;
  readonly id: string;
  readonly directory: FrameworkDirectory;
  /** Absolute path on this machine. Never stored in generated output. */
  readonly path: string;
}

/**
 * Walks up from `start` to the directory holding `framework.config.ts` and
 * `cdk-app/lambda_functions`.
 */
export function findRepositoryRoot(start: string = process.cwd()): string {
  let current = path.resolve(start);
  for (;;) {
    if (
      existsSync(path.join(current, "framework.config.ts")) &&
      existsSync(path.join(current, "cdk-app", "lambda_functions"))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(
        `Unable to locate the repository root from "${start}". Expected framework.config.ts and cdk-app/lambda_functions.`,
      );
    }
    current = parent;
  }
}

/** Where a `.fromEnv()` variable is authored, and the only file one is read from. */
export const AUTHORED_INPUTS_FILE = "cdk-app/.env";

/**
 * Every value authored in cdk-app/.env, as the map a `.fromEnv()` is resolved
 * against.
 *
 * The file itself, not `process.env`. A deployment and `docker compose up` are
 * then reading the same line of the same file: a variable that happens to be
 * exported in the shell, or one the repository-root `.env` picked up from a
 * previous `npm run export:cdk-outputs`, cannot quietly stand in for a setting
 * this file is supposed to own. That root file is generated *output* — it holds
 * what a deployment produced — and inputs never come from it.
 *
 * `FRAMEWORK_INPUTS_FILE` points somewhere else, which is how a test supplies a
 * fixture without writing to the repository.
 */
export function readAuthoredInputs(
  repositoryRoot: string = findRepositoryRoot(),
  environment: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  const file = environment.FRAMEWORK_INPUTS_FILE ?? path.join(repositoryRoot, AUTHORED_INPUTS_FILE);
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    Object.entries(parseEnv(readFileSync(file, "utf8"))).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

/**
 * `PROD_DEPLOYMENT` as authored in cdk-app/.env: whether this repository is
 * currently pointed at a full cloud deployment.
 *
 * A constant rather than a function, because the resource catalog branches on
 * it while it is being declared. Every process that loads the catalog reads the
 * same line of the same file — CDK synthesis on the host, and the four Compose
 * services, which bind-mount cdk-app/.env read-only — so a dev server and a
 * deployment cannot disagree about which graph this is.
 *
 * Parsed strictly, for the reason `cdk-app/deployment.ts` parses it strictly: a
 * typo must not coerce to a mode nobody asked for. Anything other than "true"
 * is false, and absence is false.
 *
 * Defensive about the repository root: nothing that imports the catalog runs
 * outside the repository today, and an import should not be the thing that
 * discovers otherwise.
 */
export const PROD_DEPLOYMENT: boolean = (() => {
  try {
    return readAuthoredInputs().PROD_DEPLOYMENT?.trim().toLowerCase() === "true";
  } catch {
    return false;
  }
})();

/** The directory a framework path's leading slash refers to. */
export function getFrameworkSourceRoot(options: FrameworkRootOptions = {}): string {
  return path.join(options.repositoryRoot ?? findRepositoryRoot(), "cdk-app");
}

function realPath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * Resolves a framework path against `cdk-app` and proves it stays inside.
 *
 * Containment is checked after resolving symlinks and junctions, so a link
 * pointing out of the repository is rejected rather than followed.
 */
export function resolveFrameworkDirectory(
  directory: FrameworkDirectory,
  origin: string,
  options: FrameworkRootOptions = {},
): string {
  const sourceRoot = getFrameworkSourceRoot(options);
  const candidate = path.resolve(sourceRoot, directory.slice(1));
  const relative = path.relative(realPath(sourceRoot), realPath(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `${origin} directory "${directory}" resolves outside cdk-app (${candidate}).`,
    );
  }
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
    throw new Error(
      `${origin} directory "${directory}" does not exist. Expected ${candidate}.`,
    );
  }
  return candidate;
}

/**
 * Resolves an agent's directory. The one framework path rooted at the
 * repository rather than at `cdk-app` (see AGENT_SOURCE_ROOT), and contained to
 * the repository's `agentcore` directory the way every other path is contained
 * to `cdk-app`.
 */
export function resolveAgentSourcePath(config: FrameworkConfig, id: string, options: FrameworkRootOptions = {}): string {
  const target = getFrameworkTargets(config).find((candidate) => candidate.reference === `agent:${id}`);
  if (!target?.directory) throw new Error(`agent:${id} is not declared under agents.`);
  const repositoryRoot = options.repositoryRoot ?? findRepositoryRoot();
  const boundary = realPath(path.join(repositoryRoot, "agentcore"));
  const candidate = path.resolve(repositoryRoot, target.directory.slice(1));
  const relative = path.relative(boundary, realPath(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative === "") {
    throw new Error(`${target.origins[0]} directory "${target.directory}" resolves outside the repository's agentcore directory.`);
  }
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
    throw new Error(`${target.origins[0]} directory "${target.directory}" does not exist. Expected ${candidate}.`);
  }
  return candidate;
}

/** Case-insensitive Dockerfile lookup, because both spellings are in use. */
export function findDockerfile(directory: string): string | undefined {
  if (!existsSync(directory)) return undefined;
  const entry = readdirSync(directory).find(
    (name) => name.toLowerCase() === "dockerfile",
  );
  return entry ? path.join(directory, entry) : undefined;
}

/** Every `EXPOSE` port a Dockerfile declares, de-duplicated, in file order. */
export function readDockerfileExposedPorts(dockerfile: string): readonly number[] {
  const ports = [
    ...readFileSync(dockerfile, "utf8").matchAll(
      /^\s*EXPOSE\s+(\d+)(?:\/tcp)?\s*$/gim,
    ),
  ].map((match) => Number(match[1]));
  return [...new Set(ports)];
}

/** Every named build stage a Dockerfile defines, in file order. */
export function readDockerfileStages(dockerfile: string): readonly string[] {
  return [
    ...readFileSync(dockerfile, "utf8").matchAll(
      /^\s*FROM\s+\S+(?:\s+--\S+)*\s+AS\s+([A-Za-z0-9][A-Za-z0-9._-]*)\s*$/gim,
    ),
  ].map((match) => match[1]);
}

/**
 * The one port policy, used by local Compose generation and by ECS alike.
 *
 * An explicit `port` wins so local and AWS read the same number; a single
 * unambiguous `EXPOSE` is the fallback for a service that does not declare one.
 * Two `EXPOSE` lines and no declaration is an error, not a guess.
 */
export function resolveServicePort(
  config: FrameworkConfig,
  id: string,
  options: FrameworkRootOptions = {},
): number {
  const declared = resolveServiceTarget(config, id).port;
  if (declared !== undefined) return declared;

  const directory = resolveServiceSourcePath(config, id, options);
  const dockerfile = findDockerfile(directory);
  if (!dockerfile) {
    throw new Error(
      `service:${id} declares no port and ${directory} has no Dockerfile to read one from.`,
    );
  }
  const exposed = readDockerfileExposedPorts(dockerfile);
  if (exposed.length !== 1) {
    throw new Error(
      exposed.length === 0
        ? `service:${id} declares no port and ${dockerfile} has no EXPOSE instruction. Declare "port" in framework.config.ts.`
        : `service:${id} declares no port and ${dockerfile} exposes ${exposed.join(", ")}. Declare "port" in framework.config.ts.`,
    );
  }
  return exposed[0];
}

/** Every declared target's real source directory, keyed by canonical reference. */
export function resolveTargetSources(
  config: FrameworkConfig,
  options: FrameworkRootOptions = {},
): Map<TargetReference, ResolvedTargetSource> {
  const repositoryRoot = options.repositoryRoot ?? findRepositoryRoot();
  const sources = new Map<TargetReference, ResolvedTargetSource>();
  for (const target of getFrameworkTargets(config)) {
    // A workflow has no source to resolve: its graph is the declaration.
    if (!isSourcedTarget(target)) continue;
    sources.set(target.reference, {
      reference: target.reference,
      id: target.id,
      directory: target.directory,
      path: target.kind === "agent" ? resolveAgentSourcePath(config, target.id, { repositoryRoot }) : resolveFrameworkDirectory(target.directory, target.origins[0] ?? target.reference, {
        repositoryRoot,
      }),
    });
  }
  return sources;
}

/** Discovery validates the declared inventory; it never creates event targets. */
export function assertLambdaInventory(
  config: FrameworkConfig,
  discoveredDirectories: Iterable<string>,
): void {
  const declared = new Set(getFrameworkTargets(config)
    .filter(target => target.kind === "lambda")
    .map(target => (target as { directory: FrameworkDirectory }).directory));
  const missing = [...discoveredDirectories].filter(directory => !declared.has(directory as FrameworkDirectory));
  if (missing.length > 0) {
    throw new Error(missing.map(directory =>
      `cdk-app${directory} is not declared. Add its directory to http, webSocket (including authorizers), or events in framework.config.ts.`,
    ).join("\n"));
  }
}

/** Absolute source directory of one declared Lambda. */
export function resolveLambdaSourcePath(
  config: FrameworkConfig,
  id: string,
  options: FrameworkRootOptions = {},
): string {
  return resolveFrameworkDirectory(
    resolveLambdaTarget(config, id).directory,
    `lambda:${id}`,
    options,
  );
}

/** Absolute source directory of one declared task. */
export function resolveTaskSourcePath(
  config: FrameworkConfig,
  id: string,
  options: FrameworkRootOptions = {},
): string {
  return resolveFrameworkDirectory(
    resolveTaskTarget(config, id).directory,
    `task:${id}`,
    options,
  );
}

/** Absolute source directory of one declared service. */
export function resolveServiceSourcePath(
  config: FrameworkConfig,
  id: string,
  options: FrameworkRootOptions = {},
): string {
  return resolveFrameworkDirectory(
    resolveServiceTarget(config, id).directory,
    `service:${id}`,
    options,
  );
}

/**
 * Checks that a target directory holds what its selected packaging and runtime
 * need to build. Packaging is never inferred from a stray Dockerfile — the
 * config decides, and this only verifies the config can be honoured.
 */
export function assertTargetArtifacts(
  config: FrameworkConfig,
  target: NormalizedTarget,
  directory: string,
): void {
  const origin = target.origins[0] ?? target.reference;

  if (target.kind === "agent") {
    if (!existsSync(path.join(directory, "index.ts"))) throw new Error(`${origin}: agents require index.ts exporting handler.`);
    return;
  }
  if (target.kind === "service" || target.kind === "task") {
    if (!findDockerfile(directory)) {
      throw new Error(
        `${origin} declares ${target.kind} "${target.id}", but ${directory} has no Dockerfile.`,
      );
    }
    return;
  }
  if (target.kind === "workflow") return;

  const spec = resolveLambdaTarget(config, target.id);
  if (spec.packaging === "container") {
    if (!findDockerfile(directory)) {
      throw new Error(
        `${origin} is packaged as a container, but ${directory} has no Dockerfile.`,
      );
    }
    return;
  }

  const entry = isNodeLambdaRuntime(spec.runtime)
    ? "index.ts"
    : "lambda_function.py";
  if (!existsSync(path.join(directory, entry))) {
    throw new Error(
      `${origin} runs on ${spec.runtime} as a zip, but ${directory} has no ${entry}.`,
    );
  }
}

/**
 * The startup-secret bindings the retired sync command left, if the file is
 * still there.
 *
 * Here rather than beside the parser for the reason the rest of this module
 * exists: `config/index.ts` stays importable in a browser, so it is handed the
 * document rather than going to look for one.
 */
export function readSecretBindings(
  repositoryRoot: string,
): SecretBindingDocument | undefined {
  const file = path.join(repositoryRoot, SECRET_BINDINGS_FILE);
  if (!existsSync(file)) return undefined;
  return parseSecretBindings(readFileSync(file, "utf8"));
}
