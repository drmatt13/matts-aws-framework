import { randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { APP_CONTEXT_KEY, APP_ID_CONTEXT_KEY, appIdProblem, appNameProblem, projectTargets, TARGETS_CONTEXT_KEY } from "@repo/framework/deploy";
import { repositoryTargets } from "@repo/framework/deploy/node";
import { writeDevelopmentFiles } from "../../scripts/resource-export";
import type { DeploymentStageRequest, DeploymentStageReview } from "../shared/deployment-identities";
import { frontendPath } from "./frontend-release";
import { OperationError } from "./deploy/registry";

const hash = (text: string | null) => createHash("sha256").update(text === null ? "<missing>" : text).digest("hex");
const STAGE = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/;
interface Pending { view: DeploymentStageReview; files: { file: string; hash: string; after: string }[] }

/**
 * Add a deployment stage. It deploys as `<app>-<stage>`; existing stages, pins,
 * deployed stacks and construct IDs are never renamed here.
 */
export class DeploymentIdentityService {
  /** Files this service wrote, by the hash of what it wrote, so the watcher does not report them as outside changes. */
  readonly ownWrites = new Map<string, string>();
  private readonly reviews = new Map<string, Pending>();
  constructor(private readonly root: string) {}
  private text(relative: string): string | null { const file = frontendPath(this.root, relative); return existsSync(file) ? readFileSync(file, "utf8") : null; }
  load() {
    const cdk = this.text("cdk-app/cdk.json");
    let targets: ReturnType<typeof repositoryTargets> = [];
    let problem: string | undefined;
    try { targets = repositoryTargets(this.root); } catch (error) { problem = error instanceof Error ? error.message : String(error); }
    return { targets, hash: hash(cdk), ...(problem ? { problem } : {}) };
  }
  review(input: DeploymentStageRequest, expectedHash: string): DeploymentStageReview {
    if (!input || typeof input.stage !== "string" || !STAGE.test(input.stage) || !["dev", "prod"].includes(input.mode)) {
      throw new OperationError(422, "Choose a stage of lowercase letters, numbers and hyphens, and Development or Production.");
    }
    if (input.account !== undefined && input.account !== "" && !/^\d{12}$/.test(input.account)) throw new OperationError(422, "The account must be a 12-digit AWS account id.");
    if (input.mode === "prod" && !input.account) throw new OperationError(422, "A production stage needs its account, so no other account can be deployed to by mistake.");
    if (input.region !== undefined && input.region !== "" && !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(input.region)) throw new OperationError(422, "Choose an AWS region such as us-east-1.");
    const cdkFile = "cdk-app/cdk.json"; const beforeCdk = this.text(cdkFile);
    if (hash(beforeCdk) !== expectedHash) throw new OperationError(409, "cdk-app/cdk.json changed. Reload before reviewing.");
    if (!beforeCdk) throw new OperationError(422, "Create cdk-app/cdk.json through the framework setup before adding a stage.");
    const cdk = JSON.parse(beforeCdk) as { context?: Record<string, unknown> };
    const context = cdk.context ?? {};
    const app = context[APP_CONTEXT_KEY];
    if (appNameProblem(app) || appIdProblem(context[APP_ID_CONTEXT_KEY])) throw new OperationError(422, "Name this app in the navbar before adding a stage: stages deploy as <app>-<stage>.");
    const declared = (context[TARGETS_CONTEXT_KEY] ?? {}) as Record<string, unknown>;
    if (Object.hasOwn(declared, input.stage)) throw new OperationError(422, `The ${input.stage} stage already exists. Select it in Deploy; a new stage needs a different name. Existing stages are never renamed here.`);
    const file = `cdk-app/.env.${input.mode}`;
    const entry = { mode: input.mode, ...(input.account ? { account: input.account } : {}), ...(input.region ? { region: input.region } : {}), inputs: file };
    const afterContext = { ...context, [TARGETS_CONTEXT_KEY]: { ...declared, [input.stage]: entry } };
    let name: string;
    try {
      name = projectTargets({ app, appId: context[APP_ID_CONTEXT_KEY], targets: afterContext[TARGETS_CONTEXT_KEY] }).find(target => target.stage === input.stage)!.name;
    } catch (error) {
      throw new OperationError(422, error instanceof Error ? error.message : String(error));
    }
    const afterCdk = JSON.stringify({ ...cdk, context: afterContext }, null, 2) + "\n";
    const changes: { file: string; before: string; after: string }[] = [{ file: cdkFile, before: beforeCdk, after: afterCdk }];
    const beforeEnv = this.text(file);
    const template = this.text(`${file}.template`);
    if (beforeEnv === null && template === null) throw new OperationError(422, `Missing ${file}.template. Create the mode's template before adding this stage.`);
    if (beforeEnv === null) changes.push({ file, before: "File absent", after: `Initialize from ${file}.template; no values are copied from another file.` });
    const view: DeploymentStageReview = { id: randomUUID(), stage: input.stage, mode: input.mode, name, changes, warnings: [
      `${name} is a new deployment. Existing stages, their deployAs names, deployed stacks and resources stay as they are.`,
      "Deploying it creates a separate set of resources and continuing charges. Applying this edits source only; nothing is deployed.",
      `It reads ${file}, which it shares with every other ${input.mode === "prod" ? "production" : "development"} stage.`,
    ] };
    const files = [{ file: cdkFile, hash: hash(beforeCdk), after: afterCdk }, ...(beforeEnv === null ? [{ file, hash: hash(null), after: template! }] : [])];
    this.reviews.clear(); this.reviews.set(view.id, { view, files }); return view;
  }
  apply(id: string): { stage: string; name: string; mode: "dev" | "prod"; message: string } {
    const plan = this.reviews.get(id);
    if (!plan) throw new OperationError(409, "The stage review expired. Review again.");
    for (const file of plan.files) if (hash(this.text(file.file)) !== file.hash) throw new OperationError(409, "Deployment source changed after review. Nothing was written; review again.");
    writeDevelopmentFiles(plan.files.map(file => ({ path: frontendPath(this.root, file.file), contents: file.after })));
    for (const file of plan.files) this.ownWrites.set(file.file, createHash("sha256").update(file.after).digest("hex"));
    this.reviews.clear();
    return { stage: plan.view.stage, name: plan.view.name, mode: plan.view.mode, message: `Added the ${plan.view.stage} stage. It deploys as ${plan.view.name}; nothing was deployed.` };
  }
}
