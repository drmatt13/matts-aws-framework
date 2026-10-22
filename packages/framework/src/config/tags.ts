/** Author-owned metadata. Keys are independent of source paths and deployed identities. */
export type DeclarationTags = Readonly<Record<string, string>>;

export interface DeclarationMetadata {
  readonly tags?: DeclarationTags;
}

/** CloudFormation and the framework reserve four deployment identity tags. */
export const MAX_DECLARATION_TAGS = 46;
const TAG_CHARACTERS = /^[\p{L}\p{N}\p{Z}_.:/=+@-]*$/u;

/** Validate without resolving inputs, references or secrets; preserve values exactly. */
export function validateTags(value: unknown, origin = "Declaration tags"): DeclarationTags {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${origin}: tags must be a plain object of AWS string key/value pairs.`);
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_DECLARATION_TAGS) throw new Error(`${origin}: at most ${MAX_DECLARATION_TAGS} tags are supported, leaving four of AWS's 50 slots for deployment ownership.`);
  for (const [key, entry] of entries) {
    if (key === "__proto__") throw new Error(`${origin}: tag key "__proto__" cannot be preserved as a TypeScript object literal. Choose another application key.`);
    if (/^(?:aws:|framework:)/i.test(key) || key.toLowerCase() === "managedby") throw new Error(`${origin}: tag key ${JSON.stringify(key)} is reserved for AWS or framework ownership. Choose an application key.`);
    if ([...key].length < 1 || [...key].length > 128 || !TAG_CHARACTERS.test(key)) throw new Error(`${origin}: tag key ${JSON.stringify(key)} must contain 1–128 Unicode letters, numbers, spaces, or _ . : / = + - @.`);
    if (typeof entry !== "string" || [...entry].length > 256 || !TAG_CHARACTERS.test(entry)) throw new Error(`${origin}: tag ${JSON.stringify(key)} must be a string of up to 256 Unicode letters, numbers, spaces, or _ . : / = + - @. Resource and secret references are not tag values.`);
  }
  return Object.freeze(Object.fromEntries(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
}

/** Explicit ownership layers, from stack to member to dedicated declaration. */
export function mergeTags(origin: string, ...layers: readonly (DeclarationTags | undefined)[]): DeclarationTags {
  return validateTags(Object.fromEntries(layers.flatMap(layer => Object.entries(layer ?? {}))), origin);
}

export function sameTags(left: DeclarationTags | undefined, right: DeclarationTags | undefined): boolean {
  const a = validateTags(left); const b = validateTags(right);
  return JSON.stringify(a) === JSON.stringify(b);
}

/** RDS adds restrictions beyond the common AWS vocabulary. */
export function validateRdsTags(tags: DeclarationTags, origin: string): DeclarationTags {
  for (const [key, value] of Object.entries(tags)) {
    if (/^rds:/i.test(key) || /^(aws:|rds:)/i.test(value) || !value.length) throw new Error(`${origin}: RDS tag ${JSON.stringify(key)} requires a nonempty value, and RDS keys/values cannot begin with aws: or rds:.`);
  }
  return tags;
}
