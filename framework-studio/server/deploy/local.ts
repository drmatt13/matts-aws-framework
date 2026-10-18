import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { parse as parseYaml } from "yaml";
import type { DockerView, LocalRunView, ManagedProcessView, ServiceView } from "../../shared/deploy";
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
  readonly startedAt: string;
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
  ) {
    this.project = composeProjectName(root, env);
    this.recordFile = path.join(stateDirectory, "local", "run.json");
  }

  runRecord(): RunRecord | undefined {
    try { return JSON.parse(readFileSync(this.recordFile, "utf8")) as RunRecord; } catch { return undefined; }
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
    for (const file of [this.env.FRAMEWORK_INPUTS_FILE, path.join(this.root, "cdk-app", ".env.dev"), path.join(this.root, "cdk-app", ".env")]) {
      if (!file || !existsSync(file)) continue;
      const value = parseEnv(readFileSync(file, "utf8")).LOCAL_DEV_URL;
      if (value) return value;
    }
    return "http://localhost:3000";
  }

  async services(): Promise<(ServiceView & { readonly id: string })[]> {
    const listed = await this.run(this.tools.docker(["ps", "-a", "--filter", `label=com.docker.compose.project=${this.project}`, "--format", "{{json .}}"], this.env), { timeoutMs: 15_000 });
    return listed.code === 0 ? parseServices(listed.stdout, oneShotServices(this.root)) : [];
  }

  /** Every container of this project: Compose's, and the task and Lambda containers the runner started. */
  async containerIds(): Promise<string[]> {
    const ids = new Set<string>();
    for (const label of [`com.docker.compose.project=${this.project}`, `com.matts-aws-framework.project=${this.project}`]) {
      const listed = await this.run(this.tools.docker(["ps", "-q", "--filter", `label=${label}`], this.env), { timeoutMs: 15_000 });
      if (listed.code === 0) for (const id of listed.stdout.split(/\s+/).filter(Boolean)) ids.add(id);
    }
    return [...ids];
  }

  private async startedAt(ids: readonly string[]): Promise<Map<string, number>> {
    const started = new Map<string, number>();
    if (!ids.length) return started;
    const inspected = await this.run(this.tools.docker(["inspect", "--format", "{{.Id}}|{{.State.StartedAt}}", ...ids], this.env), { timeoutMs: 15_000 });
    for (const line of inspected.stdout.split(/\r?\n/)) {
      const [id, time] = line.trim().split("|");
      if (id && time) {
        const match = ids.find((short) => id.startsWith(short));
        if (match) started.set(match, Date.parse(time));
      }
    }
    return started;
  }

  async view(docker: DockerView, managed: { readonly watch: ManagedProcessView; readonly client: ManagedProcessView }): Promise<LocalRunView> {
    const exported = this.exported();
    const services = docker.engine === "running" ? await this.services() : [];
    const running = services.filter((service) => service.state === "running" && !service.oneShot);
    // A service started before the latest export runs with the previous outputs:
    // Compose interpolates the root .env when it creates a container.
    const started = exported.at !== undefined ? await this.startedAt(running.map((service) => service.id)) : new Map<string, number>();
    const restartNeeded = running.filter((service) => (started.get(service.id) ?? Infinity) < exported.at! - 1000).map((service) => service.name);
    const record = this.runRecord();
    const { at: _at, ...files } = exported;
    return {
      project: this.project,
      docker,
      services: services.map(({ id: _id, ...service }) => service),
      watch: managed.watch,
      client: managed.client,
      exported: files,
      startedBy: running.length === 0 ? "none" : record ? "studio" : "outside",
      ...(record?.profile ? { profile: record.profile } : {}),
      ...(running.length || managed.client.running ? { appUrl: this.appUrl() } : {}),
      restartNeeded,
    };
  }

  async logs(service: string, tail = 300): Promise<string> {
    const match = (await this.services()).find((entry) => entry.name === service || entry.container === service);
    if (!match) throw Object.assign(new Error(`${service} is not a container of ${this.project}.`), { status: 404 });
    const result = await this.run(this.tools.docker(["logs", "--tail", String(tail), "--timestamps", match.id], this.env), { timeoutMs: 20_000 });
    // docker logs writes the container's stderr to its own stderr.
    return `${result.stdout}${result.stderr}`.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
  }
}
