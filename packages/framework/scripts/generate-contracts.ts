import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compile, type JSONSchema } from "json-schema-to-typescript";
// Values come from `../src/config/conventions`, never `../src/config/index`: importing the
// framework module here would load the *previous* generation of
// `../src/generated/target-ids` and pin it in the module cache, so this run
// would describe a repository it has already stopped matching.
import {
  EVENT_SOURCE_ROOT,
  LAMBDA_SOURCE_ROOT,
  SERVICE_SOURCE_ROOT,
  TASK_SOURCE_ROOT,
  TOOL_SOURCE_ROOT,
} from "../src/config/conventions";
import { readSectionKeys } from "./config-source";
import {
  agentCoreModule,
  agentRouteDeclarations,
  assertWorkflowAgentsRespond,
  readAgentContract,
  readToolContract,
  type AgentContractFacts,
  type ToolContractFacts,
} from "./agentcore-contracts";
import {
  contractModuleName,
  contractNamespaceName,
  contractsBarrel,
  jsonSchemaContractModule,
  readContractModule,
  typescriptContractModule,
  type ContractExport,
  type ProjectedContract,
} from "./contract-modules";
import type { FrameworkConfig, NormalizedTarget } from "../src/config/index";

/**
 * The framework module reads the generated id union, and this script rewrites
 * it, so it is loaded only after that write — otherwise a newly added handler
 * directory would be missing from the config until a second run.
 */
type Framework = typeof import("../src/config/index");
type FrameworkSource = typeof import("../src/config/source");
let framework: Framework;
let source: FrameworkSource;

const checkOnly = process.argv.includes("--check");
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const configFile = path.join(repositoryRoot, "framework.config.ts");
const lambdaRoot = path.join(repositoryRoot, "cdk-app", "lambda_functions");
const serviceRoot = path.join(
  repositoryRoot,
  "cdk-app",
  "ecs_containers",
  "services",
);
const taskRoot = path.join(repositoryRoot, "cdk-app", "ecs_containers", "tasks");
const targetIdsFile = path.join(
  repositoryRoot,
  "packages",
  "framework",
  "src",
  "generated",
  "target-ids.ts",
);
const contractsFile = path.join(
  repositoryRoot,
  "packages",
  "api-contract",
  "src",
  "generated",
  "framework-contracts.ts",
);
const routesFile = path.join(
  repositoryRoot,
  "packages",
  "api-contract",
  "src",
  "generated",
  "framework-routes.ts",
);
/**
 * One generated module per target with a payload contract. Owned entirely by
 * this script: anything here that this run does not produce is removed, which
 * is how a deleted or renamed contract stops being part of the public surface.
 */
/**
 * The replay manifest, projected for the one handler that needs it.
 *
 * A replay lookup is `manifest[replayId]`. Deriving it at module load through
 * `getEventReplayManifest(framework)` made an event Lambda import the root
 * config and every section it composes, and run the framework's normalization,
 * to answer that. The projection is generated instead, and exposed on its own
 * entry point so reading it does not pull in the framework's runtime facade.
 */
const eventReplayFile = path.join(
  repositoryRoot,
  "packages",
  "framework",
  "src",
  "generated",
  "event-replay.ts",
);
/** Tool schemas, agent tool lists and their types. See `./agentcore-contracts`. */
const agentCoreFile = path.join(
  repositoryRoot,
  "packages",
  "framework",
  "src",
  "generated",
  "agentcore.ts",
);
const contractModuleDirectory = path.join(
  repositoryRoot,
  "packages",
  "api-contract",
  "src",
  "generated",
  "contracts",
);

const staleFiles: string[] = [];

/**
 * What this run has changed on disk, in the order it changed it.
 *
 * `previous === undefined` means the file did not exist before this run, so
 * undoing it is a delete rather than a rewrite — the case the earlier rollback
 * skipped, which left a first-run id file behind after a failure. Removals are
 * journalled the same way, with the content they removed.
 *
 * This is not a crash-atomic multi-file transaction and does not claim to be.
 * Each destination is replaced atomically (written beside itself, then renamed
 * over), and a *handled* failure walks this journal back. A process killed
 * mid-flush leaves whatever it had already renamed; the journal is in memory,
 * and version control is what recovers that.
 */
