import assert from "node:assert/strict";
import test from "node:test";
import { LocalImageJanitor, planImageReclaim, type RunnerImage } from "../src/images";

/**
 * The runner's image lifecycle.
 *
 * Docker is not required: the plan is a pure function of what the daemon
 * lists, and the janitor is driven through a recording stand-in for the CLI.
 */

const PROJECT = "matts-aws-framework";

function lambda(tag: string, labels: Record<string, string> = {}): RunnerImage {
  return {
    id: `sha256:${tag}`,
    tags: [tag],
    labels: {
      "com.matts-aws-framework.local-lambda": "true",
      "com.matts-aws-framework.kind": "lambda",
      "com.matts-aws-framework.project": PROJECT,
      ...labels,
    },
  };
}

function task(tags: string[], labels: Record<string, string> = {}): RunnerImage {
  return {
    id: `sha256:${tags.join(",")}`,
    tags,
    labels: { "com.matts-aws-framework.kind": "task", "com.matts-aws-framework.project": PROJECT, ...labels },
  };
}

test("an image superseded by newer source is removed and the current one kept", () => {
  const plan = planImageReclaim(
    [lambda("matts-framework-python-example:aaaa-arm64"), lambda("matts-framework-python-example:bbbb-arm64")],
    { project: PROJECT, keep: new Set(["matts-framework-python-example:bbbb-arm64"]) },
  );
  assert.deepEqual(plan, ["matts-framework-python-example:aaaa-arm64"]);
});

test("an image of a target no longer declared is removed", () => {
  const plan = planImageReclaim(
    [task(["matts-framework-task-approval-analyst:arm64"]), task(["matts-framework-task-invocation-test-task:amd64"])],
    { project: PROJECT, keep: new Set(["matts-framework-task-invocation-test-task:amd64"]) },
  );
  assert.deepEqual(plan, ["matts-framework-task-approval-analyst:arm64"]);
});

test("a task's image for an architecture it no longer declares is removed", () => {
  const plan = planImageReclaim(
    [task(["matts-framework-task-invocation-test-task:amd64"]), task(["matts-framework-task-invocation-test-task:arm64"])],
    { project: PROJECT, keep: new Set(["matts-framework-task-invocation-test-task:arm64"]) },
  );
  assert.deepEqual(plan, ["matts-framework-task-invocation-test-task:amd64"]);
});

test("an image in use is kept even after newer source supersedes it", () => {
  const plan = planImageReclaim([lambda("matts-framework-python-example:aaaa-arm64")], {
    project: PROJECT,
    keep: new Set(["matts-framework-python-example:bbbb-arm64", "matts-framework-python-example:aaaa-arm64"]),
  });
  assert.deepEqual(plan, []);
});

test("a task build's private tag belongs to the task supervisor", () => {
  const plan = planImageReclaim(
    [task(["matts-framework-task-invocation-test-task:amd64", "matts-framework-task-invocation-test-task:prepare-1a2b3c4d"])],
    { project: PROJECT, keep: new Set() },
  );
  assert.deepEqual(plan, ["matts-framework-task-invocation-test-task:amd64"]);
});

test("another project's images are never touched", () => {
  const plan = planImageReclaim(
    [
      task(["matts-framework-task-old:amd64"], { "com.matts-aws-framework.project": "other-checkout" }),
      lambda("matts-framework-python-example:aaaa-arm64", { "com.matts-aws-framework.project": "other-checkout" }),
    ],
    { project: PROJECT, keep: new Set() },
  );
  assert.deepEqual(plan, []);
});

test("a container-Lambda image built before project labels is reclaimable", () => {
  const legacy: RunnerImage = {
    id: "sha256:legacy",
    tags: ["matts-framework-python-example:d9208a381dd948f1-arm64"],
    labels: { "com.matts-aws-framework.local-lambda": "true", "com.amazonaws.lambda.platform.version": "sbxv2only" },
  };
  assert.deepEqual(planImageReclaim([legacy], { project: PROJECT, keep: new Set() }), [
    "matts-framework-python-example:d9208a381dd948f1-arm64",
  ]);
  assert.deepEqual(
    planImageReclaim([legacy], { project: PROJECT, keep: new Set(["matts-framework-python-example:d9208a381dd948f1-arm64"]) }),
    [],
  );
});

test("names this runner did not mint, and images it did not build, are left alone", () => {
  const plan = planImageReclaim(
    [
      task(["matts-framework-task-old:amd64", "my-debug-copy:latest"]),
      { id: "sha256:unlabelled", tags: ["matts-framework-something:latest"], labels: {} },
      task(["matts-framework-agent-x:latest"], { "com.matts-aws-framework.kind": "agent" }),
    ],
    { project: PROJECT, keep: new Set() },
  );
  assert.deepEqual(plan, ["matts-framework-task-old:amd64"]);
});

