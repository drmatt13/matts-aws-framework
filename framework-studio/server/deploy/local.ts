import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { parse as parseYaml } from "yaml";
import { setTimeout as delay } from "node:timers/promises";
import type { DockerView, JobView, LocalRunView, ManagedProcessView, ServiceView } from "../../shared/deploy";
import type { Runner, Tools } from "./process";

/**
 * Local development, as Docker records it: the Compose project's containers by
 * label (which needs no root .env, unlike `compose ps`), what the exported files
 * on this machine point at, and whether Studio started the stack.
 *
 * Containers outlive Studio on purpose; the watch and the web client are
 * Studio's own processes and stop with it.
 */

export interface RunRecord {
  readonly profile: string;
  readonly deployment: string;
  readonly account?: string;
  readonly region?: string;
  readonly startedAt: string;
}

/** Safe, actionable lifecycle refusal; no private CLI output is attached. */
export class LocalRuntimeConflict extends Error {
  readonly status = 409;
}

export const activeContainerState = (state: string) => ["running", "restarting", "paused", "removing"].includes(state);

/** A detached worker must not forget watch/client jobs still owned by the Studio host. */
export function persistedLocalHolder(stateDirectory: string, lock: string): JobView | undefined {
  const kinds = lock === "local" ? ["local-start", "local-stop", "local-restart", "local-attach-watch"]
    : lock === "local-watch" || lock === "local-client" ? [lock] : [];
  if (!kinds.length) return undefined;
  const directory = path.join(stateDirectory, "jobs");
  if (!existsSync(directory)) return undefined;
  for (const file of readdirSync(directory).filter(file => file.endsWith(".json"))) {
    let value: { id?: unknown; kind?: unknown; status?: unknown };
    try { value = JSON.parse(readFileSync(path.join(directory, file), "utf8")); } catch { throw new LocalRuntimeConflict("Local operation evidence is unreadable. Open Studio and check local runtime before changing development resources."); }
    if (value.status === "running" && typeof value.kind === "string" && kinds.includes(value.kind) && typeof value.id === "string")
      return { id: value.id, kind: value.kind as JobView["kind"], status: "running", title: "Local runtime", params: {}, startedAt: "", lastSeq: 0 };
  }
  return undefined;
}

/** As packages/framework/src/local/paths.ts names the Compose project. */
export function composeProjectName(root: string, env: NodeJS.ProcessEnv): string {
  const configured = env.COMPOSE_PROJECT_NAME?.trim();
  return (configured || path.basename(root)).toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^[_-]+/, "");
}

/** Services something else waits on to finish: migrations, seeds. Exited 0 is their success. */
export function oneShotServices(root: string): Set<string> {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (inner && typeof inner === "object" && (inner as { condition?: unknown }).condition === "service_completed_successfully") found.add(key);
      visit(inner);
    }
  };
  for (const file of ["docker-compose.yml", "docker-compose.services.yml"]) {
    const full = path.join(root, file);
    if (!existsSync(full)) continue;
    try { visit(parseYaml(readFileSync(full, "utf8"), { merge: true, maxAliasCount: -1 })); } catch { /* Compose reports its own file's errors. */ }
  }
  return found;
}

interface PsLine { ID: string; Names: string; State: string; Status: string; Ports?: string; Labels?: string }

