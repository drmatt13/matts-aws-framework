import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { readAwsFiles } from "../../../scripts/aws-connections";
import { infrastructureFingerprint } from "../infrastructure";
import type { DeployMode } from "../../shared/deploy";

/** Private source evidence, including handler/assets that the graph revision does not cover. */
export function deploymentPreparationFingerprint(root: string, mode: DeployMode, profile: string | undefined, inputsFile: string | undefined, env: NodeJS.ProcessEnv): string {
  const hash = createHash("sha256");
  hash.update(infrastructureFingerprint(root, mode));
  hash.update(JSON.stringify([mode, profile, readAwsFiles(env).revision]));
  // Match resolveRepositoryTarget: an explicit host input override precedes target defaults.
  const input = path.resolve(root, env.FRAMEWORK_INPUTS_FILE ?? inputsFile ?? `cdk-app/.env.${mode}`);
  hash.update(input);
  hash.update(existsSync(input) ? readFileSync(input) : "missing");
  // These entry-point helpers can affect synthesis without appearing in the source graph.
  for (const name of ["cdk-app/framework-inputs.ts", "cdk-app/tsconfig.json"]) {
    hash.update(name);
    hash.update(existsSync(path.join(root, name)) ? readFileSync(path.join(root, name)) : "missing");
  }
  const scripts = path.join(root, "scripts");
  if (existsSync(scripts)) for (const name of readdirSync(scripts).sort()) {
    if (!/\.(?:ts|mjs|cjs|json)$/.test(name)) continue;
    hash.update(name); hash.update(readFileSync(path.join(scripts, name)));
  }
  return hash.digest("hex");
}
