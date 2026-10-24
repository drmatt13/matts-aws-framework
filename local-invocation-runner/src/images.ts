import { TASK_CONTAINER_KIND_LABEL, TASK_CONTAINER_PROJECT_LABEL } from "@repo/framework/local";
import type { DockerCommand } from "./tasks";

/**
 * Every image name this runner mints starts here: `matts-framework-<id>` for a
 * container Lambda and `matts-framework-task-<id>` for a task.
 */
export const RUNNER_IMAGE_PREFIX = "matts-framework-";

/** The kinds of image this runner builds, as the kind label names them. */
const RUNNER_IMAGE_KINDS = new Set(["task", "lambda"]);

/** A task build's private tag. The task supervisor releases these itself. */
const PREPARATION_TAG = /^matts-framework-task-[^:]+:prepare-[0-9a-f]+$/;

export interface RunnerImage {
  readonly id: string;
  readonly tags: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
}

/**
 * The image references a reconciliation removes: every name this runner
 * minted, for this project, that is not one to keep.
 *
 * What to keep is decided by the caller from the declarations: each declared
 * workload's current image, and every image something is using. Everything
 * else this runner named is superseded (older source, another architecture) or
 * orphaned (a target no longer declared). A name someone else gave an image is
 * never touched, and neither is a task build's private tag.
 */
export function planImageReclaim(
  images: readonly RunnerImage[],
  options: { readonly project: string; readonly keep: ReadonlySet<string> },
): string[] {
  const references = new Set<string>();
  for (const image of images) {
    if (!ownedBy(image, options.project)) continue;
    for (const tag of image.tags) {
      if (!tag.startsWith(RUNNER_IMAGE_PREFIX)) continue;
      if (options.keep.has(tag) || PREPARATION_TAG.test(tag)) continue;
      references.add(tag);
    }
  }
  return [...references];
}

function ownedBy(image: RunnerImage, project: string): boolean {
  const owner = image.labels[TASK_CONTAINER_PROJECT_LABEL];
  // Older images without a project label cannot prove ownership. A cache can
  // still be another checkout's current image, so leave it for manual review.
  return owner === project && RUNNER_IMAGE_KINDS.has(image.labels[TASK_CONTAINER_KIND_LABEL] ?? "");
}

export interface LocalImageJanitorOptions {
  readonly docker: DockerCommand;
  /** The Compose project this runner belongs to. Other projects' images are never touched. */
  readonly project: string;
  /** Every reference that must survive this pass: current images, and images in use. */
  readonly keep: () => ReadonlySet<string>;
  /**
   * Builds this runner has in flight. An untagged image is a superseded one,
   * unless a build is exporting it this moment and has yet to tag it.
   */
  readonly buildsInFlight: () => number;
}

export interface ImageReclaimSummary {
  /** Image names removed. Removing an image's last name removes the image. */
  readonly untagged: number;
  /** Untagged images removed, superseded when a newer build took their name. */
  readonly pruned: number;
  /** The daemon's own figure for the pruned images, such as "1.2GB". */
  readonly reclaimed?: string;
}

/**
 * Keeps the images this runner builds from accumulating.
 *
 * Reconciliation against the declarations, not a schedule: a pass keeps what
 * the configuration currently describes and removes the rest. One runs after
 * every build, which is when an image is superseded, and one when the runner
 * starts, which catches whatever a previous process left - a renamed target, a
 * changed architecture, a runner killed between a build and its pass.
 *
 * No removal is forced. The daemon refuses to remove an image any container
 * still uses, running or stopped, so a pass can never take an image from a
 * workload; the image is reclaimed by the first pass after its container goes.
 * Build cache is deliberately left alone: it is what makes rebuilding a
 * reclaimed image nearly free, and the builder bounds it with its own policy.
 */
export class LocalImageJanitor {
  private running: Promise<void> | undefined;
  private again = false;
  private closed = false;

  public constructor(private readonly options: LocalImageJanitorOptions) {}

  /**
   * Asks for a pass. One runs at a time, and every request made while one runs
   * folds into a single pass after it, so a burst of builds costs two passes.
   * Never rejects: a failed pass is reported and the next request retries.
   */
  public request(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.drain();
    return this.running;
  }

  /** Starts no further passes. A pass in progress is abandoned at its next removal. */
  public close(): void {
    this.closed = true;
  }

  /** One pass. */
  public async reconcile(): Promise<ImageReclaimSummary> {
    const { docker, project } = this.options;
    let untagged = 0;
    const ids = [
      ...new Set(
        (await docker("image", "ls", "--quiet", "--no-trunc", "--filter", `reference=${RUNNER_IMAGE_PREFIX}*`))
          .split(/\s+/)
          .filter(Boolean),
      ),
    ];
    if (ids.length > 0) {
      const images = parseInspection(
        await docker("image", "inspect", "--format", "{{json .Id}}\t{{json .RepoTags}}\t{{json .Config.Labels}}", ...ids),
      );
      // Read as late as possible, so an invocation that started while the
      // images were being listed is already holding the image it needs.
      const keep = this.options.keep();
      for (const reference of planImageReclaim(images, { project, keep })) {
        if (this.closed) break;
        await docker("image", "rm", reference).then(
          () => { untagged += 1; },
          () => undefined,
        );
      }
    }

    let pruned = 0;
    let reclaimed: string | undefined;
    // Every build ends in a pass, so the last build to finish prunes for all.
    if (!this.closed && this.options.buildsInFlight() === 0) {
      const ownImages = `label=${TASK_CONTAINER_PROJECT_LABEL}=${project}`;
      const superseded = new Set(
        (await docker("image", "ls", "--quiet", "--no-trunc", "--filter", "dangling=true", "--filter", ownImages))
          .split(/\s+/)
          .filter(Boolean),
      );
      if (superseded.size > 0) {
        // Prune rather than remove: it is one daemon-side step that skips any
        // image a container uses. Its output lists layers as well as images,
        // so only the images listed above are counted.
        const output = await docker("image", "prune", "--force", "--filter", ownImages);
        const deleted = new Set(
          output
            .split(/\r?\n/)
            .filter((line) => line.startsWith("deleted:"))
            .map((line) => line.slice("deleted:".length).trim()),
        );
        pruned = [...superseded].filter((id) => deleted.has(id)).length;
        reclaimed = /Total reclaimed space:\s*(\S+)/.exec(output)?.[1];
      }
    }
    return { untagged, pruned, ...(reclaimed === undefined ? {} : { reclaimed }) };
  }

  private async drain(): Promise<void> {
    for (;;) {
      this.again = false;
      try {
        const summary = await this.reconcile();
        if (summary.untagged > 0 || summary.pruned > 0) {
          console.log(
            `[images] removed ${summary.untagged} superseded image name(s) and ${summary.pruned} untagged image(s)` +
              (summary.reclaimed && summary.pruned > 0 ? ` (${summary.reclaimed} reclaimed)` : ""),
          );
        }
      } catch (error) {
        console.error(`[images] cleanup pass skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
      // Decided and cleared in one step, so a request cannot land between them.
      if (!this.again || this.closed) {
        this.running = undefined;
        return;
      }
    }
  }
}

function parseInspection(output: string): RunnerImage[] {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [id, tags, labels] = line.split("\t");
      return {
        id: JSON.parse(id) as string,
        tags: (JSON.parse(tags) as string[] | null) ?? [],
        labels: (JSON.parse(labels) as Record<string, string> | null) ?? {},
      };
    });
}
