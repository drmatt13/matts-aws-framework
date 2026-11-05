import type { Mode } from "../../shared/model";
import { buildFocus, relevantDiagnostics } from "./focus";
import { bounded, omit, text } from "./safe";
import { buildWorkspace, workspaceFor } from "./workspace";
import type {
  Sightline,
  SightlineDeploymentInput,
  SightlineInputs,
  SightlineOmission,
  SightlineRecord,
} from "./types";
export type {
  Sightline,
  SightlineInputs,
  SightlineDeploymentInput,
} from "./types";

/** Compact JSON characters, also used by Copy JSON and the displayed count. */
export const SIGHTLINE_CHARACTER_BUDGET = 12_000;

function deployment(
  value: SightlineDeploymentInput,
  mode: Mode,
  omitted: SightlineOmission[],
): SightlineRecord {
  const path = `deployments.${mode}`;
  return {
    availability: value.availability,
    target: value.target
      ? {
          evidence: "declared",
          name: text(value.target.name, `${path}.target.name`, omitted),
          mode: value.target.mode,
          region: value.target.region
            ? text(value.target.region, `${path}.target.region`, omitted, 80)
            : undefined,
        }
      : null,
    observed: {
      evidence: "observed",
      availability: value.observed.availability,
      observedAt: value.observed.observedAt
        ? text(
            value.observed.observedAt,
            `${path}.observed.observedAt`,
            omitted,
            40,
          )
        : undefined,
      updatedAt: value.observed.updatedAt
        ? text(
            value.observed.updatedAt,
            `${path}.observed.updatedAt`,
            omitted,
            40,
          )
        : undefined,
      freshUntil: value.observed.freshUntil
        ? text(
            value.observed.freshUntil,
            `${path}.observed.freshUntil`,
            omitted,
            40,
          )
        : undefined,
      stale: value.observed.stale,
      state: value.observed.state
        ? text(value.observed.state, `${path}.observed.state`, omitted, 80)
        : undefined,
      stackCount: value.observed.stackCount,
      problemKind: value.observed.problemKind
        ? text(
            value.observed.problemKind,
            `${path}.observed.problemKind`,
            omitted,
            80,
          )
        : undefined,
    },
  };
}

function activity(
  inputs: SightlineInputs["activity"],
  omitted: SightlineOmission[],
): SightlineRecord {
  if (!inputs.jobs)
    return {
      evidence: "observed",
      availability: inputs.availability,
      running: null,
      recent: null,
    };
  const ordered = [...inputs.jobs].sort(
    (a, b) =>
      b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id),
  );
  const running = ordered.filter((job) => job.status === "running"),
    recent = ordered.filter((job) => job.status !== "running");
  omit(omitted, "activity.logs-params-titles-summaries-recovery", "privacy");
  const summarize = (job: (typeof ordered)[number]): SightlineRecord => ({
    id: text(job.id, "activity.jobs.id", omitted),
    kind: job.kind,
    status: job.status,
    startedAt: text(job.startedAt, "activity.jobs.startedAt", omitted, 40),
    endedAt: job.endedAt
      ? text(job.endedAt, "activity.jobs.endedAt", omitted, 40)
      : undefined,
    execution: job.execution,
    outcome: job.outcome,
    deployment: job.deployment
      ? text(job.deployment, "activity.jobs.deployment", omitted)
      : undefined,
  });
  return {
    evidence: "observed",
    availability: inputs.availability,
    updatedAt: inputs.updatedAt
      ? text(inputs.updatedAt, "activity.updatedAt", omitted, 40)
      : undefined,
    counts: { running: running.length, recent: recent.length },
    running: bounded(running, 6, "activity.running", omitted).map(summarize),
    recent: bounded(recent, 4, "activity.recent", omitted).map(summarize),
  };
}