const journal: Array<{ file: string; previous: string | undefined }> = [];
/** Writes held back until the config has fully validated. */
const staged: Array<{ file: string; contents: string }> = [];
/** Generated files this run no longer produces, removed with the staged writes. */
const stagedRemovals: string[] = [];

function currentContents(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

/**
 * Replaces one destination, recording what was there first.
 *
 * The write lands on a sibling temporary file and is renamed over the
 * destination, so a reader never sees a half-written generated module and a
 * failure part-way through writing cannot truncate the previous one.
 */
function commit(file: string, contents: string): void {
  journal.push({ file, previous: currentContents(file) });
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.generating-${process.pid}`;
  writeFileSync(temporary, contents);
  renameSync(temporary, file);
  console.log(`Generated ${path.relative(repositoryRoot, file)}`);
}

function remove(file: string): void {
  journal.push({ file, previous: currentContents(file) });
  rmSync(file);
  console.log(`Removed ${path.relative(repositoryRoot, file)}`);
}

/**
 * Writes now, remembering the previous content. Used only for the id union,
 * which is derived from the filesystem alone and has to exist before the config
 * can be imported. Anything later that fails restores it.
 */
function writeGenerated(file: string, contents: string): void {
  if (currentContents(file) === contents) return;
  if (checkOnly) {
    staleFiles.push(path.relative(repositoryRoot, file));
    return;
  }
  commit(file, contents);
}

/** Holds a write until every check has passed, so invalid config writes nothing. */
function stageGenerated(file: string, contents: string): void {
  if (currentContents(file) === contents) return;
  if (checkOnly) {
    staleFiles.push(path.relative(repositoryRoot, file));
    return;
  }
  staged.push({ file, contents });
}

/**
 * Marks a generated file this run no longer produces.
 *
 * Contract modules are named after the target they project, so a removed,
 * renamed or newly type-only contract leaves a module behind. Left in place it
 * would keep exporting a shape nothing declares any more, and `--check` would
 * call the repository fresh.
 */
function removeGenerated(file: string): void {
  if (!existsSync(file)) return;
  if (checkOnly) {
    staleFiles.push(path.relative(repositoryRoot, file));
    return;
  }
  stagedRemovals.push(file);
}

function flushStaged(): void {
  for (const { file, contents } of staged) commit(file, contents);
  staged.length = 0;
  for (const file of stagedRemovals) remove(file);
  stagedRemovals.length = 0;
}

/**
 * Puts back everything this run changed, newest first.
 *
 * A file this run created is deleted rather than left holding output from a
 * generation that did not finish; a file it replaced gets its previous content
 * back. Only generator-owned destinations are ever in the journal, so this can
 * never reach an authored file.
 */
function restoreWrites(): void {
  for (const { file, previous } of journal.reverse()) {
    try {
      if (previous === undefined) rmSync(file, { force: true });
      else writeFileSync(file, previous);
    } catch (error) {
      // Says which file is now wrong rather than replacing the original
      // failure with this one.
      console.error(
        `Could not restore ${path.relative(repositoryRoot, file)} after a failed generation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  journal.length = 0;
  for (const { file } of staged) {
    rmSync(`${file}.generating-${process.pid}`, { force: true });
  }
  staged.length = 0;
  stagedRemovals.length = 0;
}

/** Directories under a conventional root, which is what autocompletion offers. */
function directoryIds(root: string): readonly string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * What makes a directory a handler rather than somewhere handlers are kept.
 * These are the same artifacts `assertTargetArtifacts` demands of a built
 * target, so "looks like a handler" and "builds as one" cannot drift apart.
 */
const HANDLER_ARTIFACTS = ["index.ts", "lambda_function.py", "Dockerfile"];

function isHandlerDirectory(directory: string): boolean {
  return HANDLER_ARTIFACTS.some((artifact) =>
    existsSync(path.join(directory, artifact)),
  );
}

/**
 * Every Lambda under `cdk-app/lambda_functions`, mapped from target id to the
 * framework path it lives at.
 *
 * Handlers may sit directly under the root or be filed one level down in a
 * grouping directory — `http_functions`, `websocket_functions` and
 * `event_functions` in this repository, matching the config sections that
 * claim them. A directory holding one of {@link HANDLER_ARTIFACTS} is a
 * handler; anything else is a group, and its children are scanned instead.
 * Grouping is therefore a filing decision, invisible to a target's id: moving
 * `sign-in` between groups never renames `lambda:sign-in`, and never touches a
 * deployed resource.
 */
function lambdaDirectoriesById(root: string): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  const collisions: string[] = [];

  const claim = (id: string, directory: string): void => {
    const existing = found.get(id);
    if (existing) {
      collisions.push(`${id} is both ${existing} and ${directory}`);
      return;
    }
    found.set(id, directory);
  };

  for (const entry of directoryIds(root)) {
    const directory = path.join(root, entry);
    if (isHandlerDirectory(directory)) {
      claim(entry, `${LAMBDA_SOURCE_ROOT}/${entry}`);
      continue;
    }
    for (const nested of directoryIds(directory)) {
      claim(nested, `${LAMBDA_SOURCE_ROOT}/${entry}/${nested}`);
    }
  }

  if (collisions.length > 0) {
    throw new Error(
      `cdk-app/lambda_functions has handler directories sharing a target id, which is the identity every registry key, replay envelope and deployed resource is built from:\n  - ${collisions.join(
        "\n  - ",
      )}`,
    );
  }

  return new Map([...found].sort(([a], [b]) => (a < b ? -1 : 1)));
}

