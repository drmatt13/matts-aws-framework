import type { DockerStatusView } from "../../shared/machine";

/** One in-flight host probe, even across forced reads from different workspaces. */
export class DockerStatus {
  private current?: DockerStatusView;
  private completedAt = -Infinity;
  private pending?: Promise<DockerStatusView>;
  private generation = 0;
  constructor(private readonly probe: () => Promise<Omit<DockerStatusView, "observedAt">>,
    private readonly emit: (status: DockerStatusView) => void, private readonly now = Date.now) {}

  invalidate(): void { this.completedAt = -Infinity; this.generation++; }

  read(force = false): Promise<DockerStatusView> {
    if (this.pending) return this.pending;
    if (!force && this.current && this.now() - this.completedAt < 5000) return Promise.resolve(this.current);
    const generation = this.generation;
    const pending: Promise<DockerStatusView> = this.probe().then(result => {
      if (generation !== this.generation) {
        // A startup completed during this read. Do not publish evidence from before it.
        this.pending = undefined;
        return this.read(true);
      }
      const previousTime = this.current ? Date.parse(this.current.observedAt) : 0;
      const observedAt = new Date(Math.max(this.now(), previousTime + 1)).toISOString();
      const changed = !this.current || JSON.stringify({ docker: this.current.docker, checks: this.current.checks }) !== JSON.stringify(result);
      this.current = { ...result, observedAt };
      this.completedAt = this.now();
      if (changed) this.emit(this.current);
      return this.current;
    }).catch(error => { this.completedAt = -Infinity; throw error; })
      .finally(() => { if (this.pending === pending) this.pending = undefined; });
    this.pending = pending;
    return pending;
  }
}