function issues(
  inputs: SightlineInputs,
  omitted: SightlineOmission[],
): SightlineRecord[] {
  const diagnostics = relevantDiagnostics(
    inputs.snapshot,
    inputs.mode,
    inputs.selected,
  );
  if (diagnostics.length)
    omit(omitted, "issues.diagnosticText", "privacy", diagnostics.length);
  const result: SightlineRecord[] = bounded(
    diagnostics,
    10,
    "issues",
    omitted,
  ).map((item) => ({
    evidence: "declared",
    severity: item.severity,
    stage: item.stage,
    entity: item.entity
      ? text(item.entity, "issues.entity", omitted)
      : undefined,
  }));
  const model = inputs.snapshot.models[inputs.mode];
  const selectedTarget = model.targets.find(
    (target) => target.ref === inputs.selected,
  );
  if (selectedTarget?.implementation?.ready === false)
    result.push({
      evidence: "declared",
      severity: "error",
      code: "implementation-needs-attention",
      entity: selectedTarget.ref,
      count: selectedTarget.implementation.problems.length,
    });
  const selectedResource = model.resources.find(
    (resource) => resource.id === inputs.selected,
  );
  if (selectedResource?.stackUsage?.status === "unreferenced")
    result.push({
      evidence: "declared",
      severity: "warning",
      code: "stack-unreferenced",
      entity: selectedResource.id,
    });
  const missing = model.resources.filter(
    (resource) =>
      (!inputs.selected ||
        resource.id === inputs.selected ||
        resource.id.startsWith(`${inputs.selected}.`)) &&
      !resource.absent &&
      resource.inputRequirement?.status === "missing",
  );
  if (missing.length)
    result.push({
      evidence: "declared",
      severity: "error",
      code: "required-input-missing",
      count: missing.length,
      entities: bounded(missing, 8, "issues.missingInputs", omitted).map(
        (item) => text(item.id, "issues.missingInputs.id", omitted),
      ),
    });
  if (inputs.snapshot.source.problems.length) {
    omit(
      omitted,
      "issues.sourceProblemText",
      "privacy",
      inputs.snapshot.source.problems.length,
    );
    result.push({
      evidence: "declared",
      severity: "warning",
      code: "source-index-problems",
      count: inputs.snapshot.source.problems.length,
    });
  }
  if (
    inputs.pathname === "/database" &&
    inputs.snapshot.databaseProblems.length
  ) {
    omit(
      omitted,
      "issues.databaseProblemText",
      "privacy",
      inputs.snapshot.databaseProblems.length,
    );
    result.push({
      evidence: "declared",
      severity: "error",
      code: "database-source-problems",
      count: inputs.snapshot.databaseProblems.length,
    });
  }
  return result;
}