function idsModule(
  lambdaDirectories: ReadonlyMap<string, string>,
  serviceIds: readonly string[],
  taskIds: readonly string[],
  workflowIds: readonly string[],
  agentIds: readonly string[],
): string {
  const list = (values: readonly string[]) =>
    values.map((value) => `  ${JSON.stringify(value)},`).join("\n");
  const directories = (root: string, ids: readonly string[]) =>
    ids.map((id) => `${root}/${id}`);
  const entries = (map: ReadonlyMap<string, string>) =>
    [...map]
      .map(([id, directory]) => `  ${JSON.stringify(id)}: ${JSON.stringify(directory)},`)
      .join("\n");

  const lambdaIds = [...lambdaDirectories.keys()];
  // Filed under the event grouping directory, which is the only signal the
  // filesystem carries about how a handler is invoked. Derived here rather than
  // from the config, because this file is written before the config is loaded.
  const eventIds = [...lambdaDirectories]
    .filter(([, directory]) => directory.startsWith(`${EVENT_SOURCE_ROOT}/`))
    .map(([id]) => id);
  const toolIds = [...lambdaDirectories]
    .filter(([, directory]) => directory.startsWith(`${TOOL_SOURCE_ROOT}/`))
    .map(([id]) => id);

  return [
    "/* This file is generated by npm run framework:generate. Do not edit. */",
    "",
    "/**",
    " * Where each Lambda under `cdk-app/lambda_functions` lives. Handlers are",
    " * filed in grouping directories by the config section that claims them, so",
    " * a target id does not spell its own path and this map is how an event",
    " * Lambda finds the directory it never had to declare.",
    " */",
    "export const LAMBDA_SOURCE_DIRECTORY_BY_ID = {",
    entries(lambdaDirectories),
    "} as const;",
    "",
    "/** Every handler directory under `cdk-app/lambda_functions`, by target id. */",
    "export const LAMBDA_TARGET_IDS = [",
    list(lambdaIds),
    "] as const;",
    "",
    "export type LambdaTargetId = (typeof LAMBDA_TARGET_IDS)[number];",
    "",
    "/** Conventional Lambda source directories, offered as `directory` completions. */",
    "export const LAMBDA_SOURCE_DIRECTORIES = [",
    list([...lambdaDirectories.values()]),
    "] as const;",
    "",
    "export type LambdaSourceDirectory = (typeof LAMBDA_SOURCE_DIRECTORIES)[number];",
    "",
    "/**",
    " * Handler directories under `cdk-app/lambda_functions/event_functions`: the",
    " * ids `eventFunction(scope, id)` completes, and the ones an `events` entry",
    " * can declare without spelling its own directory.",
    " */",
    "export const EVENT_LAMBDA_IDS = [",
    list(eventIds),
    "] as const;",
    "",
    "export type EventLambdaId = (typeof EVENT_LAMBDA_IDS)[number];",
    "",
    "/**",
    " * Handler directories under `cdk-app/lambda_functions/tool_functions`: the",
    " * ids an agent's `tools` list completes, and the ones a `tools` entry can",
    " * declare without spelling its own directory.",
    " */",
    "export const TOOL_LAMBDA_IDS = [",
    list(toolIds),
    "] as const;",
    "",
    "export type ToolLambdaId = (typeof TOOL_LAMBDA_IDS)[number];",
    "",
    "/** Every directory directly under `cdk-app/ecs_containers/services`. */",
    "export const SERVICE_TARGET_IDS = [",
    list(serviceIds),
    "] as const;",
    "",
    "export type ServiceTargetId = (typeof SERVICE_TARGET_IDS)[number];",
    "",
    "/** Conventional service source directories, offered as `directory` completions. */",
    "export const SERVICE_SOURCE_DIRECTORIES = [",
    list(directories(SERVICE_SOURCE_ROOT, serviceIds)),
    "] as const;",
    "",
    "export type ServiceSourceDirectory = (typeof SERVICE_SOURCE_DIRECTORIES)[number];",
    "",
    "/** Every directory directly under `cdk-app/ecs_containers/tasks`. */",
    "export const TASK_TARGET_IDS = [",
    list(taskIds),
    "] as const;",
    "",
    "export type TaskTargetId = (typeof TASK_TARGET_IDS)[number];",
    "",
    "/** Conventional task source directories, offered as `directory` completions. */",
    "export const TASK_SOURCE_DIRECTORIES = [",
    list(directories(TASK_SOURCE_ROOT, taskIds)),
    "] as const;",
    "",
    "export type TaskSourceDirectory = (typeof TASK_SOURCE_DIRECTORIES)[number];",
    "",
    "/**",
    " * Workflow ids, read from the config's literal `workflows` keys rather than",
    " * from a directory scan: a workflow graph lives in the config and has no",
    " * source of its own. Read statically, before the config is imported, for the",
    " * same reason every other union here is - the config is typed against it.",
    " */",
    "export const WORKFLOW_TARGET_IDS = [",
    list(workflowIds),
    "] as const;",
    "",
    "export type WorkflowTargetId = (typeof WORKFLOW_TARGET_IDS)[number];",
    "",
    "/**",
    " * Agent ids, read from the config's literal `agents` keys for the same",
    " * reason as workflow ids: the config is typed against them.",
    " */",
    "export const AGENT_TARGET_IDS = [",
    list(agentIds),
    "] as const;",
    "",
    "export type AgentTargetId = (typeof AGENT_TARGET_IDS)[number];",
    "",
  ].join("\n");
}

