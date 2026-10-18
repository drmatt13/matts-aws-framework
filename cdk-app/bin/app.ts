import * as cdk from "aws-cdk-lib";
import * as path from "path";
import { resolveRepositoryTarget, type RepositoryTarget } from "@repo/framework/deploy/node";

/**
 * The one CDK App of a synth, and the deployment target it builds.
 *
 * Created by bin/main.ts before the application (bin/cdk-app.ts) is loaded: the
 * resource catalog branches on the mode while it is imported, so the mode has to
 * be decided first. It comes from CDK context — `-c prodDeployment`, `-c
 * deployment`, and `framework:targets` in cdk.json — and is handed to the
 * catalog as FRAMEWORK_MODE, with the target's inputs file as
 * FRAMEWORK_INPUTS_FILE.
 */

const repositoryRoot = path.join(__dirname, "..", "..");
let current: { readonly app: cdk.App; readonly selection: RepositoryTarget } | undefined;

export function frameworkApp(): { readonly app: cdk.App; readonly selection: RepositoryTarget } {
  if (current) return current;
  const app = new cdk.App();
  const selection = resolveRepositoryTarget({
    root: repositoryRoot,
    get: (key) => app.node.tryGetContext(key),
    env: process.env,
  });
  process.env.FRAMEWORK_MODE = selection.mode;
  process.env.FRAMEWORK_INPUTS_FILE = selection.inputsFile;
  current = { app, selection };
  return current;
}
