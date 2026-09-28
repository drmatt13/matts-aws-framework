import type { FrameworkConfig } from "@repo/framework/config";
import { getLocalTargets } from "@repo/framework/config";
import { resolveServicePort } from "@repo/framework/config/source";

export function getTargetEnvironmentPrefix(targetId: string): string {
  return targetId.replace(/-/g, "_").toUpperCase();
}

/** Config says which routes exist; Compose DNS says where containers live. */
export class LocalServiceRegistry {
  private readonly endpoints = new Map<string, string>();
  private readonly environment: NodeJS.ProcessEnv;
  constructor(options: {
    config: FrameworkConfig;
    repositoryRoot: string;
    environment?: NodeJS.ProcessEnv;
  }) {
    this.environment = options.environment ?? process.env;
    for (const target of getLocalTargets(options.config, ["service"])) {
      this.endpoints.set(target.id, `http://${target.id}:${resolveServicePort(options.config, target.id, options)}`);
    }
  }
  getEndpoint(targetId: string): string | undefined {
    if (!this.endpoints.has(targetId)) return undefined;
    return (this.environment[`${getTargetEnvironmentPrefix(targetId)}_SERVICE_URL`] || this.endpoints.get(targetId))?.replace(/\/+$/, "");
  }
}