/**
 * A declared directory with nothing behind it has nothing to build, and a
 * service is invisible to every tool the framework ships until `services` names
 * it, so both are errors. Every conventional Lambda directory must also be claimed
 * explicitly, including event functions.
 */
function assertConfigMatchesRepository(
  config: FrameworkConfig,
  serviceIds: readonly string[],
  taskIds: readonly string[],
  lambdaDirectories: ReadonlyMap<string, string>,
): Map<string, string> {
  const problems: string[] = [];
  const directories = new Map<string, string>();
  const declaredContainerDirectories = new Set<string>();

  for (const target of framework.getFrameworkTargets(config)) {
    // A workflow has no directory to resolve, artifact to demand or contract to
    // sweep for. It is validated as a graph by normalization instead.
    if (!framework.isSourcedTarget(target)) continue;
    try {
      const directory = target.kind === "agent" ? source.resolveAgentSourcePath(config, target.id, { repositoryRoot }) : source.resolveFrameworkDirectory(
        target.directory,
        target.origins[0] ?? target.reference,
        { repositoryRoot },
      );
      source.assertTargetArtifacts(config, target, directory);
      directories.set(target.reference, directory);
      if (target.kind === "service" || target.kind === "task") {
        declaredContainerDirectories.add(target.directory);
      }
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }

  try {
    source.assertLambdaInventory(config, lambdaDirectories.values());
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  for (const id of serviceIds) {
    if (!declaredContainerDirectories.has(`${SERVICE_SOURCE_ROOT}/${id}`)) {
      problems.push(
        `cdk-app/ecs_containers/services/${id} is not declared under services in framework.config.ts.`,
      );
    }
  }

  for (const id of taskIds) {
    if (!declaredContainerDirectories.has(`${TASK_SOURCE_ROOT}/${id}`)) {
      problems.push(
        `cdk-app/ecs_containers/tasks/${id} is not declared under tasks in framework.config.ts.`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `framework.config.ts and the repository disagree:\n  - ${problems.join("\n  - ")}`,
    );
  }
  return directories;
}

/**
 * The browser's view of the routing table: public paths, how each is
 * authenticated, and the WebSocket route keys.
 *
 * A projection rather than a second authored route map — `framework:check`
 * fails when it drifts. It exists so `@repo/api-contract` can stop importing
 * the whole root config at runtime: cloud environment declarations, secret
 * identifiers and build settings have no business in a frontend bundle, and a
 * browser has no use for them.
 */
function routesModule(config: FrameworkConfig): string {
  const routes = framework.getAllHttpRoutes(config);
  const list = (name: string, values: readonly string[]) => [
    `export const ${name} = [`,
    ...values.map((value) => `  ${JSON.stringify(value)},`),
    "] as const;",
  ];
  const paths = (authenticated: boolean) =>
    routes
      .filter((route) => (route.auth === true) === authenticated)
      .map((route) => framework.getPublicRoutePath(route.path));
  // Explicit agent browser routes are served by AgentCore rather
  // than the HTTP API. Every declared route is listed whatever its deploy scope,
  // as routes are, so a deploy toggle never breaks the client's typecheck.
  const browserAgents = framework.getAgentBrowserRoutes(config);
  const agentRoutes = agentRouteDeclarations(browserAgents);

  return [
    "/* This file is generated by npm run framework:generate. Do not edit. */",
    "",
    ...(agentRoutes.imports.length > 0 ? [...agentRoutes.imports, ""] : []),
    "/**",
    " * Public route key -> the URL a client actually calls. A catch-all mount",
    ' * resolves to its public prefix, so `API_ROUTE["/langgraph/*"]` is `"/langgraph"`.',
    " */",
    "export const API_ROUTE = {",
    ...routes.map(
      (route) =>
        `  ${JSON.stringify(route.path)}: ${JSON.stringify(framework.getPublicRoutePath(route.path))},`,
    ),
    "} as const;",
    "",
    "/** Paths reachable without an access token. */",
    ...list("PUBLIC_API_ROUTES", paths(false)),
    "",
    "/** HTTP API paths that require the user's session. Agent paths are in AGENT_ROUTE. */",
    ...list("AUTHENTICATED_API_ROUTES", paths(true)),
    "",
    agentRoutes.body,
    "",
    "/** API Gateway WebSocket route keys. */",
    ...list(
      "WEBSOCKET_ROUTES",
      framework
        .normalizeFrameworkConfig(config)
        .webSocket.map((binding) => binding.routeKey),
    ),
    "",
  ].join("\n");
}

/**
 * The event-replay manifest: replay id -> the Lambda target that captures it.
 *
 * Derived from `localReplay` on the config's event declarations, which is the
 * same derivation `getEventReplayManifest` performs — but performed once, here,
 * instead of at every cold start of a handler that wanted one lookup out of it.
 *
 * Emitted as plain literals with no import, so the module a Lambda reaches for
 * this has no edge into the framework's runtime facade at all.
 */
function eventReplayModule(config: FrameworkConfig): string {
  const manifest = framework.getEventReplayManifest(config) as Readonly<
    Record<string, string>
  >;
  return [
    "/* This file is generated by npm run framework:generate. Do not edit. */",
    "",
    "/**",
    " * Replay id -> the Lambda target that captures it, for every event handler",
    " * whose declaration sets `localReplay`.",
    " *",
    " * Used directly by `@repo/framework/runtime/event-replay`: a capture check",
    " * is a lookup. A deployed handler does not load the root configuration or",
    " * its projection machinery to make it.",
    " */",
    "export const EVENT_REPLAY_MANIFEST = {",
    ...Object.entries(manifest)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, reference]) => `  ${JSON.stringify(id)}: ${JSON.stringify(reference)},`),
    "} as const;",
    "",
    "/** The replay ids `withLocalReplay` will capture under. */",
    "export type EventReplayId = keyof typeof EVENT_REPLAY_MANIFEST;",
    "",
  ].join("\n");
}