/** Only the newly constructed output is trimmed; no caller-owned value is mutated. */
function fitBudget(value: Sightline): Sightline {
  type Mutable = { [key: string]: unknown };
  const output = JSON.parse(JSON.stringify(value)) as Mutable;
  const omissions = output.omitted as SightlineOmission[];
  // All values here have already passed a field allow-list. Bound remaining nominal
  // identifiers too, including schema names and source-authored display metadata.
  const boundText = (node: unknown, path: string): void => {
    if (!node || typeof node !== "object") return;
    for (const [key, item] of Object.entries(node)) {
      const childPath = path ? `${path}.${key}` : key;
      if (typeof item === "string")
        (node as Mutable)[key] = text(
          item,
          childPath,
          omissions,
          key === "description" ? 900 : key === "id" ? 480 : 240,
        );
      else boundText(item, childPath);
    }
  };
  for (const [key, item] of Object.entries(output))
    if (key !== "omitted") boundText(item, key);
  const size = () => JSON.stringify(output).length;
  const remove = (parent: Mutable, key: string, path: string) => {
    if (parent[key] === undefined) return;
    const item = parent[key];
    if (parent === output && key === "issues") parent[key] = [];
    else delete parent[key];
    omit(
      omissions,
      path,
      "budget",
      Array.isArray(item) ? item.length : undefined,
    );
  };
  // Detailed related entities and repeated field facts yield before identity or evidence status.
  const focus = output.focus as Mutable | null;
  const declared = focus?.declared as Mutable | undefined;
  const comparison = focus?.comparison as Mutable | undefined;
  const connectionChanges = comparison?.connections as Mutable | undefined;
  const workspace = output.workspace as Mutable;
  const candidates: [Mutable | undefined | null, string, string][] = [
    [output.activity as Mutable, "recent", "activity.recent"],
    [comparison, "differences", "focus.comparison.differences"],
    [connectionChanges, "devOnly", "focus.comparison.connections.devOnly"],
    [connectionChanges, "prodOnly", "focus.comparison.connections.prodOnly"],
    [connectionChanges, "changed", "focus.comparison.connections.changed"],
    [declared, "connections", "focus.declared.connections"],
    [declared, "members", "focus.declared.members"],
    [declared, "fields", "focus.declared.fields"],
    [declared, "environment", "focus.declared.environment"],
    [declared, "columns", "focus.declared.columns"],
    [declared, "routes", "focus.declared.routes"],
    [declared, "targets", "focus.declared.targets"],
    [declared, "relations", "focus.declared.relations"],
    [focus, "description", "focus.description"],
    [focus, "tags", "focus.tags"],
    [workspace, "declared", "workspace.declared"],
    [output, "issues", "issues"],
  ];
  for (const [parent, key, path] of candidates) {
    if (size() <= SIGHTLINE_CHARACTER_BUDGET) break;
    if (!parent || parent[key] === undefined) continue;
    const item = parent[key];
    if (Array.isArray(item) && item.length > 1) {
      const keep = Math.max(1, Math.floor(item.length / 2));
      parent[key] = item.slice(0, keep);
      omit(omissions, path, "budget", item.length - keep);
    } else remove(parent, key, path);
  }
  // Defensive ceiling for oversized future fixtures. Preserve the required envelope and report
  // precisely which optional fields went. This is a projection boundary, never a silent slice.
  for (const [parent, prefix, keep] of [
    [
      declared,
      "focus.declared",
      ["evidence", "source", "kind", "targetId", "catalogPath"],
    ],
    [
      workspace,
      "workspace",
      [
        "kind",
        "availability",
        "evidence",
        "status",
        "tab",
        "editorMode",
        "target",
        "destination",
      ],
    ],
    [
      focus,
      "focus",
      [
        "id",
        "kind",
        "name",
        "status",
        "stale",
        "renamedFrom",
        "declared",
        "comparison",
      ],
    ],
    [comparison, "focus.comparison", ["dev", "prod"]],
    [
      output.activity as Mutable,
      "activity",
      ["evidence", "availability", "counts", "updatedAt"],
    ],
  ] as const) {
    if (!parent) continue;
    for (const key of Object.keys(parent).reverse()) {
      if (size() <= SIGHTLINE_CHARACTER_BUDGET) break;
      if (!(keep as readonly string[]).includes(key))
        remove(parent, key, `${prefix}.${key}`);
    }
  }
  // A maliciously large supplied id or nominal field is bounded by its field projector. The
  // remaining envelope is small; this assertion catches contract growth during development.
  if (size() > SIGHTLINE_CHARACTER_BUDGET)
    throw new Error("Sightline required envelope exceeds its character budget");
  return output as unknown as Sightline;
}

export function buildSightline(inputs: SightlineInputs): Sightline {
  const omitted: SightlineOmission[] = [];
  const kind = workspaceFor(inputs.pathname),
    model = inputs.snapshot.models[inputs.mode];
  omit(omitted, "source.repositoryRoot-privateValues-sourceText", "privacy");
  const output: Sightline = {
    schemaVersion: 1,
    capturedAt: text(inputs.capturedAt, "capturedAt", omitted, 40),
    location: {
      pathname: text(inputs.pathname, "location.pathname", omitted, 120),
      workspace: kind,
      subsection:
        kind === "cognito"
          ? text(
              inputs.pathname.split("/")[2] || "user-pools",
              "location.subsection",
              omitted,
              80,
            )
          : null,
    },
    source: {
      mode: inputs.mode,
      revision: text(inputs.snapshot.revision, "source.revision", omitted, 100),
      latestRevision: text(
        inputs.source.latestRevision,
        "source.latestRevision",
        omitted,
        100,
      ),
      modelStatus: model.status,
      stale: !!model.stale,
      evaluating: inputs.source.evaluating,
      connected: inputs.source.connected,
      draft: {
        dirty: inputs.source.dirty,
        conflicted: inputs.source.conflicted,
      },
    },
    focus: buildFocus(inputs, omitted),
    workspace: buildWorkspace(
      kind,
      inputs.workspace,
      inputs.snapshot,
      inputs.mode,
      omitted,
    ),
    deployments: {
      dev: deployment(inputs.deployments.dev, "dev", omitted),
      prod: deployment(inputs.deployments.prod, "prod", omitted),
    },
    activity: activity(inputs.activity, omitted),
    issues: issues(inputs, omitted),
    omitted,
  };
  return fitBudget(output);
}
