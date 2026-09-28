import { isUnresolvedTokenString } from "./resources";

export const RESOURCE_MANIFEST_FILE = ".framework/local/resources.json";
export const RESOURCE_MANIFEST_VERSION = 1;
export interface ResourceManifest {
  readonly version: 1;
  readonly deployment: string;
  readonly account: string;
  readonly region: string;
  readonly mode: "dev";
  readonly attributes: Readonly<Record<string, string>>;
  readonly integrations: Readonly<Record<string, string>>;
}

export function parseResourceManifest(raw: string, expected: { deployment?: string; account?: string; region?: string } = {}): ResourceManifest {
  let value: any;
  try { value = JSON.parse(raw); } catch { throw new Error("The development resource manifest is not JSON. Run npm run export:cdk-outputs."); }
  if (!value || value.version !== RESOURCE_MANIFEST_VERSION || value.mode !== "dev") throw new Error("Local execution requires a version 1 development resource manifest; production resources are refused.");
  for (const field of ["deployment", "account", "region"] as const) {
    if (typeof value[field] !== "string" || !value[field] || isUnresolvedTokenString(value[field])) throw new Error(`The development resource manifest has no resolved ${field}.`);
    if (expected[field] && expected[field] !== value[field]) throw new Error(`The development resource manifest ${field} differs from the selected deployment. Re-export the intended development deployment.`);
  }
  if (!/^\d{12}$/.test(value.account)) throw new Error("The development resource manifest has an invalid AWS account.");
  for (const field of ["attributes", "integrations"]) {
    if (!value[field] || typeof value[field] !== "object" || Array.isArray(value[field])) throw new Error(`The development resource manifest has no ${field} map.`);
    for (const [key, attribute] of Object.entries(value[field])) {
      if (typeof attribute !== "string" || isUnresolvedTokenString(attribute)) throw new Error(`The development resource manifest has an unresolved ${field} entry ${key}.`);
    }
  }
  return value as ResourceManifest;
}