/**
 * Every target's payload contract, projected into one module each.
 *
 * Every target is swept, not just the routed ones, so a Lambda AWS invokes
 * directly can expose a payload contract too. A workflow has no source and so
 * no adjacent contract; it is skipped rather than reported.
 */
async function projectContracts(
  config: FrameworkConfig,
  directories: ReadonlyMap<string, string>,
): Promise<readonly ProjectedContract[]> {
  const projected: ProjectedContract[] = [];
  const targets = [...framework.getFrameworkTargets(config)].sort(
    (left: NormalizedTarget, right: NormalizedTarget) =>
      left.reference.localeCompare(right.reference),
  );

  for (const target of targets) {
    // A tool's contract is what a model reads, not a browser payload; it is
    // projected into the AgentCore module instead.
    if (target.role === "tool") continue;
    const directory = directories.get(target.reference);
    if (!directory) continue;
    const typescriptContract = path.join(directory, "contract.ts");
    const jsonContract = path.join(directory, "contract.schema.json");
    const moduleName = contractModuleName(target.reference);
    const file = path.join(contractModuleDirectory, `${moduleName}.ts`);
    const common = {
      reference: target.reference,
      file,
      specifier: `./contracts/${moduleName}`,
      namespace: contractNamespaceName(target.reference),
    };

    if (existsSync(typescriptContract)) {
      const relativeSource = path
        .relative(repositoryRoot, typescriptContract)
        .replaceAll("\\", "/");
      const sourceText = readFileSync(typescriptContract, "utf8");
      // Read as text and inspected as a syntax tree. A contract module is never
      // executed here: generation must not be a way to run handler code.
      const { exports } = readContractModule(sourceText, relativeSource);
      if (exports.length === 0) {
        throw new Error(
          `${relativeSource} exports nothing. A payload contract declares the request and response shapes its target accepts and returns.`,
        );
      }
      projected.push({
        ...common,
        kind: "typescript",
        exports,
        contents: typescriptContractModule({
          reference: target.reference,
          source: relativeSource,
          sourceText,
        }),
      });
      continue;
    }

    if (existsSync(jsonContract)) {
      const relativeSource = path.relative(repositoryRoot, jsonContract).replaceAll("\\", "/");
      const document = JSON.parse(readFileSync(jsonContract, "utf8")) as {
        request?: JSONSchema;
        response?: JSONSchema;
      };
      if (!document.request || !document.response) {
        throw new Error(`${jsonContract} must contain request and response JSON Schemas.`);
      }
      const typePrefix = target.id
        .split("-")
        .map((part) => part[0].toUpperCase() + part.slice(1))
        .join("");
      // `compile` emits interfaces, so both halves of a JSON contract are types.
      const names: readonly ContractExport[] = [
        { name: `${typePrefix}Request`, isType: true },
        { name: `${typePrefix}Response`, isType: true },
      ];
      const declarations = [
        await compile(document.request, names[0].name, { bannerComment: "" }),
        await compile(document.response, names[1].name, { bannerComment: "" }),
      ];
      projected.push({
        ...common,
        kind: "json-schema",
        exports: names,
        contents: jsonSchemaContractModule({
          reference: target.reference,
          source: relativeSource,
          declarations,
        }),
      });
    }
  }

  return projected;
}

