import path from "node:path";

/** Authored deployment/local inputs; Compose consumes the exported root file. */
export const AUTHORED_ENV_FILE = "cdk-app/.env";
export const OUTPUTS_ENV_FILE = ".env";
export const BASE_COMPOSE_FILE = "docker-compose.yml";

/**
 * Compose's own default project name for a directory.
 *
 * Reproduced rather than left implicit so every command in this family
 * addresses the same project. Guessing differently would appear to lose a
 * developer's database.
 */
export function normalizeProjectName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^[_-]+/, "");
}

export function resolveProjectName(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.COMPOSE_PROJECT_NAME;
  if (configured && configured.trim().length > 0) {
    return normalizeProjectName(configured.trim());
  }
  return normalizeProjectName(path.basename(repositoryRoot));
}


/**
 * Labels every container the task supervisor creates carries.
 *
 * Declared here rather than in the runner so runner shutdown can remove exactly what
 * the runner created. A task container is launched outside Compose, so nothing
 * else knows it belongs to this project.
 */
export const TASK_CONTAINER_KIND_LABEL = "com.matts-aws-framework.kind";
export const TASK_CONTAINER_PROJECT_LABEL = "com.matts-aws-framework.project";
export const TASK_CONTAINER_TARGET_LABEL = "com.matts-aws-framework.target";
export const TASK_CONTAINER_RUN_LABEL = "com.matts-aws-framework.run";
