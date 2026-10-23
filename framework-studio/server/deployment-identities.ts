import { randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { repositoryTargets } from "@repo/framework/deploy/node";
import { parseTargets, TARGETS_CONTEXT_KEY } from "@repo/framework/deploy";
import { writeDevelopmentFiles } from "../../scripts/resource-export";
import type { DeploymentIdentityRequest, DeploymentIdentityReview } from "../shared/deployment-identities";
import { frontendPath } from "./frontend-release";
import { updateInputText } from "./deployment-input-edits";
import { OperationError } from "./deploy/registry";

const hash = (text: string | null) => createHash("sha256").update(text === null ? "<missing>" : text).digest("hex");
interface Pending { view: DeploymentIdentityReview; files: { file: string; hash: string; after: string }[] }

/** Add an independent deployment identity. Existing target keys/construct IDs are never renamed. */
export class DeploymentIdentityService {
  private readonly reviews = new Map<string, Pending>();
  constructor(private readonly root: string) {}
  private text(relative: string): string | null { const file = frontendPath(this.root, relative); return existsSync(file) ? readFileSync(file, "utf8") : null; }
  load() {
    const cdk = this.text("cdk-app/cdk.json");
    return { targets: repositoryTargets(this.root, {}), hash: hash(cdk), authority: "Development personal identity: cdk-app/.env.dev CDK_APP_NAME. Named development/production/staging targets: cdk-app/cdk.json framework:targets. A new name establishes independent infrastructure; it never migrates an existing deployment." };
  }
  review(input: DeploymentIdentityRequest, expectedHash: string): DeploymentIdentityReview {
    if (!input || !["dev", "prod"].includes(input.mode) || !/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(input.name) || !/^\d{12}$/.test(input.account) || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(input.region)) throw new OperationError(422, "Choose dev/prod, a safe 1–63 character name, a 12-digit account and an AWS region.");
    const cdkFile = "cdk-app/cdk.json"; const beforeCdk = this.text(cdkFile);
    if (hash(beforeCdk) !== expectedHash) throw new OperationError(409, "Deployment targets changed. Reload before reviewing.");
    if (!beforeCdk) throw new OperationError(422, "Create cdk-app/cdk.json through the framework setup before adding a target.");
    const cdk = JSON.parse(beforeCdk) as { context?: Record<string, unknown> };
    const targets = parseTargets(cdk.context?.[TARGETS_CONTEXT_KEY]);
    const repository = repositoryTargets(this.root, {});
    if (targets.some(target => target.name === input.name) || repository.some(target => target.name === input.name)) throw new OperationError(422, "That deployment identity already exists. Select it in Deploy; creating a new identity requires a different name. Existing deployments are never renamed here.");
    const file = `cdk-app/.env.${input.mode}`;
    const beforeEnv = this.text(file);
    const template = this.text(`${file}.template`);
    if (beforeEnv === null && template === null) throw new OperationError(422, `Missing ${file}.template. Create the mode's template before preparing this identity.`);
    let afterEnv = beforeEnv ?? template!;
    const changes: { file: string; before: string; after: string }[] = [];
    if (input.mode === "dev") {
      const previous = parseEnv(afterEnv).CDK_APP_NAME;
      afterEnv = updateInputText(afterEnv, [{ name: "CDK_APP_NAME", value: input.name }]);
      changes.push({ file, before: previous === undefined ? "CDK_APP_NAME is absent (all other values hidden)" : `CDK_APP_NAME=${previous} (all other values hidden)`, after: `CDK_APP_NAME=${input.name}\nAll unrelated comments and values are preserved.${beforeEnv === null ? " The missing file is initialized from its dev template." : ""}` });
    } else if (beforeEnv === null) changes.push({ file, before: "File absent", after: `Initialize from ${file}.template; development inputs are never copied. Production identity remains the cdk.json target key.` });
    // A personal dev identity otherwise vanishes from the repository selector
    // when its default changes. Preserve it as an explicit dev target, without
    // inventing account/region pins it did not previously have.
    const previousPersonal = input.mode === "dev" ? repository.find(target => target.origin === "personal") : undefined;
    const previousTarget = previousPersonal ? { [previousPersonal.name]: { mode: "dev", inputs: previousPersonal.inputs ?? "cdk-app/.env.dev" } } : {};
    cdk.context = { ...cdk.context, [TARGETS_CONTEXT_KEY]: { ...previousTarget, ...(cdk.context?.[TARGETS_CONTEXT_KEY] as object ?? {}), [input.name]: { mode: input.mode, account: input.account, region: input.region, inputs: file } } };
    const afterCdk = JSON.stringify(cdk, null, 2) + "\n";
    changes.unshift({ file: cdkFile, before: beforeCdk, after: afterCdk });
    const view: DeploymentIdentityReview = { id: randomUUID(), name: input.name, mode: input.mode, changes, warnings: [
      "This creates a NEW deployment selection. Existing target declarations, deployed stacks, construct IDs, CloudFormation logical IDs, outputs and resources stay under their original identities.",
      "Deploying the new name can create a separate set of resources and continuing charges. No infrastructure is deployed or migrated by applying this source review.",
      "A display label does not change physical identity. Moving/replacing deployed infrastructure requires a separately reviewed migration; this editor does not rename or adopt it.",
      input.mode === "dev" ? "CDK_APP_NAME selects the new personal dev default. The previous personal identity is preserved as an explicit target; existing declared dev targets remain independently selectable." : "Production and prod-mode staging names are authoritative target keys in cdk.json. A CDK_APP_NAME in .env.prod is ignored by the framework, so this editor does not add a competing value.",
    ] };
    const files = [{ file: cdkFile, hash: hash(beforeCdk), after: afterCdk }, ...((afterEnv !== beforeEnv) ? [{ file, hash: hash(beforeEnv), after: afterEnv }] : [])];
    this.reviews.clear(); this.reviews.set(view.id, { view, files }); return view;
  }
  apply(id: string): { name: string; mode: "dev" | "prod"; message: string } {
    const plan = this.reviews.get(id);
    if (!plan) throw new OperationError(409, "Deployment identity review expired. Review again.");
    for (const file of plan.files) if (hash(this.text(file.file)) !== file.hash) throw new OperationError(409, "Deployment inputs changed after review. Nothing was written; review again.");
    writeDevelopmentFiles(plan.files.map(file => ({ path: frontendPath(this.root, file.file), contents: file.after })));
    this.reviews.clear(); return { name: plan.view.name, mode: plan.view.mode, message: "Source inputs saved for a new deployment. Existing infrastructure was not renamed or changed. Review synth/diff before a separate deployment." };
  }
}
