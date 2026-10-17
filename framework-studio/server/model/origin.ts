import type { FrameworkConfig } from "@repo/framework/config";

/**
 * Normalization names a declaration by its logical place — `http["/graphql"]`,
 * `webSocket["$connect"].authorizer` — and that name is the bridge between the
 * evaluated config and the source: the same section and key locate the entry
 * in both. This module reads one, and reaches or replaces the object it names.
 */

export const SECTIONS = [
  "http",
  "webSocket",
  "events",
  "services",
  "tasks",
  "workflows",
  "tools",
  "agents",
] as const;

export type Section = (typeof SECTIONS)[number];

export interface ParsedOrigin {
  readonly section: Section | "defaults";
  readonly key: string;
  /** Properties below the entry, e.g. `["authorizer"]` for a `$connect` authorizer. */
  readonly chain: readonly string[];
}

const ORIGIN = /^(http|webSocket|events|services|tasks|workflows|tools|agents)\["(.+?)"\]((?:\.[A-Za-z]+)*)$/;

export function parseOrigin(origin: string): ParsedOrigin | undefined {
  if (origin === "defaults") return { section: "defaults", key: "defaults", chain: [] };
  const match = ORIGIN.exec(origin);
  if (!match) return undefined;
  return {
    section: match[1] as Section,
    key: match[2]!,
    chain: match[3] ? match[3].slice(1).split(".") : [],
  };
}

/** Where a message names an origin, the first one it names. */
export function originInMessage(message: string): string | undefined {
  return /(?:http|webSocket|events|services|tasks|workflows|tools|agents)\["[^"]+"\](?:\.authorizer)?/.exec(message)?.[0];
}

/**
 * The evaluated object an origin's fields live on.
 *
 * For a workflow that is the definition `workflow(...)` returned, which carries
 * its options (`deploy`, `timeoutSeconds`) beside the graph; for everything else
 * it is the entry itself, or the nested object the chain names.
 */
export function declarationOf(config: FrameworkConfig, origin: ParsedOrigin): Record<string, unknown> | undefined {
  if (origin.section === "defaults") return config.defaults as unknown as Record<string, unknown>;
  const section = (config as unknown as Record<string, Record<string, unknown> | undefined>)[origin.section];
  let current: unknown = section?.[origin.key];
  for (const link of origin.chain) {
    current = current && typeof current === "object" ? (current as Record<string, unknown>)[link] : undefined;
  }
  return current && typeof current === "object" ? (current as Record<string, unknown>) : undefined;
}

/** The value a declaration holds at a property path, before any default. */
export function readPath(declaration: Record<string, unknown> | undefined, path: readonly string[]): unknown {
  let current: unknown = declaration;
  for (const segment of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * A change to one property of one declaration, in the evaluated config's terms.
 *
 * `remove` deletes the property, which is what "inherit" means: the entry stops
 * saying it, and the cascade decides.
 */
export interface SemanticPatch {
  readonly origin: string;
  readonly path: readonly string[];
  readonly value?: string | number | boolean;
  readonly remove?: true;
}

function replaceIn(
  object: Record<string, unknown> | undefined,
  path: readonly string[],
  patch: SemanticPatch,
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...(object ?? {}) };
  const [head, ...rest] = path;
  if (head === undefined) return copy;
  if (rest.length === 0) {
    if (patch.remove) delete copy[head];
    else copy[head] = patch.value;
    return copy;
  }
  const child = copy[head];
  if (patch.remove && (child === undefined || child === null)) return copy;
  copy[head] = replaceIn(child && typeof child === "object" ? (child as Record<string, unknown>) : undefined, rest, patch);
  return copy;
}

/**
 * The config with one property changed, copied along the path and shared
 * everywhere else.
 *
 * Shallow on purpose. Catalog references are proxies and workflow graphs are
 * built once; neither is touched, so the patched config is the authored one
 * with exactly one property different — which is what makes validating it the
 * same as validating the source after the matching text edit.
 */
export function applyPatch(config: FrameworkConfig, patch: SemanticPatch): FrameworkConfig {
  const origin = parseOrigin(patch.origin);
  if (!origin) throw new Error(`"${patch.origin}" is not a declaration the studio can change.`);
  if (origin.section === "defaults") return { ...config, defaults: replaceIn(config.defaults as unknown as Record<string, unknown>, patch.path, patch) } as unknown as FrameworkConfig;
  const section = (config as unknown as Record<string, Record<string, unknown>>)[origin.section] ?? {};
  const entry = section[origin.key];
  if (!entry || typeof entry !== "object") throw new Error(`${patch.origin} is not declared.`);
  const nested = [...origin.chain, ...patch.path];
  return {
    ...config,
    [origin.section]: {
      ...section,
      [origin.key]: replaceIn(entry as Record<string, unknown>, nested, patch),
    },
  } as FrameworkConfig;
}
