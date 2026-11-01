import { CDK_ENVIRONMENT_ID } from "../shared/deployment-inputs";
import type { Mode } from "../shared/model";

/**
 * Other inspectors link to one CDK variable ("Edit .env.prod"). The request names a variable
 * and an environment only, never a value, and the CDK environment inspector takes it once.
 */
let requested: { readonly name: string; readonly mode: Mode } | undefined;

export function openEnvironmentVariable(select: (id: string) => void, mode: Mode, name?: string): void {
  requested = name ? { name, mode } : undefined;
  select(CDK_ENVIRONMENT_ID);
}

export function takeEnvironmentVariableRequest(): { readonly name: string; readonly mode: Mode } | undefined {
  const request = requested;
  requested = undefined;
  return request;
}
