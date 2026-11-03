import { deploymentNameFor, deploymentNameProblem } from "../../packages/framework/src/deploy/targets";

/**
 * What is wrong with a typed app name, naming only the fault: the field's help
 * already states the rule, so the message never repeats it.
 */
export function appNameFault(name: string): string | undefined {
  if (!name) return "Enter a name.";
  const characters = [...new Set(name.replace(/[a-z0-9-]/g, ""))];
  if (characters.some((character) => /[A-Z]/.test(character))) return "Use lowercase letters.";
  if (characters.length) return `${characters.map((character) => (character === " " ? "Spaces" : `“${character}”`)).join(", ")} can't be used.`;
  if (!/^[a-z]/.test(name)) return "Start with a letter.";
  if (name.endsWith("-")) return "Don't end with a hyphen.";
  return undefined;
}

/** One stage as the app-name editor sees it: a framework:targets entry, or the undeclared dev stage. */
export interface AppStageView {
  readonly stage: string;
  readonly mode: "dev" | "prod";
  /** The target's `deployAs`: it deploys under this name whatever the app is called. */
  readonly deployAs?: string;
  /** The dev stage, which exists without being declared. */
  readonly implicit?: boolean;
  /** A production stage's account and region, where the rename review looks for it. */
  readonly account?: string;
  readonly region?: string;
}

export interface AppNameView {
  /** framework:app, when it is a valid app name. */
  readonly name?: string;
  /** framework:appId, when it is valid: with a stage, what every stack is tagged with. */
  readonly appId?: string;
  /** Why the app cannot name or identify its deployments: no or an invalid name, or no or an invalid id. */
  readonly problem?: string;
  /** No framework:app yet: targets are keyed by full deployment names, which naming the app keeps. */
  readonly legacy?: boolean;
  /** No framework:appId yet; the next review adds one. */
  readonly needsId?: boolean;
  readonly stages: readonly AppStageView[];
  /** cdk-app/cdk.json's hash, so a review is refused once the file changes. */
  readonly hash: string;
}

/** What a stage's deployment does when the app is renamed: takes the new name, or keeps the one it has. */
export type AppNameOutcome = "follows" | "keeps";

export interface AppNameRow {
  readonly stage: string;
  readonly mode: "dev" | "prod";
  /** Its deployment before the change; absent when the app has no name yet and the stage is new. */
  readonly before?: string;
  readonly after: string;
  readonly outcome: AppNameOutcome;
  /** What a read-only look in AWS found for this app's stage, by its app id and stage or its current name. */
  readonly check?: "deployed" | "absent" | "unknown";
  /** The name AWS shows the stage deployed as, when it is. */
  readonly deployed?: string;
  /** Why AWS could not be checked. */
  readonly reason?: string;
}

export interface AppNamePreview {
  readonly rows: readonly AppNameRow[];
  readonly problems: readonly string[];
  readonly unchanged: boolean;
}

/**
 * The deployments a new app name would give each stage. A stage with
 * `deployAs` keeps that name; every other stage follows the new name, except
 * those in `keep`, which the rename review fills with the production stages AWS
 * shows deployed, by the name they are deployed as. Naming an app for the first
 * time keeps every declared target's key, which was its full deployment name.
 */
export function appNamePreview(view: AppNameView, name: string, keep: Readonly<Record<string, string>> = {}): AppNamePreview {
  const problems: string[] = [];
  const trimmed = name.trim();
  const nameProblem = appNameFault(trimmed);
  if (nameProblem) problems.push(nameProblem);
  const derive = (stage: string) => (nameProblem ? "" : deploymentNameFor(trimmed, stage));
  const rows = view.stages.map((stage): AppNameRow => {
    if (stage.deployAs) return { stage: stage.stage, mode: stage.mode, before: stage.deployAs, after: stage.deployAs, outcome: "keeps" };
    if (view.legacy && !stage.implicit) return { stage: stage.stage, mode: stage.mode, before: stage.stage, after: stage.stage, outcome: "keeps" };
    const before = view.name ? deploymentNameFor(view.name, stage.stage) : undefined;
    const kept = keep[stage.stage];
    if (kept && kept !== derive(stage.stage)) return { stage: stage.stage, mode: stage.mode, ...(before ? { before } : {}), after: kept, outcome: "keeps" };
    return { stage: stage.stage, mode: stage.mode, ...(before ? { before } : {}), after: derive(stage.stage), outcome: "follows" };
  });
  if (!nameProblem) {
    for (const row of rows) {
      const problem = deploymentNameProblem(row.after);
      if (problem) problems.push(`The ${row.stage} stage would deploy as ${row.after} (${row.after.length} characters), which ${problem.replace(/\. Received: .*$/, "")}. Choose a shorter name.`);
    }
    const seen = new Map<string, string>();
    for (const row of rows) {
      const other = seen.get(row.after);
      if (other) problems.push(`The ${other} and ${row.stage} stages would both deploy as ${row.after}.`);
      seen.set(row.after, row.stage);
    }
  }
  return { rows, problems, unchanged: !!view.name && trimmed === view.name };
}

export interface AppNameReview {
  readonly id: string;
  /** The app's name before the change; absent when it is being named for the first time. */
  readonly from?: string;
  readonly name: string;
  readonly rows: readonly AppNameRow[];
  readonly warnings: readonly string[];
  /** framework:app, framework:appId and framework:targets before and after; every other setting is unchanged. */
  readonly change: { readonly file: string; readonly before: string; readonly after: string };
}