/**
 * Every tool's and agent's contract, evaluated and projected into
 * `src/generated/agentcore.ts`. See `./agentcore-contracts` for why a contract
 * is evaluated here and nowhere else.
 */
async function agentCoreProjection(
  config: FrameworkConfig,
  directories: ReadonlyMap<string, string>,
): Promise<string> {
  const tools: ToolContractFacts[] = [];
  const agents: AgentContractFacts[] = [];
  for (const target of framework.getFrameworkTargets(config)) {
    if (target.role !== "tool" && target.role !== "agent") continue;
    const origin = target.origins[0] ?? target.reference;
    const file = path.join(directories.get(target.reference)!, "contract.ts");
    const relative = path.relative(repositoryRoot, file).replaceAll("\\", "/");
    if (!existsSync(file)) {
      throw new Error(
        `${origin} needs ${relative}: ${target.role === "tool" ? "export const contract = { description, request, response }" : "export const contract = { request, response } or { request, event }"}, as Zod schemas.`,
      );
    }
    // Containment first, as a syntax tree: only then is the module imported.
    readContractModule(readFileSync(file, "utf8"), relative);
    const module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    if (target.role === "tool") {
      tools.push(readToolContract(module, { id: target.id, auth: config.tools?.[target.id]?.auth === true }));
    } else {
      const declaration = config.agents?.[target.id];
      agents.push(
        readAgentContract(module, {
          id: target.id,
          auth: declaration?.auth === true,
          tools: [...(declaration?.tools ?? [])],
        }),
      );
    }
  }
  assertWorkflowAgentsRespond(
    framework
      .getFrameworkTargets(config)
      .filter((target) => target.kind === "workflow")
      .map((workflow) => ({
        origin: workflow.origins[0] ?? workflow.reference,
        targets: framework.getWorkflowStepTargets(config, workflow.id),
      })),
    agents,
  );
  return agentCoreModule(tools, agents);
}

