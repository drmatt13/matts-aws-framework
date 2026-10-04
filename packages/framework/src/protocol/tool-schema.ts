import { IDENTITY_ARGUMENT } from "./agentcore";

/**
 * What AgentCore Gateway can say about a tool's arguments and result.
 *
 * A Lambda target's inline schema has five keywords: type, description,
 * properties, required and items. A tool's contract is a Zod module, which can
 * say far more — an enum, a pattern, a bound, a default. Those are not lost:
 * the tool's wrapper enforces every one of them with the real schema in both
 * lanes, and the projection below writes each into the description, where the
 * model reads it. What the projection refuses is a shape it cannot describe at
 * all, because a schema that silently became looser would invite the model to
 * send something the tool will always reject.
 */
export interface GatewaySchema {
  readonly type: "object" | "array" | "string" | "number" | "integer" | "boolean";
  readonly description?: string;
  readonly properties?: Readonly<Record<string, GatewaySchema>>;
  readonly required?: readonly string[];
  readonly items?: GatewaySchema;
}

/** One tool as its Gateway target registers it: the generated `AGENTCORE_TOOLS` entry. */
export interface GatewayToolEntry {
  readonly description: string;
  readonly auth: boolean;
  readonly inputSchema: GatewaySchema;
  readonly outputSchema: GatewaySchema;
}

export type GatewayToolManifest = Readonly<Record<string, GatewayToolEntry>>;

type JsonSchema = Readonly<Record<string, unknown>>;

const GATEWAY_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean"]);

/** Keywords carried over as they are, or deliberately dropped. */
const STRUCTURAL = new Set(["type", "description", "properties", "required", "items", "$schema"]);

const count = (value: unknown, noun: string) => `${value} ${noun}${value === 1 ? "" : "s"}`;

/**
 * Constraints the wrapper enforces, written into the description for the
 * model. A note that returns nothing says nothing worth reading.
 */
const NOTES: Readonly<Record<string, (value: unknown) => string | undefined>> = {
  enum: (value) => `One of: ${(value as unknown[]).map((item) => JSON.stringify(item)).join(", ")}.`,
  const: (value) => `Always ${JSON.stringify(value)}.`,
  minLength: (value) => `At least ${count(value, "character")}.`,
  maxLength: (value) => `At most ${count(value, "character")}.`,
  pattern: (value) => `Matches ${value}.`,
  format: (value) => `Format: ${value}.`,
  // `z.number().int()` bounds itself to the safe-integer range; that is what
  // an integer means, not a constraint the model has to be told about.
  minimum: (value) => (value === Number.MIN_SAFE_INTEGER ? undefined : `Minimum ${value}.`),
  maximum: (value) => (value === Number.MAX_SAFE_INTEGER ? undefined : `Maximum ${value}.`),
  exclusiveMinimum: (value) => `Greater than ${value}.`,
  exclusiveMaximum: (value) => `Less than ${value}.`,
  multipleOf: (value) => `A multiple of ${value}.`,
  minItems: (value) => `At least ${count(value, "item")}.`,
  maxItems: (value) => `At most ${count(value, "item")}.`,
  default: (value) => `Defaults to ${JSON.stringify(value)}.`,
};

/** Read in this order, so a description reads the same way whatever order Zod emitted. */
const NOTE_ORDER = Object.keys(NOTES);

const UNION_KEYWORDS = ["anyOf", "oneOf", "allOf", "not"];
const RECORD_KEYWORDS = ["propertyNames", "patternProperties"];
const REFERENCE_KEYWORDS = ["$ref", "$defs", "definitions"];

function refuse(origin: string, problem: string): never {
  throw new Error(`${origin}: ${problem}`);
}

function project(schema: JsonSchema, origin: string): GatewaySchema {
  if (UNION_KEYWORDS.some((keyword) => keyword in schema) || schema.type === "null") {
    refuse(origin, "Gateway tool schemas cannot express a union or a nullable value. Make the field optional, or split the tool in two.");
  }
  if (
    RECORD_KEYWORDS.some((keyword) => keyword in schema) ||
    (schema.additionalProperties !== undefined && schema.additionalProperties !== false)
  ) {
    refuse(origin, "Gateway tool schemas cannot express a record with arbitrary keys. Declare the keys as properties, or pass an array of entries.");
  }
  if (REFERENCE_KEYWORDS.some((keyword) => keyword in schema)) {
    refuse(origin, "Gateway tool schemas cannot express a recursive or referenced shape. Inline it.");
  }
  if (typeof schema.type !== "string" || !GATEWAY_TYPES.has(schema.type)) {
    refuse(origin, `Gateway tool schemas have no type ${JSON.stringify(schema.type)}.`);
  }
  for (const keyword of Object.keys(schema)) {
    if (!STRUCTURAL.has(keyword) && !(keyword in NOTES) && keyword !== "additionalProperties") {
      refuse(origin, `the JSON Schema keyword "${keyword}" has no Gateway equivalent.`);
    }
  }

  const notes = NOTE_ORDER.filter((keyword) => keyword in schema)
    .map((keyword) => NOTES[keyword](schema[keyword]))
    .filter((note): note is string => note !== undefined);
  const authored = typeof schema.description === "string" ? schema.description.trim() : "";
  const description = [authored && !/[.!?]$/.test(authored) ? `${authored}.` : authored, ...notes]
    .filter((part) => part.length > 0)
    .join(" ");

  const type = schema.type as GatewaySchema["type"];
  const projected: {
    type: GatewaySchema["type"];
    description?: string;
    properties?: Record<string, GatewaySchema>;
    required?: string[];
    items?: GatewaySchema;
  } = { type };
  if (description) projected.description = description;

  if (type === "object") {
    const properties = (schema.properties ?? {}) as Readonly<Record<string, JsonSchema>>;
    if (Object.keys(properties).length > 0) {
      projected.properties = Object.fromEntries(
        Object.entries(properties).map(([name, child]) => [name, project(child, `${origin}.${name}`)]),
      );
    }
    const required = (schema.required ?? []) as readonly string[];
    if (required.length > 0) projected.required = [...required];
  } else if (type === "array") {
    if (!schema.items || typeof schema.items !== "object" || Array.isArray(schema.items)) {
      refuse(origin, "an array needs one item schema.");
    }
    projected.items = project(schema.items as JsonSchema, `${origin}[]`);
  }
  return projected;
}

/**
 * The input schema a tool's Gateway target registers.
 *
 * A user tool also lists the identity argument, so Gateway passes the token
 * through to the Lambda whatever it does with undeclared arguments. Only the
 * agent's own adapter ever lists this schema; what a model is shown is the
 * contract's projection without it.
 */
export function gatewayInputSchema(tool: { readonly auth: boolean; readonly inputSchema: GatewaySchema }): GatewaySchema {
  if (!tool.auth) return tool.inputSchema;
  return {
    ...tool.inputSchema,
    properties: {
      ...(tool.inputSchema.properties ?? {}),
      [IDENTITY_ARGUMENT]: {
        type: "string",
        description: "Supplied by the framework from the signed-in user's session. Never supplied by the model.",
      },
    },
  };
}

/**
 * Projects a contract's JSON Schema (from `z.toJSONSchema`) into Gateway's
 * subset. Throws naming the field, so the author fixes the line that wrote it.
 */
export function projectGatewaySchema(schema: JsonSchema, origin: string): GatewaySchema {
  if (schema.type !== "object") {
    refuse(origin, "a tool's request and response must be objects, because Gateway passes arguments as one.");
  }
  return project(schema, origin);
}