function labels(text: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of (text ?? "").split(",")) {
    const at = pair.indexOf("=");
    if (at > 0) result[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return result;
}

export function parseServices(output: string, oneShots: ReadonlySet<string>): (ServiceView & { readonly id: string })[] {
  const services: (ServiceView & { id: string })[] = [];
  for (const raw of output.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let line: PsLine;
    try { line = JSON.parse(raw) as PsLine; } catch { continue; }
    const tags = labels(line.Labels);
    const name = tags["com.docker.compose.service"] ?? line.Names;
    const health = /\(healthy\)/.test(line.Status) ? "healthy" : /\(unhealthy\)/.test(line.Status) ? "unhealthy" : /health: starting/.test(line.Status) ? "starting" : undefined;
    const exit = /Exited \((-?\d+)\)/.exec(line.Status);
    services.push({
      id: line.ID, name, container: line.Names, state: line.State, oneShot: oneShots.has(name), ports: line.Ports ?? "",
      ...(health ? { health } : {}),
      ...(exit ? { exitCode: Number(exit[1]) } : {}),
    });
  }
  return services.sort((a, b) => Number(a.oneShot) - Number(b.oneShot) || a.name.localeCompare(b.name));
}

export class LocalEnvironment {
  readonly project: string;
  private readonly recordFile: string;

  constructor(
    private readonly root: string,
    private readonly tools: Tools,
    private readonly run: Runner,
    private readonly env: NodeJS.ProcessEnv,
    /** Where export writes the root .env and resources (the repository root, unless a test says otherwise). */
    readonly exportDirectory: string,
    stateDirectory: string,
    private readonly disabledServices: () => ReadonlySet<string> = () => new Set(),
  ) {
    this.project = composeProjectName(root, env);
    this.recordFile = path.join(stateDirectory, "local", "run.json");
  }

  runRecord(): RunRecord | undefined {
    try {
      const value = JSON.parse(readFileSync(this.recordFile, "utf8"));
      if (!value || typeof value.profile !== "string" || typeof value.deployment !== "string" || typeof value.startedAt !== "string") return undefined;
      return { profile: value.profile, deployment: value.deployment, startedAt: value.startedAt,
        ...(typeof value.account === "string" ? { account: value.account } : {}),
        ...(typeof value.region === "string" ? { region: value.region } : {}) };
    } catch { return undefined; }
  }

  writeRunRecord(record: RunRecord): void {
    mkdirSync(path.dirname(this.recordFile), { recursive: true });
    writeFileSync(this.recordFile, JSON.stringify(record, null, 2));
  }

  clearRunRecord(): void {
    rmSync(this.recordFile, { force: true });
  }

  exported(): LocalRunView["exported"] & { readonly at?: number } {
    const file = path.join(this.exportDirectory, ".env");
    const values = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
    return {
      ...(values.LOCAL_FRAMEWORK_DEPLOYMENT ? { deployment: values.LOCAL_FRAMEWORK_DEPLOYMENT } : {}),
      ...(values.LOCAL_FRAMEWORK_ACCOUNT ? { account: values.LOCAL_FRAMEWORK_ACCOUNT } : {}),
      ...(values.LOCAL_AWS_REGION ? { region: values.LOCAL_AWS_REGION } : {}),
      client: existsSync(path.join(this.exportDirectory, "client-app", ".env.development.local")),
      ...(existsSync(file) ? { at: statSync(file).mtimeMs } : {}),
    };
  }

  /** The origin the web client serves, from the development inputs. */
  appUrl(): string {
    for (const file of [this.env.FRAMEWORK_INPUTS_FILE, path.join(this.root, "cdk-app", ".env.dev")]) {
      if (!file || !existsSync(file)) continue;
      const value = parseEnv(readFileSync(file, "utf8")).LOCAL_DEV_URL;
      if (value) return value;
    }
    return "http://localhost:3000";
  }

  async services(): Promise<(ServiceView & { readonly id: string })[]> {
    const listed = await this.run(this.tools.docker(["ps", "-a", "--filter", `label=com.docker.compose.project=${this.project}`, "--format", "{{json .}}"], this.env), { timeoutMs: 15_000 });
    const disabled = this.disabledServices();
    if (listed.code !== 0) throw new Error("Could not read this checkout's local containers. Check Docker and try again.");
    return parseServices(listed.stdout, oneShotServices(this.root)).map(service =>
      disabled.has(service.name) && service.state === "exited" && service.exitCode === 0 ? { ...service, disabledByDeploy: true as const } : service);
  }

  /** Active containers in this checkout, including paused/partial runner work. */
  async activeContainers(compose?: readonly (ServiceView & { readonly id: string })[]): Promise<{ readonly id: string; readonly state: string }[]> {
    const active = new Map<string, { id: string; state: string }>();
    for (const label of [`com.docker.compose.project=${this.project}`, `com.matts-aws-framework.project=${this.project}`]) {
      if (compose && label.startsWith("com.docker.compose.project=")) {
        for (const service of compose) if (activeContainerState(service.state)) active.set(service.id, { id: service.id, state: service.state });
        continue;
      }
      const listed = await this.run(this.tools.docker(["ps", "-a", "--filter", `label=${label}`, "--format", "{{json .}}"], this.env), { timeoutMs: 15_000 });
      if (listed.code !== 0) throw new LocalRuntimeConflict("Could not inspect this checkout's local containers. Check Docker before changing development resources.");
      for (const line of listed.stdout.split(/\r?\n/).filter(Boolean)) {
        let container: { ID?: unknown; State?: unknown };
        try { container = JSON.parse(line); } catch { throw new LocalRuntimeConflict("Local container status is unreadable. Check Docker before changing development resources."); }
        if (typeof container.ID !== "string" || typeof container.State !== "string" || !["created", "running", "restarting", "paused", "removing", "exited", "dead"].includes(container.State)) throw new LocalRuntimeConflict("Local container status is unavailable. Check Docker before changing development resources.");
        if (activeContainerState(container.State)) active.set(container.ID, { id: container.ID, state: container.State });
      }
    }
    return [...active.values()];
  }

  /** Every active container of this project; stopped/created containers and volumes are kept. */
  async containerIds(): Promise<string[]> {
    return (await this.activeContainers()).map(container => container.id);
  }

  async assertStopped(docker: DockerView, managed: { readonly watch: ManagedProcessView; readonly client: ManagedProcessView }): Promise<void> {
    if (managed.watch.running || managed.client.running) throw new LocalRuntimeConflict("Stop local runtime before changing development resources.");
    if (docker.engine === "unknown") throw new LocalRuntimeConflict("Local runtime status is unavailable. Check Docker and stop local runtime before changing development resources.");
    if (docker.engine !== "running") return;
    if ((await this.activeContainers()).length) throw new LocalRuntimeConflict("Stop local runtime before changing development resources.");
  }

  private async startedAt(ids: readonly string[]): Promise<Map<string, number>> {
    const started = new Map<string, number>();
    if (!ids.length) return started;
    const inspected = await this.run(this.tools.docker(["inspect", "--format", "{{.Id}}|{{.State.StartedAt}}", ...ids], this.env), { timeoutMs: 15_000 });
    if (inspected.code !== 0) throw new Error("Could not verify when the local containers started. Check Docker and try again.");
    for (const line of inspected.stdout.split(/\r?\n/)) {
      const [id, time] = line.trim().split("|");
      if (id && time) {
        const match = ids.find((short) => id.startsWith(short));
        if (match) started.set(match, Date.parse(time));
      }
    }
    return started;
  }

  /** Compose resolves generated includes and operator overrides; only names and lifecycle are retained. */
  private async expectedServices(): Promise<Map<string, { readonly oneShot: boolean }>> {
    const result = await this.run(this.tools.docker(["compose", "config", "--format", "json"], { ...this.env, COMPOSE_PROFILES: "" }), { timeoutMs: 15_000 });
    const message = "Could not read the local Compose configuration. Check the exported development settings and Compose files, then try again.";
    if (result.code !== 0) throw new Error(message);
    let configuration: { services?: Record<string, any> };
    try { configuration = JSON.parse(result.stdout); } catch { throw new Error(message); }
    if (!configuration?.services || typeof configuration.services !== "object" || Array.isArray(configuration.services)) throw new Error(message);
    const disabled = this.disabledServices();
    const defaults = Object.entries(configuration.services).filter(([name, service]) => service && typeof service === "object"
      && !(Array.isArray(service.profiles) && service.profiles.length) && service.scale !== 0 && service.deploy?.replicas !== 0 && !disabled.has(name));
    const oneShots = new Set<string>();
    for (const [, service] of defaults) for (const [dependency, requirement] of Object.entries(service.depends_on ?? {})) {
      if (requirement && typeof requirement === "object" && (requirement as { condition?: string }).condition === "service_completed_successfully") oneShots.add(dependency);
    }
    return new Map(defaults.map(([name]) => [name, { oneShot: oneShots.has(name) }]));
  }

  async view(docker: DockerView, managed: { readonly watch: ManagedProcessView; readonly client: ManagedProcessView }): Promise<LocalRunView> {
    const exported = this.exported();
    let observationProblem: string | undefined = docker.engine === "unknown" ? docker.problem ?? "Could not determine whether Docker is running. Check Docker and try again." : undefined;
    const services = docker.engine === "running" ? await this.services().catch(() => {
      observationProblem = "Could not read this checkout's local containers. Check Docker and try again.";
      return [];
    }) : [];
    const running = services.filter((service) => activeContainerState(service.state) && !service.oneShot);
    const activeContainerCount = docker.engine === "unknown" || observationProblem ? undefined : docker.engine !== "running" ? 0 : await this.activeContainers(services).then(containers => containers.length).catch(() => {
      observationProblem = "Could not inspect all of this checkout's local containers. Check Docker and try again.";
      return undefined;
    });
    // A service started before the latest export runs with the previous outputs:
    // Compose interpolates the root .env when it creates a container.
    const started = exported.at !== undefined ? await this.startedAt(running.map((service) => service.id)).catch(() => {
      observationProblem = "Could not verify when the local containers started. Check Docker and try again.";
      return new Map<string, number>();
    }) : new Map<string, number>();
    const restartNeeded = running.filter((service) => (started.get(service.id) ?? Infinity) < exported.at! - 1000).map((service) => service.name);
    const record = this.runRecord();
    const active = Boolean(activeContainerCount) || managed.watch.running || managed.client.running;
    const { at: _at, ...files } = exported;
    return {
      project: this.project,
      ...(activeContainerCount !== undefined ? { activeContainerCount } : {}),
      docker,
      services: services.map(({ id: _id, ...service }) => service),
      watch: managed.watch,
      client: managed.client,
      exported: files,
      startedBy: !active ? "none" : record ? "studio" : "outside",
      ...(record?.profile ? { profile: record.profile } : {}),
      ...(record && active ? { binding: record } : {}),
      ...(observationProblem ? { observationProblem } : {}),
      ...(running.length || managed.client.running ? { appUrl: this.appUrl() } : {}),
      restartNeeded,
      readiness: observationProblem ? { state: "blocked", observedAt: new Date().toISOString(), message: observationProblem }
        : restartNeeded.length ? { state: "blocked", observedAt: new Date().toISOString(), message: "Local settings changed after these containers started. Restart local runtime to use the current development outputs." }
        : await this.readiness(services, managed),
    };
  }

  /** Observation, not an inference from a successful process launch. */
  async readiness(services: readonly ServiceView[], managed: { readonly watch: ManagedProcessView; readonly client: ManagedProcessView }) {
    const disabled = this.disabledServices();
    // The launcher exits successfully when Deploy is off. Keep genuine startup
    // failures visible, even for a currently disabled declaration.
    services = services.filter(service => !(disabled.has(service.name) && service.state === "exited" && service.exitCode === 0));
    const observedAt = new Date().toISOString();
    const result = (state: "ready" | "starting" | "blocked" | "stopped", message: string) => ({ state, observedAt, message });
    if (!services.some(service => activeContainerState(service.state)) && !managed.client.running && !managed.watch.running) return result("stopped", "Local services are stopped.");
    let expected: Map<string, { readonly oneShot: boolean }>;
    try { expected = await this.expectedServices(); }
    catch (error) { return result("blocked", error instanceof Error ? error.message : "Could not read the local Compose configuration."); }
    // Profiled maintenance containers do not establish compute readiness. A
    // disabled declaration's genuine failed launcher remains actionable.
    services = services.filter(service => expected.has(service.name) || disabled.has(service.name))
      .map(service => ({ ...service, oneShot: expected.get(service.name)?.oneShot ?? service.oneShot }));
    const failed = services.filter(service => service.health === "unhealthy" || service.oneShot && service.exitCode !== undefined && service.exitCode !== 0 || !service.oneShot && service.state === "exited");
    if (failed.length) return result("blocked", `Needs attention: ${failed.map(service => service.name).join(", ")}. Open its logs. Database verification never applies changes; review initialization or migrations in Database.`);
    const missing = [...expected.keys()].filter(name => !services.some(service => service.name === name));
    if (missing.length) return result("starting", `Waiting for local containers: ${missing.join(", ")}. Startup is incomplete while required services are missing.`);
    if (!services.length || services.some(service => service.oneShot ? service.state !== "exited" || service.exitCode !== 0 : service.state !== "running" || service.health === "starting") || !managed.watch.running || !managed.client.running) return result("starting", "Waiting for local services, source watch and web client.");
    try {
      const response = await fetch(this.appUrl(), { signal: AbortSignal.timeout(1500), redirect: "manual" });
      await response.body?.cancel();
      if (response.status >= 200 && response.status < 400) return result("ready", "Services are running and the web client is reachable. Authentication and application behavior require their own checks.");
    } catch { /* A process can exist before binding its HTTP port. */ }
    return result("starting", "Containers started; waiting for the web client to answer HTTP requests.");
  }

  async waitUntilReady(signal: AbortSignal, managed: () => { readonly watch: ManagedProcessView; readonly client: ManagedProcessView }, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + Math.max(100, Math.min(120_000, timeoutMs));
    while (!signal.aborted) {
      const state = await this.readiness(await this.services(), managed());
      if (state.state === "ready") return;
      if (state.state === "blocked") throw new Error(state.message);
      if (Date.now() >= deadline) throw new Error(`${state.message} Startup is not confirmed. Services already started remain running; inspect their logs before restarting.`);
      await delay(500, undefined, { signal });
    }
    throw new Error("Readiness check stopped. Services already started remain running.");
  }

  async logs(service: string, tail = 300): Promise<string> {
    const match = (await this.services()).find((entry) => entry.name === service || entry.container === service);
    if (!match) throw Object.assign(new Error(`${service} is not a container of ${this.project}.`), { status: 404 });
    const result = await this.run(this.tools.docker(["logs", "--tail", String(tail), "--timestamps", match.id], this.env), { timeoutMs: 20_000 });
    // docker logs writes the container's stderr to its own stderr.
    return `${result.stdout}${result.stderr}`.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
  }
}