/** A stand-in for the Docker CLI that answers from a fixed image listing. */
function fakeDocker(
  images: readonly RunnerImage[],
  options: { readonly refuse?: ReadonlySet<string>; readonly untagged?: readonly string[]; readonly inUse?: ReadonlySet<string> } = {},
) {
  const calls: string[][] = [];
  const docker = async (...args: string[]): Promise<string> => {
    calls.push(args);
    const [, verb] = args;
    if (verb === "ls" && args.includes("dangling=true")) return (options.untagged ?? []).join("\n");
    if (verb === "ls") return images.map((image) => image.id).join("\n");
    if (verb === "inspect") {
      return images
        .map((image) => [JSON.stringify(image.id), JSON.stringify(image.tags), JSON.stringify(image.labels)].join("\t"))
        .join("\n");
    }
    if (verb === "rm") {
      if (options.refuse?.has(args[2])) throw new Error("conflict: image is being used by a container");
      return `Untagged: ${args[2]}`;
    }
    if (verb === "prune") {
      // As the daemon prints it: each deleted image followed by its own layers.
      const deleted = (options.untagged ?? [])
        .filter((id) => !options.inUse?.has(id))
        .flatMap((id) => [`deleted: ${id}`, `deleted: sha256:layer-of-${id}`]);
      return ["Deleted Images:", ...deleted, "", `Total reclaimed space: ${deleted.length > 0 ? "1.2GB" : "0B"}`].join("\n");
    }
    throw new Error(`unexpected docker ${args.join(" ")}`);
  };
  return { calls, docker };
}

test("a pass removes superseded names without force and prunes this project's untagged images", async () => {
  const { calls, docker } = fakeDocker(
    [lambda("matts-framework-python-example:aaaa-arm64"), lambda("matts-framework-python-example:bbbb-arm64")],
    { untagged: ["sha256:old-task-1", "sha256:old-task-2", "sha256:running-task"], inUse: new Set(["sha256:running-task"]) },
  );
  const janitor = new LocalImageJanitor({
    docker,
    project: PROJECT,
    keep: () => new Set(["matts-framework-python-example:bbbb-arm64"]),
    buildsInFlight: () => 0,
  });
  // Two images pruned, not four: their layers are listed too, and the image a
  // container still uses is skipped by the daemon.
  assert.deepEqual(await janitor.reconcile(), { untagged: 1, pruned: 2, reclaimed: "1.2GB" });
  assert.deepEqual(calls.at(0), ["image", "ls", "--quiet", "--no-trunc", "--filter", "reference=matts-framework-*"]);
  assert.deepEqual(
    calls.filter(([, verb]) => verb === "rm"),
    [["image", "rm", "matts-framework-python-example:aaaa-arm64"]],
  );
  assert.deepEqual(calls.at(-1), ["image", "prune", "--force", "--filter", `label=com.matts-aws-framework.project=${PROJECT}`]);
  assert.ok(calls.every((args) => !args.includes("--force") || args[1] === "prune"), "only prune, which spares images in use, is forced past its prompt");
});

test("an image the daemon refuses to remove is left for a later pass", async () => {
  const { docker } = fakeDocker([lambda("matts-framework-python-example:aaaa-arm64")], {
    refuse: new Set(["matts-framework-python-example:aaaa-arm64"]),
  });
  const janitor = new LocalImageJanitor({ docker, project: PROJECT, keep: () => new Set(), buildsInFlight: () => 0 });
  assert.deepEqual(await janitor.reconcile(), { untagged: 0, pruned: 0 });
});

test("nothing is pruned when nothing is untagged", async () => {
  const { calls, docker } = fakeDocker([]);
  const janitor = new LocalImageJanitor({ docker, project: PROJECT, keep: () => new Set(), buildsInFlight: () => 0 });
  assert.deepEqual(await janitor.reconcile(), { untagged: 0, pruned: 0 });
  assert.ok(!calls.some(([, verb]) => verb === "prune"));
});

test("untagged images are not pruned while a build may be exporting one", async () => {
  const { calls, docker } = fakeDocker([]);
  const janitor = new LocalImageJanitor({ docker, project: PROJECT, keep: () => new Set(), buildsInFlight: () => 1 });
  assert.deepEqual(await janitor.reconcile(), { untagged: 0, pruned: 0 });
  assert.ok(!calls.some(([, verb]) => verb === "prune"));
});

test("requests made during a pass fold into one more pass", async () => {
  let release: () => void = () => undefined;
  let passes = 0;
  const janitor = new LocalImageJanitor({
    docker: async (...args) => {
      if (args[1] === "ls" && !args.includes("dangling=true")) {
        passes += 1;
        if (passes === 1) await new Promise<void>((resolve) => { release = resolve; });
      }
      return "";
    },
    project: PROJECT,
    keep: () => new Set(),
    buildsInFlight: () => 0,
  });
  const first = janitor.request();
  const folded = [janitor.request(), janitor.request(), janitor.request()];
  release();
  await Promise.all([first, ...folded]);
  assert.equal(passes, 2);
  await janitor.request();
  assert.equal(passes, 3, "a request after the passes settle starts a new one");
});

test("a closed janitor starts no passes", async () => {
  const { calls, docker } = fakeDocker([]);
  const janitor = new LocalImageJanitor({ docker, project: PROJECT, keep: () => new Set(), buildsInFlight: () => 0 });
  janitor.close();
  await janitor.request();
  assert.equal(calls.length, 0);
});