async function main(): Promise<void> {
  const lambdaDirectories = lambdaDirectoriesById(lambdaRoot);
  const serviceIds = directoryIds(serviceRoot);
  const taskIds = directoryIds(taskRoot);

  // Before the config is imported, because reading the source is what can name
  // the file a bad key came from. Importing first would surface the same
  // collision from `defineFrameworkConfig`, which knows only its position in
  // the array. It is also where config-authored workflow ids come from, since
  // no directory scan can find a target with no source.
  const sectionKeys = readSectionKeys(configFile, { repositoryRoot });
  const workflowIds = [...sectionKeys.workflows].sort();

  // Both id projections are written before the config is loaded:
  // framework.config.ts is typed against them, so a newly added handler
  // directory or workflow key has to be able to reach this file without a
  // hand-edit first, and in one run rather than two.
  writeGenerated(
    targetIdsFile,
    idsModule(lambdaDirectories, serviceIds, taskIds, workflowIds, [...sectionKeys.agents].sort()),
  );

  // `--check` writes nothing, so on a repository whose id union has never been
  // generated there is nothing for the framework module to import. Say that
  // plainly here: the alternative is a bare "Cannot find module
  // './generated/target-ids'" from the dynamic import below, which describes
  // the symptom and not the repair.
  if (checkOnly && !existsSync(targetIdsFile)) {
    console.error(
      `Generated framework files are stale (${staleFiles.join(", ")}). Run npm run framework:generate.`,
    );
    process.exitCode = 1;
    return;
  }

  framework = await import("../src/config/index");
  source = await import("../src/config/source");
  const { default: config } = (await import("../../../framework.config")) as {
    default: FrameworkConfig;
  };

  // The same validator CDK synth and both dev servers run, so generation cannot
  // succeed on config that would fail to boot.
  framework.validateFrameworkConfig(config);
  const directories = assertConfigMatchesRepository(
    config,
    serviceIds,
    taskIds,
    lambdaDirectories,
  );

  stageGenerated(routesFile, routesModule(config));
  stageGenerated(eventReplayFile, eventReplayModule(config));
  stageGenerated(agentCoreFile, await agentCoreProjection(config, directories));

  const projected = await projectContracts(config, directories);
  for (const contract of projected) stageGenerated(contract.file, contract.contents);
  stageGenerated(contractsFile, contractsBarrel(projected));
  // The contract directory is generated output in full, so a module this run
  // did not produce belonged to a contract that was removed, renamed, or moved
  // to a target that no longer exists.
  const produced = new Set(projected.map((contract) => contract.file));
  if (existsSync(contractModuleDirectory)) {
    for (const entry of readdirSync(contractModuleDirectory)) {
      const file = path.join(contractModuleDirectory, entry);
      if (!produced.has(file)) removeGenerated(file);
    }
  }
  // cdk-app/.env*.example are authored templates. Generation never writes them
  // and --check never compares them, so a declared input or secret is added to
  // them by hand.
  const { serviceEnvironmentExample } = await import("./env-examples");
  for (const target of framework.getFrameworkTargets(config)) {
    if (target.kind !== "service") continue;
    const directory = directories.get(target.reference)!;
    stageGenerated(path.join(directory, ".env.example"), serviceEnvironmentExample(
      config, target, source.resolveServicePort(config, target.id, { repositoryRoot }),
    ));
  }
  // Tasks read authored inputs from cdk-app/.env and receive their values from
  // CDK or from local startup. Deliberately no per-task
  // authored .env file: a task is launched, not run by a developer, and a second
  // authored input file would be one more place its environment could disagree.
  flushStaged();

  if (staleFiles.length > 0) {
    console.error(
      `Generated framework files are stale (${staleFiles.join(", ")}). Run npm run framework:generate.`,
    );
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  restoreWrites();
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
