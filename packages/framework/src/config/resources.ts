import { validateTags, type DeclarationTags, type DeclarationMetadata } from "./tags";
/**
 * Typed, serializable resource declarations and deferred references.
 *
 * `framework-config/resources.ts` declares *what an AWS workload needs* — a
 * user pool id, a trusted-origin list, a database secret — without knowing what
 * any of those values are. A declaration becomes a {@link ResourceReference}:
 * plain data carrying its catalog path and value kind, and nothing else. No CDK
 * import, no `process.env` read, no infrastructure resolved while the config is
 * imported. That is what keeps this module browser-safe, and what lets
 * `stableStringify()` compare two declarations of one target for agreement.
 *
 * A catalog holds authored inputs and linked CDK resources. `resource.value()`
 * supplies a standalone non-secret value directly from its declaration.
 * `resource.fromEnv("NAME")` and `resource.secret("NAME")` instead name a line
 * authored in cdk-app/.env.<mode> — the one file a deployment reads an input from, so
 * a model id is the same string in AWS and under `docker compose up`.
 * Native resource values come off `resource.stack<T>()`, where the stack class *is*
 * the declaration: its public fields are the catalog entries under the names
 * they already carry, and the stack answers with a single
 * `linkResources(this, ...)` beside its constructor. Computed native values stay
 * beside the construct that owns them; standalone values stay in their declarations.
 * A secret is the one thing never read bare off either origin, because a field
 * name says which secret and not what the workload wants from it: `.arn`,
 * `.value` and `.field()` are three different answers with three different
 * consequences — see `SecretProjections` in ./cdk-resources.
 *
 * An authored input says how it differs between the two graphs, and nothing
 * else does: `.only("dev")` leaves it out of production, `.required("prod")`
 * requires it there alone, and `.default({ dev, prod })` gives each graph its
 * own fallback. {@link defineResources} is told which graph it is building and
 * resolves each declaration to that graph's answer — `absent`, `required` and
 * `default` — so everything downstream reads one graph and never compares
 * modes. An absent entry still types as present, so every config that reads it
 * compiles in both graphs while the workload simply never sees the variable.
 *
 * A stack the deployment does not build is written `undefined`, a ternary on
 * `PROD_DEPLOYMENT`, and keeps its place as an absent group the same way.
 */

import { secretBindingKey } from "./secret-bindings";
import type { SecretBindingDocument } from "./secret-bindings";
import {
  CDK_GROUP_BRAND,
  cdkResource, cdkResourceGroup, isCdkResource, isCdkResourceGroup,
  withCdkResourcePath, withCdkResourceGroupPath,
  type CdkGroupAttributeReferences, type CdkGroupSecretReferences,
  type CdkResourceGroup, type CdkResourceGroupSpec,
} from "./cdk-resources";
import type { CdkResource, CdkResourceSpec, CdkAttributeReferences, NativeGrantBinding } from "./cdk-resources";
import { integrationIdForPath } from "./cdk-resources";

export const CLOUD_MODES = ["dev", "prod"] as const;
/**
 * Which CDK graph is being built: `PROD_DEPLOYMENT` resolved to one token.
 *
 * Deliberately not spelled "local-dev". This axis is about *AWS* — the dev
 * graph is still a real deployment with a real user pool — and the word "local"
 * already belongs to the Compose lane on the {@link DeployScope} axis. Two
 * different questions should not share a word.
 *
 * It is also not the same axis as a target's deploy setting. `deploy` is where
 * the author wants a target; this is what the deployment will hold. The two
 * compose by intersection, so the dev graph is always a subset of the prod
 * graph built from the same config.
 */
export type CloudMode = (typeof CLOUD_MODES)[number];

export const RESOURCE_KINDS = ["string", "secret"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** Runtime brand. A reference is recognized by this, never by shape alone. */
export const RESOURCE_REFERENCE_BRAND = "@repo/framework/resource" as const;

/**
 * A declared resource input, and — once {@link defineResources} has run — its
 * location in the catalog.
 *
 * `Path` is what makes a reference belong to a *particular* catalog view:
 * `Pick<typeof resources, "cognito">` accepts `resources.cognito.userPoolId`
 * and rejects `resources.primaryDatabase`, because their paths differ at the
 * type level.
 */
export interface ResourceReference<
  Kind extends ResourceKind = ResourceKind,
  Path extends readonly string[] = readonly string[],
  Optional extends boolean = boolean,
  FromEnv extends string | undefined = string | undefined,
  Value extends string = string,
> {
  readonly tags?: DeclarationTags;
  readonly effectiveTags?: DeclarationTags;
  /** Original deployment binding identity retained across catalog renames. */
  readonly bindingPath?: readonly string[];
  readonly $resource: typeof RESOURCE_REFERENCE_BRAND;
  /** What the supplied value is: a plain string, or a non-secret secret handle. */
  readonly kind: Kind;
  /**
   * Set when the catalog left this entry out of the graph being built: an
   * input declared `.only()` the other graph, or an entry declared `undefined`
   * — see {@link defineResources}.
   *
   * There is no mode to compare against, because the catalog already answered
   * the question for the graph it was defined for: synthesis, the local lane
   * and the generator all read the same answer. An absent resource resolves to
   * nothing everywhere, so the workload that reads it simply never sees the
   * variable.
   */
  readonly absent?: true;
  /**
   * Whether a provider may leave this out. An optional resource that is not
   * supplied drops its environment entry rather than arriving empty — which is
   * a setting the workload never sees, not a setting that is blank.
   */
  readonly optional: Optional;
  /** Every enabled consumer must supply this authored input in this graph. */
  readonly required?: true;
  /**
   * The input's declared policy in each graph, kept when the two differ so a
   * reader of one graph — Studio, the client export — can still describe the
   * other. `absent`, `required` and `default` are this graph's entry.
   */
  readonly modes?: Readonly<Record<CloudMode, InputModePolicy>>;
  /**
   * The environment variable this value is read from, when the application does
   * not supply it. Absent means the composition root owns the value.
   *
   * A name, not a read: resolving it is the deployment adapter's job. The
   * matching `-c` context key is *derived* from this name rather than declared
   * — see {@link resourceEnvContextKey} — so one declaration cannot drift
   * from its own override.
   */
  readonly fromEnv?: FromEnv;
  /** A non-secret value authored in the declaration itself, never read from an environment file. */
  readonly authoredValue?: string;
  /** Permitted values of a string input, checked after normalization. */
  readonly values?: readonly Value[];
  /**
   * Set on the `.arn` projection of a secret, and nowhere else.
   *
   * The projection shares its secret's `path`, because it names the same
   * catalog entry: reading `resources.primaryDatabase.arn` is reading that
   * secret, and the grant follows from it. What it resolves to is the handle's
   * ARN rather than the handle — which is why its `kind` is `"string"`, and why
   * it is the one string a workload may hold that came from a secret. The
   * secret's *value* still has no way into an environment variable.
   */
  readonly secretArn?: true;
  /**
   * Set by a secret's `.field(key)` projection, and nowhere else: one JSON key
   * inside the secret, rather than the whole document.
   *
   * The projection shares its secret's `path` for the same reason `.arn` does
   * — it names the same catalog entry — and keeps `kind: "secret"`, because a
   * field of a secret is still the secret's contents. All it changes is how
   * much of the document the container is handed at startup.
   */
  readonly secretField?: string;
  /**
   * One line of authored prose beside the declaration, written for whoever
   * fills in cdk-app/.env.<mode>: "If using Bedrock". Documentation only — nothing
   * reads it at deploy time, and the hand-authored cdk-app/.env.*.template
   * templates are not generated from it.
   */
  readonly note?: string;
  /** Value used when the environment supplies nothing. */
  readonly default?: string;
  /** Catalog location, filled in by {@link defineResources}. */
  readonly path: Path;
  /** Native CDK attribute; the path identifies the linked construct. */
  readonly attribute?: string;
}

/** What an authored input is in one graph. */
export interface InputModePolicy {
  /** The graph holds the input. False only for `.only()` the other graph. */
  readonly present: boolean;
  /** Every enabled consumer must supply it. */
  readonly required: boolean;
  /** What stands in when cdk-app/.env.<mode> leaves it blank. */
  readonly default?: string;
  /** A standalone input's declared value; it has no environment fallback. */
  readonly value?: string;
}

/**
 * Names an environment variable must have to be a resource's `fromEnv`.
 *
 * `SCREAMING_SNAKE_CASE`, so the CDK context key that overrides it is derivable
 * rather than authored. That is the same shape every deployment variable in
 * this repository already uses.
 */
const ENVIRONMENT_VARIABLE_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

/**
 * The `-c` key that overrides a `fromEnv`, derived from its variable name:
 * `LANGGRAPH_MODEL_PROVIDER` is set by `-c langgraphModelProvider`.
 *
 * Derived rather than declared, because a per-declaration context key would be
 * a second name to keep in step with the first for no gain — every override in
 * this repository is already the camelCase of its variable.
 */
export function resourceEnvContextKey(variable: string): string {
  const [first, ...rest] = variable.toLowerCase().split("_");
  return [
    first ?? "",
    ...rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1)),
  ].join("");
}

/** A non-secret handle to a Secrets Manager secret. Never the secret's contents. */
export interface SecretHandle {
  /** Full ARN including the six-character suffix. */
  readonly secretArn: string;
  /** Customer-managed key, when the secret does not use the AWS-managed one. */
  readonly encryptionKeyArn?: string;
}

/** A group of declarations, or one declaration. Grouping is one level deep. */
export interface ResourceDeclarationGroup {
  readonly [key: string]: ResourceReference | CdkResourceSpec | CdkResourceGroupSpec | ResourceDeclarationGroup;
}

/**
 * The permissive catalog every structural consumer reads against.
 *
 * CDK stacks, both dev servers and tests *read* a config rather than authoring
 * one, and must keep working with synthetic fixtures — so their view accepts
 * any well-formed reference. `framework.config.ts` authors against its own
 * catalog instead, which is where the narrow checks apply.
 */
export interface AnyResourceCatalog {
  readonly __anyResourceCatalog?: never;
}

type IsAnyCatalog<Catalog> = [Catalog] extends [AnyResourceCatalog] ? true : false;

/**
 * Every leaf reference of a catalog view, optionally narrowed to one kind.
 *
 * A secret leaf contributes two: itself, and the `.arn` projection hanging off
 * it. The projection is a string, so asking for the string leaves of a view
 * that holds a secret yields the one thing about that secret a workload may
 * carry in an environment variable.
 */
export type ResourceLeaves<
  Catalog,
  Kind extends ResourceKind = ResourceKind,
> = Catalog extends CdkResourceSpec
  ? "string" extends Kind ? CdkAttributeReferences<Catalog> : never
  // A group's leaves are its members' attributes, its computed strings and its
  // secrets. Answered here rather than by the structural walk below, which
  // would descend into the construct types themselves and meet CDK's own
  // cycles (`node.scope`, `stack.nestedStackParent`).
  : Catalog extends CdkResourceGroupSpec
  ? | ("string" extends Kind ? CdkGroupAttributeReferences<Catalog> : never)
    | ("secret" extends Kind ? CdkGroupSecretReferences<Catalog> : never)
  : Catalog extends ResourceReference<
  infer LeafKind,
  readonly string[],
  boolean
>
  ?
      | (LeafKind extends Kind ? Catalog : never)
      | ("string" extends Kind
          ? Catalog extends { readonly arn: infer Arn }
            ? Arn
            : never
          : never)
      // `.value` is the secret itself, spelled the way a stack's secret has to
      // spell it. A leaf view that accepts the secret accepts its own name for
      // it, so one config can read both kinds the same way.
      | ("secret" extends Kind
          ? Catalog extends { readonly value: infer Value }
            ? Value
            : never
          : never)
  : Catalog extends object
    ? { [Key in keyof Catalog]: ResourceLeaves<Catalog[Key], Kind> }[keyof Catalog]
    : never;

/** A string reference usable in the target environment of this catalog view. */
export type StringResourceReference<Catalog> =
  IsAnyCatalog<Catalog> extends true
    ? ResourceReference<"string">
    : ResourceLeaves<Catalog, "string">;

/** A secret reference usable as a container's startup secret. */
export type SecretResourceReference<Catalog> =
  IsAnyCatalog<Catalog> extends true
    ? ResourceReference<"secret">
    : ResourceLeaves<Catalog, "secret">;


// ---------------------------------------------------------------------------
// Declaring resources
//
// A catalog can declare standalone values, environment inputs and secrets;
// native resource declarations remain owned by their stack.
//
//     resource.fromEnv("LANGGRAPH_BEDROCK_MODEL_ID")
//     resource.secret("OPENAI_API_KEY").note("platform.openai.com/api-keys")
//     resource.value("true").enum("true", "false")
//
// Environment-backed inputs name a line you author in cdk-app/.env.<mode>. A string needs no kind, because
// an environment variable has only one; a secret is the same line, marked as
// one the deployment uploads to Secrets Manager rather than writes into a
// template.
//
// Standalone values stay in source. Native values come off `resource.stack<T>()`: a
// construct's attribute, a string the stack computed, a secret the stack built
// or imported. Those are not declared here at all — the stack class is the
// declaration, and `linkResources(this, ...)` beside it is the whole binding.
//
// Each link narrows the declaration's type rather than recording an option, so
// `.default()` on a secret is not a runtime refusal but a type error: a secret
// has no fallback, because a fallback would be a secret in a source file.
//
// A declaration is deliberately *not* a {@link ResourceReference}. It finalizes
// into one — `defineResources` is where that happens, and where the catalog
// path it did not know is stamped in. Keeping them apart is what lets a
// declaration carry methods while a reference stays the plain, serializable
// data this module opens by promising.
// ---------------------------------------------------------------------------

declare const DECLARES: unique symbol;

/**
 * An unfinished declaration, carrying the reference it becomes.
 *
 * The phantom is how `defineResources` recovers the type parameters from a
 * chain of method calls: each link returns a declaration of a slightly
 * different reference, and the last one is what the catalog holds.
 */
export interface ResourceDeclaration<
  Reference extends ResourceReference = ResourceReference,
> {
  readonly [DECLARES]: Reference;
}

/**
 * What may be written inside {@link defineResources}. One level of grouping
 * deep, and `undefined` for an entry this deployment does not hold.
 */
export interface ResourceDeclarationInput {
  readonly [key: string]:
    | ResourceDeclaration
    | CdkResourceSpec
    | CdkResourceGroupSpec
    | ResourceDeclarationInput
    | undefined;
}

/**
 * A string read from a line you author in cdk-app/.env.<mode>.
 *
 * Optional until it is given a `default()`: a variable nobody set, with no
 * fallback to stand in for it, is a setting the workload never sees.
 *
 * `.enum()` narrows what the variable may say. Matching folds case by
 * definition — a choice list that rejected "OpenAI" would be a spelling test,
 * not a setting — and the declared spelling is what resolves, so the union
 * survives to the resolved value instead of widening to `string`.
 *
 * The rest says how the two graphs differ, and reads the same way for each:
 * `.only("dev")` declares the input in development alone, `.required("prod")`
 * requires it in production alone, and `.default({ dev: "a", prod: "b" })`
 * falls back differently per graph. Without a mode, each applies to every
 * graph the input is in.
 */
export interface EnvStringBuilder<
  FromEnv extends string,
  Optional extends boolean,
  Value extends string = string,
> extends ResourceDeclaration<
    ResourceReference<"string", readonly [], Optional, FromEnv, Value>
  > {
  enum<const Values extends readonly [string, ...string[]]>(
    ...values: Values
  ): EnvStringBuilder<FromEnv, Optional, Values[number]>;
  default(value: Value): EnvStringBuilder<FromEnv, false, Value>;
  default(values: { readonly dev: Value; readonly prod: Value }): EnvStringBuilder<FromEnv, false, Value>;
  default(values: ModeDefaults<Value>): EnvStringBuilder<FromEnv, Optional, Value>;
  note(text: string): EnvStringBuilder<FromEnv, Optional, Value>;
  required(mode?: CloudMode): EnvStringBuilder<FromEnv, Optional, Value>;
  only(mode: CloudMode): EnvStringBuilder<FromEnv, Optional, Value>;
}

/** A standalone non-secret input whose declaration supplies its value. */
export interface ValueInputBuilder<Value extends string = string> extends ResourceDeclaration<
  ResourceReference<"string", readonly [], false, undefined, Value>
> {
  enum<const Values extends readonly [string, ...string[]]>(...values: Values): ValueInputBuilder<Values[number]>;
  only(mode: CloudMode): ValueInputBuilder<Value>;
  note(text: string): ValueInputBuilder<Value>;
}

/** Per-graph string values. A standalone declaration must supply each present graph. */
export type ModeValues<Value extends string = string> =
  | { readonly dev: Value; readonly prod?: Value }
  | { readonly dev?: Value; readonly prod: Value };
/** Per-graph fallbacks. A graph left out has none. */
export type ModeDefaults<Value extends string = string> = ModeValues<Value>;

/** Input metadata; native construct identities remain owned by their declarations. */
export interface InputDeclarationOptions extends DeclarationMetadata {
  /** Preserve a managed secret's original binding, independently of its catalog name. */
  readonly bindingPath?: readonly string[];
}

/**
 * A secret whose value you author in cdk-app/.env.<mode>, and nowhere else.
 *
 * Locally that value is the whole story. For a deployment, `npm run deploy:resources`
 * copies it into Secrets Manager and supplies the ARN — never the value, which
 * reaches no template and no generated file.
 *
 * Optional by default: `.required()` adds a requirement to every consumer, and
 * `.required("prod")` only to production's; conditional needs belong in
 * `cloud.requirements` on each workload. A key one service needs for one model
 * provider must not block a deployment that chose another, or that does not
 * build the service.
 */
export interface EnvSecretBuilder<FromEnv extends string>
  extends ResourceDeclaration<
    ResourceReference<"secret", readonly [], true, FromEnv>
  > {
  note(text: string): EnvSecretBuilder<FromEnv>;
  required(mode?: CloudMode): EnvSecretBuilder<FromEnv>;
  only(mode: CloudMode): EnvSecretBuilder<FromEnv>;
}

/** Runtime brand. A declaration is recognized by this, never by shape alone. */
export const RESOURCE_DECLARATION_BRAND = "@repo/framework/resource-declaration" as const;

/** The declaration a builder is accumulating: a reference, minus its path. */
type DeclarationPayload = Omit<ResourceReference, "$resource" | "path">;

/**
 * A builder at runtime: a brand, and the declaration so far.
 *
 * The payload is held under one property rather than spread across the object
 * because the methods and the fields share two names — `note` and `default` are
 * each something you say and something a declaration holds. Spread flat, the
 * field would shadow the method.
 */
interface BuilderData {
  readonly $declaration: typeof RESOURCE_DECLARATION_BRAND;
  readonly $payload: DeclarationPayload;
  /** What the chain said about each graph, resolved to one by {@link withPaths}. */
  readonly $modes?: AuthoredModes;
}

/** `.only()`, `.required()` and `.default()` as written, before a graph is chosen. */
interface AuthoredModes {
  readonly only?: CloudMode;
  /** `"both"` for `.required()` without a mode. */
  readonly required?: CloudMode | "both";
  /** A string falls back in every graph; an object only in the graphs it names. */
  readonly default?: string | ModeDefaults;
  readonly value?: string | ModeValues;
}

function cloudMode(value: unknown, method: string): CloudMode {
  if (!CLOUD_MODES.includes(value as CloudMode)) {
    throw new Error(`${method} takes "dev" or "prod". Received ${JSON.stringify(value)}.`);
  }
  return value as CloudMode;
}

/** The values a `.default()` declares, whichever form it took. */
function declaredDefaults(value: AuthoredModes["default"]): readonly string[] {
  return value === undefined ? [] : typeof value === "string" ? [value] : Object.values(value);
}

export function isResourceDeclaration(value: unknown): value is ResourceDeclaration {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as BuilderData).$declaration === RESOURCE_DECLARATION_BRAND
  );
}

/** The declaration a builder has accumulated, for {@link withPaths}. */
function declarationPayload(value: ResourceDeclaration): DeclarationPayload {
  return (value as unknown as BuilderData).$payload;
}

const BUILDER_PROTOTYPE = {
  required(this: BuilderData, mode?: CloudMode): BuilderData {
    if (this.$modes?.value !== undefined) throw new Error("A standalone input already declares its value and cannot be marked required. Link an environment input to require an external value.");
    return rebuild(this, {}, { required: mode === undefined ? "both" : cloudMode(mode, ".required()") });
  },
  only(this: BuilderData, mode: CloudMode): BuilderData {
    return rebuild(this, {}, { only: cloudMode(mode, ".only()") });
  },
  enum(this: BuilderData, ...values: string[]): BuilderData {
    if (
      values.length === 0 ||
      values.some((value) => typeof value !== "string" || !value.trim())
    ) {
      throw new Error(".enum() requires at least one non-blank choice.");
    }
    if (new Set(values.map((value) => value.toLowerCase())).size !== values.length) {
      throw new Error(".enum() choices must be distinct without regard to case.");
    }
    const declared = declaredDefaults(this.$modes?.value ?? this.$modes?.default).find((value) => !values.includes(value));
    if (declared !== undefined) {
      throw new Error(
        `A choice list declares ${this.$modes?.value !== undefined ? "resource.value" : ".default"}(${JSON.stringify(declared)}), which is not one of ${values.join(", ")}.`,
      );
    }
    return rebuild(this, { values });
  },
  default(this: BuilderData, value: string | ModeDefaults): BuilderData {
    if (this.$modes?.value !== undefined) throw new Error("A standalone input has a value, not a default. Use resource.fromEnv() for an environment fallback.");
    const { kind, values } = this.$payload;
    const perMode = typeof value === "object" && value !== null && !Array.isArray(value);
    if (perMode && (!Object.keys(value).length || Object.keys(value).some((mode) => !CLOUD_MODES.includes(mode as CloudMode)))) {
      throw new Error(`A ${kind} resource declares .default(${JSON.stringify(value)}). Name a value, or one per graph: .default({ dev: "…", prod: "…" }).`);
    }
    const declared: readonly unknown[] = perMode ? Object.values(value) : [value];
    if (declared.some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error(
        `A ${kind} resource declares a blank .default(). Omit it, or name the value the deployment falls back to.`,
      );
    }
    const outside = values && (declared as readonly string[]).find((item) => !values.includes(item));
    if (outside !== undefined) {
      throw new Error(
        `A choice list declares .default(${JSON.stringify(outside)}), which is not one of ${values!.join(", ")}.`,
      );
    }
    // A default answers for the variable in its graphs, so the resolved
    // reference stops being optional there: something always supplies a value.
    return rebuild(this, {}, { default: perMode ? { ...value } : value as string });
  },
  note(this: BuilderData, text: string): BuilderData {
    if (typeof text !== "string" || !text.trim() || /[\r\n]/.test(text)) {
      throw new Error(
        `A ${this.$payload.kind} resource declares a blank or multi-line .note(). A note is one line of prose.`,
      );
    }
    return rebuild(this, { note: text });
  },
};

/**
 * A new builder carrying the change.
 *
 * Never a mutation: a chain reads as though each link produces a declaration,
 * and two declarations built from one prefix would otherwise share a value.
 * Absent rather than `undefined`, for the reason this module opens with — a
 * declaration should serialize and compare as the data it is.
 */
function rebuild(current: BuilderData, change: Record<string, unknown>, modes: AuthoredModes = {}): BuilderData {
  const payload: Record<string, unknown> = { ...current.$payload };
  for (const [key, value] of Object.entries(change)) {
    if (value === undefined) delete payload[key];
    else payload[key] = value;
  }
  const authored = { ...current.$modes, ...modes };
  return Object.assign(Object.create(BUILDER_PROTOTYPE), {
    $declaration: RESOURCE_DECLARATION_BRAND,
    $payload: payload as unknown as DeclarationPayload,
    ...(Object.keys(authored).length ? { $modes: authored } : {}),
  }) as BuilderData;
}

/**
 * What an authored declaration is in each graph.
 *
 * A setting for a graph the input is not in has nowhere to apply, so it is
 * refused rather than dropped: `.only("dev").required("prod")` says two things
 * that cannot both hold.
 */
function inputModes(declaration: ResourceDeclaration, path: readonly string[]): Readonly<Record<CloudMode, InputModePolicy>> {
  const authored = (declaration as unknown as BuilderData).$modes ?? {};
  const resolved = (mode: CloudMode): InputModePolicy => {
    const present = authored.only === undefined || authored.only === mode;
    const fallback = typeof authored.default === "string" ? authored.default : authored.default?.[mode];
    const value = typeof authored.value === "string" ? authored.value : authored.value?.[mode];
    if (authored.value !== undefined && present && value === undefined) throw new Error(`resources.${path.join(".")} needs a standalone value for ${mode}, or .only() for the graph that has a value.`);
    if (!present && (authored.required === mode || (typeof authored.default === "object" && fallback !== undefined) || (typeof authored.value === "object" && value !== undefined))) {
      throw new Error(
        `resources.${path.join(".")} is declared .only("${authored.only}"), so it has no ${mode} graph to be ${authored.required === mode ? "required" : authored.value !== undefined ? "given a value" : "given a default"} in. Remove the ${mode} setting, or .only().`,
      );
    }
    return {
      present,
      required: present && (authored.required === "both" || authored.required === mode),
      ...(present && fallback !== undefined ? { default: fallback } : {}),
      ...(present && value !== undefined ? { value } : {}),
    };
  };
  return { dev: resolved("dev"), prod: resolved("prod") };
}

function inputMetadata(options: InputDeclarationOptions | undefined, origin: string): Pick<ResourceReference, "tags" | "effectiveTags" | "bindingPath"> {
  const pin = options?.bindingPath;
  if (pin !== undefined && (!Array.isArray(pin) || !pin.length || [...pin].some(part => typeof part !== "string" || !RESOURCE_NAME_PATTERN.test(part)))) {
    throw new Error(`${origin}: bindingPath must be a non-empty array of catalog names, such as ["openaiApiKey"].`);
  }
  const tags = options?.tags === undefined ? undefined : validateTags(options.tags, origin);
  return { ...(tags === undefined ? {} : { tags, effectiveTags: tags }), ...(pin === undefined ? {} : { bindingPath: Object.freeze([...pin]) }) };
}

/** One authored input, of either kind, as the builder a chain continues from. */
function declareInput(kind: ResourceKind, variable?: string, options?: InputDeclarationOptions): BuilderData {
  if (
    variable !== undefined &&
    (typeof variable !== "string" || !ENVIRONMENT_VARIABLE_NAME.test(variable))
  ) {
    throw new Error(
      `A ${kind} resource is declared as ${JSON.stringify(variable)}. Name one SCREAMING_SNAKE_CASE environment variable, or pass no name to derive it from the catalog path.`,
    );
  }
  return Object.assign(Object.create(BUILDER_PROTOTYPE), {
    $declaration: RESOURCE_DECLARATION_BRAND,
    $payload: {
      kind,
      ...inputMetadata(options, `resource.${kind === "secret" ? "secret" : "fromEnv"}()`),
      // Optional until a `.default()` answers for it in the graph being built.
      // A secret has no default and stays optional: whether a deployment needs
      // it belongs to the workloads that read it, not to the catalog.
      optional: true,
      // "" asks `withPaths` to derive the name, which it can do and this
      // cannot: the path is not known until the catalog is declared.
      fromEnv: variable ?? "",
    } as unknown as DeclarationPayload,
  }) as BuilderData;
}

/**
 * The five ways to name something a workload needs.
 *
 * Deliberately small, and deliberately not a list of AWS service types. One
 * supplies a source value, two read a line you author, and two read what the
 * application's own CDK built.
 */
export interface ResourceFactory {
  /** A standalone non-secret value, authored once or explicitly for each graph. */
  value<const Value extends string>(value: Value | ModeValues<Value>, options?: InputDeclarationOptions): ValueInputBuilder<Value>;
  /** A reference to any native construct, linked beside its definition. */
  cdk<T>(options?: DeclarationMetadata): CdkResource<T>;
  /**
   * Everything a stack exposes, as one entry.
   *
   * The stack class is the declaration. `resource.stack<OrdersStack>()` reads
   * its public fields, so `resources.orders.documentsBucket` is typed by the
   * bucket the stack actually builds, `resources.orders.consoleUrl` by a string
   * it computed, and `resources.orders.apiKeySecret` by a secret it created or
   * imported — and renaming any of them fails to compile at every config that
   * read it. Application CDK answers with a single
   * `linkResources(this, resources.orders)`.
   *
   * Import the stack with `import type`: a value import would carry CDK into
   * the dev servers and the invocation runner, which load this catalog.
   */
  stack<T>(options?: import("./cdk-resources").StackResourceOptions<T>): CdkResourceGroup<T>;
  /** Read from the SCREAMING_SNAKE_CASE of this declaration's catalog path. */
  fromEnv(): EnvStringBuilder<string, true>;
  /** Read from the named variable, which is the spelling worth preferring. */
  fromEnv<const Name extends string>(variable: Name, options?: InputDeclarationOptions): EnvStringBuilder<Name, true>;
  /**
   * A secret you author in cdk-app/.env.<mode>, which `npm run deploy:resources` uploads to
   * Secrets Manager and supplies the ARN for.
   *
   * A secret a *stack* builds or imports is not declared here — it is a public
   * field, reached as `resources.orders.apiKeySecret`. Either way, what a
   * workload gets is chosen where the workload is declared: `.arn` in
   * `environment` hands a Lambda the address and the right to read it,
   * `.value` or `.field()` in `secrets` hands a container the contents at
   * startup. None of the three puts the value in a template.
   */
  secret(): EnvSecretBuilder<string>;
  secret<const Name extends string>(variable: Name, options?: InputDeclarationOptions): EnvSecretBuilder<Name>;
}

export const resource: ResourceFactory = {
  value<const Value extends string>(value: Value | ModeValues<Value>, options?: InputDeclarationOptions) {
    const perMode = typeof value === "object" && value !== null && !Array.isArray(value);
    if (perMode && (!Object.keys(value).length || Object.keys(value).some(mode => !CLOUD_MODES.includes(mode as CloudMode)))) throw new Error("resource.value() takes a non-secret string or { dev, prod } values.");
    const values: readonly unknown[] = perMode ? Object.values(value) : [value];
    if (values.some(item => typeof item !== "string" || !item.trim())) throw new Error("resource.value() requires a non-blank standalone value for every declared graph.");
    return Object.assign(Object.create(BUILDER_PROTOTYPE), {
      $declaration: RESOURCE_DECLARATION_BRAND,
      $payload: { kind: "string", optional: false, ...inputMetadata(options, "resource.value()") },
      $modes: { value: perMode ? { ...value } : value },
    }) as ValueInputBuilder<Value>;
  },
  cdk<T>(options?: DeclarationMetadata): CdkResource<T> {
    return cdkResource<T>([], options?.tags === undefined ? {} : { tags: validateTags(options.tags), effectiveTags: validateTags(options.tags) });
  },
  stack<T>(options?: import("./cdk-resources").StackResourceOptions<T>): CdkResourceGroup<T> {
    return cdkResourceGroup<T>([], false, options);
  },
  fromEnv(variable?: string, options?: InputDeclarationOptions) {
    return declareInput("string", variable, options) as unknown as EnvStringBuilder<string, true>;
  },
  secret(variable?: string, options?: InputDeclarationOptions) {
    return declareInput("secret", variable, options) as unknown as EnvSecretBuilder<string>;
  },
};

/**
 * One finalized leaf: the declaration as plain data, and — for a secret — the
 * `.arn` projection beside it.
 *
 * The builder's methods disappear here, because this names a
 * {@link ResourceReference} rather than the builder that produced it. That is
 * the type-level half of what `withPaths` does at runtime when it spreads a
 * builder into an object literal.
 */
type FinalizedResource<
  Kind extends ResourceKind,
  Path extends readonly string[],
  Optional extends boolean,
  FromEnv extends string | undefined,
  Value extends string,
> = Kind extends "secret"
  ? ResourceReference<Kind, Path, Optional, FromEnv, Value> & {
      /** This secret's ARN, for a workload that reads the secret itself. */
      readonly arn: ResourceReference<"string", Path, Optional, FromEnv> & { readonly secretArn: true };
      /**
       * The secret's contents, for a container that is handed them at startup.
       *
       * The same thing the reference itself means, spelled the way a stack's
       * secret has to spell it — so a config author never has to remember which
       * kind of secret they are holding.
       */
      readonly value: ResourceReference<Kind, Path, Optional, FromEnv, Value>;
    }
  : ResourceReference<Kind, Path, Optional, FromEnv, Value>;

/**
 * One catalog entry, finalized against its path.
 *
 * `NonNullable` is what lets a config write `PROD_DEPLOYMENT ? x : undefined`
 * and still read `resources.x.y` in both graphs: the *type* is always the shape
 * the entry would have, and the absent runtime placeholder carries that shape
 * with nothing behind it.
 */
type FinalizedEntry<Entry, Path extends readonly string[]> =
  Entry extends CdkResourceGroup<infer Stack>
    ? CdkResourceGroup<Stack, Path>
    : Entry extends CdkResource<infer Native>
    ? CdkResource<Native, Path> & Pick<Entry, Exclude<keyof Entry, keyof CdkResource<Native>>>
    : Entry extends ResourceDeclaration<
        ResourceReference<
          infer Kind,
          readonly string[],
          infer Optional,
          infer FromEnv,
          infer Value
        >
      >
    ? FinalizedResource<Kind, Path, Optional, FromEnv, Value>
    : WithResourcePaths<Entry, Path>;

type WithResourcePaths<Catalog, Prefix extends readonly string[]> = {
  readonly [Key in keyof Catalog]: FinalizedEntry<
    NonNullable<Catalog[Key]>,
    readonly [...Prefix, Key & string]
  >;
};

/** Stable generated-output key, derived from a resource's full catalog path. */
export function resourceOutputEnvironmentName(reference: Pick<ResourceReference, "path">): string {
  return reference.path.map((part) => part
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()).join("_");
}

const RESOURCE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;

function withPaths(
  group: Readonly<Record<string, unknown>>,
  prefix: readonly string[],
  mode: CloudMode | undefined,
): ResourceDeclarationGroup {
  const resolved: Record<string, ResourceReference | CdkResourceSpec | CdkResourceGroupSpec | ResourceDeclarationGroup> = {};
  for (const [name, entry] of Object.entries(group)) {
    const path = [...prefix, name];
    if (!RESOURCE_NAME_PATTERN.test(name)) {
      throw new Error(
        `resources.${path.join(".")} is not a camelCase name such as "userPoolId".`,
      );
    }
    // `PROD_DEPLOYMENT ? resource.stack<RdsStack>() : undefined`. The entry
    // keeps its place in the catalog — every config that reads it still
    // compiles — and resolves to nothing in every lane. A workload that names
    // it simply never sees the variable, which is what lets a handler fall back
    // to a local database rather than branch on a deployment mode it cannot
    // see. Minted as a group, because a group answers for any member asked of
    // it and a scalar reference answers only for itself.
    if (entry === undefined || entry === null) {
      resolved[name] = withCdkResourceGroupPath(
        { $cdkGroup: CDK_GROUP_BRAND, path: [], absent: true },
        path,
      ) as unknown as CdkResourceGroupSpec;
      continue;
    }
    if (isCdkResourceGroup(entry)) {
      if (prefix.length > 0) {
        throw new Error(
          `resources.${path.join(".")} declares a stack inside a group. A stack's resources are a group already.`,
        );
      }
      resolved[name] = withCdkResourceGroupPath(entry, path);
      continue;
    }
    if (isCdkResource(entry)) {
      resolved[name] = withCdkResourcePath(entry, path);
      continue;
    }
    if (isResourceDeclaration(entry)) {
      // Finalizing is unwrapping: the builder's payload *is* the declaration,
      // and everything else it carried — the brand, the chain's bookkeeping,
      // the prototype its methods live on — stops here. What comes out is a
      // plain object with a path and nothing left to call.
      const declaration = declarationPayload(entry);
      const modes = inputModes(entry, path);
      const varies = JSON.stringify(modes.dev) !== JSON.stringify(modes.prod);
      if (varies && mode === undefined) {
        throw new Error(
          `resources.${path.join(".")} differs between dev and prod, so the catalog has to know which graph it is building: defineResources({ ... }, { mode: FRAMEWORK_MODE }), with FRAMEWORK_MODE from "@repo/framework/config/source".`,
        );
      }
      // One graph's answer. Every lane reads these three fields and nothing
      // else, which is why no reader downstream ever compares modes.
      const own = modes[mode ?? "dev"];
      const reference: ResourceReference = {
        $resource: RESOURCE_REFERENCE_BRAND,
        ...declaration,
        optional: !own.present || (own.default === undefined && own.value === undefined),
        ...(own.present ? {} : { absent: true as const }),
        ...(own.required ? { required: true as const } : {}),
        ...(own.default === undefined ? {} : { default: own.default }),
        ...(own.value === undefined ? {} : { authoredValue: own.value }),
        ...(varies ? { modes } : {}),
        path,
        ...(declaration.fromEnv === ""
          ? { fromEnv: resourceOutputEnvironmentName({ path }) }
          : {}),
      };
      // A secret carries its own projections, built once here rather than by a
      // getter: each has to be the same plain data every other reference is, so
      // that stableStringify can compare a target that reads one against
      // another target that reads it.
      //
      // `.field()` is deliberately absent. It belongs to a secret a stack
      // built, whose document a deployment extracts a key from; an authored
      // secret is handed to a local container exactly as written, so a key
      // would be extracted in a deployment and not on your machine.
      resolved[name] = reference.kind === "secret"
        ? {
            ...reference,
            arn: { ...reference, kind: "string", secretArn: true },
            value: { ...reference },
          }
        : reference;
      continue;
    }
    if (typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(
        `resources.${path.join(".")} is not a resource declaration. Use resource.fromEnv("NAME") or resource.secret("NAME") for a value you author in cdk-app/.env.dev or cdk-app/.env.prod, resource.stack<T>() for what a stack builds, or group declarations in an object.`,
      );
    }
    if (prefix.length > 0) {
      throw new Error(
        `resources.${path.join(".")} nests a group inside a group. Resources are one level of grouping deep.`,
      );
    }
    resolved[name] = withPaths(entry as Readonly<Record<string, unknown>>, path, mode);
  }
  return resolved;
}

/**
 * Declares the application's resource catalog, stamping each declaration with
 * its own location.
 *
 * The returned object is what a config references — `resources.cognito.userPoolId`
 * *is* the reference — and `typeof resources` is what narrow catalog views are
 * taken from with `Pick`.
 *
 * With `{ mode }`, each authored input becomes that graph's answer: absent
 * outside its `.only()`, required where `.required()` names the graph, and
 * defaulted to that graph's `.default()`. A catalog whose inputs are the same
 * in both graphs needs no mode.
 */
export function defineResources<const Catalog extends ResourceDeclarationInput>(
  catalog: Catalog,
  options: DefineResourcesOptions = {},
): WithResourcePaths<Catalog, readonly []> {
  const mode = options.mode === undefined ? undefined : cloudMode(options.mode, "defineResources({ mode })");
  const resolved = withPaths(catalog, [], mode);
  // A pin reserves the same managed identity while input source/kind controls
  // temporarily make it dormant. Projections of one declaration are not entries.
  const identities = new Map<string, readonly string[]>();
  const visit = (entry: ResourceDeclarationGroup[string]): void => {
    if (isCdkResource(entry) || isCdkResourceGroup(entry)) return;
    if (isResourceReference(entry)) {
      if (!entry.bindingPath && !(entry.kind === "secret" && entry.fromEnv)) return;
      const bindingPath = entry.bindingPath ?? entry.path;
      const key = JSON.stringify(bindingPath);
      const previous = identities.get(key);
      if (previous) throw new Error(`Secret binding identity ${bindingPath.join(".")} is claimed by resources.${previous.join(".")} and resources.${entry.path.join(".")}. Preserve one owning declaration or choose a distinct bindingPath.`);
      identities.set(key, entry.path);
      return;
    }
    for (const child of Object.values(entry)) visit(child);
  };
  for (const entry of Object.values(resolved)) visit(entry);
  return resolved as unknown as WithResourcePaths<Catalog, readonly []>;
}

export interface DefineResourcesOptions {
  /**
   * The graph this catalog is resolved for: `FRAMEWORK_MODE` from
   * `@repo/framework/config/source`. Needed once any input differs between
   * graphs through `.only()`, `.required(mode)` or `.default({ dev, prod })`.
   */
  readonly mode?: CloudMode;
}

export function isResourceReference(value: unknown): value is ResourceReference {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as ResourceReference).$resource === RESOURCE_REFERENCE_BRAND
  );
}

/** Only an owned string payload is a source value; CDK proxies can synthesize arbitrary attribute names. */
export function isResourceValueReference(value: unknown): value is ResourceReference<"string"> & { readonly authoredValue: string } {
  return isResourceReference(value) && value.kind === "string" && Object.prototype.hasOwnProperty.call(value, "authoredValue") && typeof value.authoredValue === "string";
}

/**
 * A reference's catalog location, for diagnostics.
 *
 * The `.arn` projection says so, because "resources.primaryDatabase is
 * required" and "its ARN is what this Lambda reads" are different sentences
 * about the same entry, and the second is the one the author wrote.
 */
export function formatResourceReference(reference: ResourceReference): string {
  const path = `resources.${reference.path.join(".")}`;
  if (reference.attribute) return `${path}.${reference.attribute}`;
  if (reference.secretArn) return `${path}.arn`;
  if (reference.secretField !== undefined) {
    return `${path}.field(${JSON.stringify(reference.secretField)})`;
  }
  return path;
}

/** Whether a reference is the ARN projection of a declared secret. */
export function isSecretArnReference(
  reference: ResourceReference,
): boolean {
  return reference.secretArn === true;
}

/**
 * Whether the catalog left this resource out of the deployment being built.
 *
 * There is no mode argument because there is nothing to compare: the config
 * declared the entry `undefined`, and every lane that loads the config —
 * synthesis, the local runner, the generator — reads the same answer. An absent
 * resource resolves to nothing, so the workload that named it never sees the
 * variable.
 */
export function isResourceAbsent(reference: { readonly absent?: true }): boolean {
  return reference.absent === true;
}

/** Walks a catalog and yields every declaration with its path. */
export function listResourceDeclarations(
  catalog: ResourceDeclarationGroup,
): readonly ResourceReference[] {
  const declarations: ResourceReference[] = [];
  const visit = (group: ResourceDeclarationGroup): void => {
    for (const entry of Object.values(group)) {
      if (isResourceReference(entry)) declarations.push(entry);
      else if (!isCdkResource(entry) && !isCdkResourceGroup(entry) && entry && typeof entry === "object") {
        visit(entry as ResourceDeclarationGroup);
      }
    }
  };
  visit(catalog);
  return declarations;
}

/** Native declarations are distinct from scalar deployment inputs. */
export function listCdkResourceDeclarations(catalog: ResourceDeclarationGroup): readonly CdkResourceSpec[] {
  const declarations: CdkResourceSpec[] = [];
  const visit = (group: ResourceDeclarationGroup): void => {
    for (const entry of Object.values(group)) {
      if (isCdkResource(entry)) declarations.push(entry);
      else if (!isResourceReference(entry) && !isCdkResourceGroup(entry) && entry && typeof entry === "object") visit(entry as ResourceDeclarationGroup);
    }
  };
  visit(catalog);
  return declarations;
}

/**
 * The stacks this catalog declares.
 *
 * A group has no members until one is asked for, so it is listed as itself and
 * a reference is checked against it by path rather than by lookup.
 */
export function listCdkResourceGroupDeclarations(catalog: ResourceDeclarationGroup): readonly CdkResourceGroupSpec[] {
  return Object.values(catalog).filter(isCdkResourceGroup);
}

// ---------------------------------------------------------------------------
// Bindings — configuration and permission that must travel together
// ---------------------------------------------------------------------------

/**
 * Read access to a secret, plus the environment name its ARN arrives under.
 *
 * One value because they are one decision: a handler told where a secret lives
 * but unable to read it is broken in exactly the same way as one granted access
 * to a secret it cannot find. The secret's *contents* never enter the
 * environment.
 *
 * Derived, never authored. Writing `environment: { NAME: resources.x.arn }` is
 * what produces one — the read and the grant come from the same line, which is
 * why there is no second list to keep in step with the environment.
 */
export interface ReadSecretBinding<
  Reference extends ResourceReference<"secret"> = ResourceReference<"secret">,
> {
  readonly capability: "readSecret";
  readonly secret: Reference;
  /** Environment name carrying the secret ARN. */
  readonly environment: string;
}

/**
 * Permission to launch a declared ECS task, plus the environment name its
 * resolved launch descriptor arrives under.
 *
 * The same decision `readSecret` makes, against a target instead of a catalog
 * entry: a caller told where a task definition lives but unable to run it is
 * broken exactly like one granted `ecs:RunTask` on a definition it cannot name.
 * The `environment` name is derived from the target id rather than authored, so
 * one declaration cannot disagree with the variable the runtime helper reads.
 */
export interface RunsTaskBinding {
  readonly capability: "runsTask";
  /** Declared `tasks` target id. */
  readonly task: string;
  /** Filled in by normalization; never authored. */
  readonly environment?: string;
}

/** Permission to start a declared workflow, with its resolved descriptor name. */
export interface StartsWorkflowBinding {
  readonly capability: "startsWorkflow";
  /** Declared `workflows` target id. */
  readonly workflow: string;
  /** Filled in by normalization; never authored. */
  readonly environment?: string;
}

/**
 * An invocation binding is an edge, not a resource read: it names a target this
 * config also declares, and normalization is what proves the destination exists,
 * is enabled in the same execution lane, and does not close a cycle.
 */
export type InvocationBinding = RunsTaskBinding | StartsWorkflowBinding;

/**
 * Permission to invoke a declared AgentCore agent with `invokeAgent`.
 *
 * Like `runsTask`, the descriptor name is derived from the id. A service agent
 * is invoked with the caller's own role, which this binding grants; an agent
 * with users is invoked with the caller's user session, and normalization
 * refuses the edge from a caller that has none.
 */
export interface InvokesAgentBinding {
  readonly capability: "invokesAgent";
  readonly agent: string;
  readonly environment?: string;
}

export function invokesAgent(agent: string): InvokesAgentBinding {
  return { capability: "invokesAgent", agent };
}

/**
 * Permission to complete the callbacks of a declared integration.
 *
 * Declared by the *worker* — the Lambda or service that reads the queue and
 * answers — rather than derived from the workflow, because the workflow does
 * not know who consumes its messages and should not have to. One line grants
 * the Step Functions callback actions and, in a development deployment, the
 * path a worker in AWS uses to reach a developer's local execution.
 *
 * It injects no environment: a completion is routed by the worker's own
 * framework-issued environment and the handle in the message, never by a URL
 * the message carries.
 */
export interface CompletesCallbackBinding {
  readonly capability: "completesCallback";
  /** `queue:approvals` — the reference whose callbacks this worker answers. */
  readonly integration: string;
}

/**
 * What a target may declare in `cloud.bindings`.
 *
 * Secret reads are deliberately absent: a secret arrives through
 * `environment: { NAME: resources.x.arn }` or `secrets: { NAME: resources.x }`,
 * where the workload's other inputs are declared, and the binding it derives is
 * the framework's bookkeeping rather than something to author.
 */
export type ResourceBinding<Catalog = AnyResourceCatalog> =
  | InvocationBinding
  | InvokesAgentBinding
  | CompletesCallbackBinding
  | ConnectsToBinding
  | NativeGrantBinding;

/**
 * A construct a workload can open a connection to: one that carries CDK's
 * `connections`, such as a database instance. Matched by shape, because this
 * module never imports CDK as a value.
 */
export type Connectable = { readonly connections: object };

/**
 * A network edge: this workload opens connections to a resource inside the
 * application's network. Never authored: `database: true` on a workload is
 * normalized into one, pointing at the config's `database`.
 *
 * Where `runsTask` derives IAM, this derives the network. In a production
 * deployment it places a Lambda in the private subnets (or the isolated ones
 * it declares) and makes the workload a member of the one security group the
 * resource admits. Locally it is what hands the workload the Compose
 * stand-in, so a workload that forgot it fails on a laptop exactly as it would
 * in AWS.
 */
export interface ConnectsToBinding {
  readonly capability: "connectsTo";
  readonly resource: CdkResourceSpec;
  readonly readers?: true;
  readonly connection?: "application" | "direct";
  readonly pool?: import("../database-pool").ResolvedDatabasePool;
}

/**
 * Declares that this workload launches the named ECS task.
 *
 * One line derives the whole edge: the launch descriptor injected into the
 * caller's environment, the `ecs:RunTask` grant scoped to that task definition
 * revision and cluster, and the `iam:PassRole` grants the launch needs. It does
 * not promise the task started, succeeded, or produced output.
 */
export function runsTask(task: string): RunsTaskBinding {
  return { capability: "runsTask", task };
}

/** Declares that this workload starts the named workflow execution. */
export function startsWorkflow(workflow: string): StartsWorkflowBinding {
  return { capability: "startsWorkflow", workflow };
}

/**
 * Declares that this workload completes callbacks sent to an integration.
 *
 * ```ts
 * cloud: { bindings: [completesCallback(approvals)] }
 * ```
 *
 * The grant it derives uses `Resource: "*"`, because the Step Functions
 * callback actions do not support resource-level scoping — a task token is not
 * an ARN. That is AWS's constraint rather than a shortcut here, and it is why
 * the binding is declared per worker: only workers that actually answer get it.
 *
 * @see https://docs.aws.amazon.com/service-authorization/latest/reference/list_stepfunctions.html
 */
export function completesCallback(queue: CdkResource<unknown>): CompletesCallbackBinding {
  if (!isCdkResource(queue) || !queue.path.length) {
    throw new Error(
      "completesCallback() takes the catalog queue a worker answers on, such as resources.orders.approvalQueue.",
    );
  }
  // Recorded as a queue whatever kind the worker answers on: a topic or a bus
  // works the same way, because the grant this derives is the Step Functions
  // callback actions on Resource "*". The kind is a label here, not a scope.
  return {
    capability: "completesCallback",
    integration: `queue:${integrationIdForPath(queue.path)}`,
  };
}

/** Whether a binding is an invocation edge rather than a catalog read. */
export function isInvocationBinding(
  binding: { readonly capability: string },
): binding is InvocationBinding {
  return binding.capability === "runsTask" || binding.capability === "startsWorkflow";
}

/** The target reference an invocation binding names. */
export function invocationBindingTarget(binding: InvocationBinding): string {
  return binding.capability === "runsTask"
    ? `task:${binding.task}`
    : `workflow:${binding.workflow}`;
}

// ---------------------------------------------------------------------------
// Access statements — ordinary IAM, as data
// ---------------------------------------------------------------------------

/**
 * An IAM allow statement for a target's own role, written where the target is
 * declared.
 *
 * Resource ARNs may use `{partition}`, `{account}` and `{region}` placeholders,
 * which the CDK adapter fills from the synthesizing stack. Anything a capability
 * covers should be a capability instead; this is for permissions that have no
 * better name, such as the model calls a service makes.
 */
export interface CloudAccessStatement {
  readonly actions: readonly [string, ...string[]];
  readonly resources: readonly [string, ...string[]];
}

const ACCESS_PLACEHOLDERS = ["partition", "account", "region"] as const;
export type AccessPlaceholder = (typeof ACCESS_PLACEHOLDERS)[number];

/** Fills `{partition}`, `{account}` and `{region}` from the synthesizing stack. */
export function formatAccessResource(
  template: string,
  values: Readonly<Record<AccessPlaceholder, string>>,
): string {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    if (!(ACCESS_PLACEHOLDERS as readonly string[]).includes(name)) {
      throw new Error(
        `Access resource "${template}" uses an unknown placeholder "{${name}}". Expected ${ACCESS_PLACEHOLDERS.map(
          (placeholder) => `{${placeholder}}`,
        ).join(", ")}.`,
      );
    }
    return values[name as AccessPlaceholder];
  });
}

// ---------------------------------------------------------------------------
// Resolution — references become values, once, where resources are constructed
// ---------------------------------------------------------------------------

/** The value at a catalog path, or `undefined` if nothing supplied one. */
export function readResourcePath(values: unknown, path: readonly string[]): unknown {
  let current: unknown = values;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}


/**
 * How one lane answers for a reference: the CDK registry, or the local
 * process environment. Passed in rather than discovered, so this module still
 * knows nothing about either.
 */
export type ResourceResolver = (
  reference: ResourceReference,
  origin: string,
) => string | SecretHandle | undefined;

/**
 * The value a lane supplied for one reference.
 *
 * Thin on purpose. It exists so the absence rule is written once: a reference
 * the catalog left out of this deployment resolves to nothing everywhere, which
 * is how a database binding disappears from a graph that builds no database
 * rather than failing it. Everything else is the lane's to answer.
 */
export function resolveResourceReference(
  reference: ResourceReference,
  resolve: ResourceResolver,
  origin: string,
): string | SecretHandle | undefined {
  if (isResourceAbsent(reference)) return undefined;
  if (isResourceValueReference(reference)) return resolveResourceFromEnv(reference, {}, origin);
  return resolve(reference, origin);
}

// ---------------------------------------------------------------------------
// Deferred environment reads — a deployment input becomes a resource value
// ---------------------------------------------------------------------------

/**
 * Where an env-backed declaration is read from.
 *
 * Passed in explicitly, never discovered: this module does not know that
 * `cdk-app/.env.<mode>` exists, and loading it stays the entrypoint adapter's job. A
 * missing reader is simply a variable that supplies nothing.
 */
export interface ResourceEnvironmentReaders {
  /** The environment map each declaration's `fromEnv` variable is read from. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** CDK context lookup, for the `-c` key derived from that variable. */
  readonly getContext?: (key: string) => unknown;
  /**
   * Where a synced startup secret's ARN is read from.
   *
   * Passed in, never discovered: this module does not know that
   * cdk-app/.secret-bindings.json exists. A deployment leaves this unset —
   * `npm run deploy:resources` supplies each ARN as a CloudFormation parameter — so it is
   * how a stack is exercised with fixture handles instead.
   */
  readonly secretBindings?: SecretBindingDocument;
}

/**
 * The CDK's encoding for a value that is not known until deployment.
 *
 * Recognized by its documented marker rather than by importing CDK, which this
 * browser-safe module may not do.
 * @see https://docs.aws.amazon.com/cdk/v2/guide/tokens.html
 */
const STRING_TOKEN_PATTERN = /\$\{Token\[[^\]]*\]\}/;

export function isUnresolvedTokenString(value: unknown): boolean {
  return typeof value === "string" && STRING_TOKEN_PATTERN.test(value);
}

/** `LANGGRAPH_MODEL_PROVIDER or -c langgraphModelProvider`, for an error hint. */
export function formatResourceEnv(variable: string): string {
  return `${variable} or -c ${resourceEnvContextKey(variable)}`;
}

/** Blank and whitespace-only inputs count as absent, never as a set value. */
function readEnvString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  return text.trim() ? text : undefined;
}

/**
 * The handle a supplied binding document recorded for one authored secret.
 *
 * `undefined` when nothing has been synced, rather than an error: whether a
 * deployment can proceed without the secret is a question about the workloads
 * that read it, answered by their `cloud.requirements`. A secret nobody
 * requires is simply a variable the workload never sees.
 *
 * Exported because the composition root needs the same answer for a secret no
 * framework target reads — the Cognito identity provider's client secret, for
 * one — and two derivations of one name is how they drift apart.
 */
export function readSyncedSecret(
  reference: ResourceReference,
  bindings: SecretBindingDocument | undefined,
): SecretHandle | undefined {
  if (reference.kind !== "secret" || !reference.fromEnv) return undefined;
  const bound = bindings?.secrets[secretBindingKey(reference.fromEnv)];
  return bound === undefined ? undefined : { secretArn: bound.arn };
}

/**
 * How one authored string input resolves in the graph its reference was defined
 * for. Every reader — synthesis, the local lane, the client export and Studio —
 * states the rules through this one function:
 *
 * 1. An input outside its graph (`.only()` the other one) is `not-applicable`.
 * 2. A standalone declaration's value is `supplied`, without any external reads.
 *    An environment-linked input instead uses `-c` context, then a non-blank file line.
 * 3. Otherwise the graph's declared default is the `fallback`.
 * 4. Otherwise the input is `missing` when its declaration requires it, and
 *    `unresolved` when it is optional. Another graph's value never stands in.
 *
 * A blank line counts as unset. A choice list matches without regard to case and
 * resolves to its declared spelling; anything else is `invalid`. Secrets are not
 * resolved here: what a deployment reads for one is its synced handle.
 */
export type InputResolution =
  | { readonly state: "supplied" | "fallback" | "invalid"; readonly value: string }
  | { readonly state: "unresolved" | "missing" | "not-applicable" };

export function resolveInput(
  reference: Pick<ResourceReference, "fromEnv" | "authoredValue" | "absent" | "default" | "values" | "required">,
  readers: Pick<ResourceEnvironmentReaders, "env" | "getContext">,
): InputResolution {
  if (reference.absent) return { state: "not-applicable" };
  const authoredValue = Object.prototype.hasOwnProperty.call(reference, "authoredValue") && typeof reference.authoredValue === "string" ? reference.authoredValue : undefined;
  const variable = reference.fromEnv;
  const supplied = authoredValue !== undefined || variable === undefined ? undefined
    : (readers.getContext === undefined ? undefined : readEnvString(readers.getContext(resourceEnvContextKey(variable))))
      ?? (readers.env === undefined ? undefined : readEnvString(readers.env[variable]));
  const raw = authoredValue ?? supplied ?? reference.default;
  if (raw === undefined) return { state: reference.required ? "missing" : "unresolved" };
  // Trimmed before anything looks at it: a value that arrived with a trailing
  // newline from a shell pipeline is the value, not the value plus whitespace.
  const trimmed = raw.trim();
  const value = reference.values
    ? reference.values.find((allowed) => allowed.toLowerCase() === trimmed.toLowerCase())
    : trimmed;
  if (value === undefined) return { state: "invalid", value: trimmed };
  return { state: authoredValue !== undefined || supplied !== undefined ? "supplied" : "fallback", value };
}

/**
 * The same declaration as another graph resolves it, from the policy it keeps in
 * `modes`. A reference whose graphs agree is already every graph's answer.
 */
export function referenceForGraph<Reference extends ResourceReference>(reference: Reference, mode: CloudMode): Reference {
  const policy = reference.modes?.[mode];
  if (!policy) return reference;
  const { absent: _absent, required: _required, default: _default, authoredValue: _value, ...rest } = reference;
  return {
    ...rest,
    optional: !policy.present || (policy.default === undefined && policy.value === undefined),
    ...(policy.present ? {} : { absent: true as const }),
    ...(policy.required ? { required: true as const } : {}),
    ...(policy.default === undefined ? {} : { default: policy.default }),
    ...(policy.value === undefined ? {} : { authoredValue: policy.value }),
  } as Reference;
}

/**
 * The value a declared `fromEnv` supplies for one reference.
 *
 * Precedence is the derived context key, then the environment map, then the
 * declared default — the order `cdk-app/deployment.ts` has always read ordinary
 * flags in.
 *
 * Returns `undefined` only when nothing supplied a value and the declaration is
 * optional. Anything supplied is parsed here: an unlisted value, a blank
 * default, or something that is not a secret ARN is a deployment error reported
 * before a single construct exists.
 */
export function resolveResourceFromEnv(
  reference: ResourceReference,
  readers: ResourceEnvironmentReaders,
  origin: string,
): string | SecretHandle | undefined {
  if (isResourceAbsent(reference)) return undefined;
  if (isResourceValueReference(reference)) {
    if (reference.kind !== "string" || reference.fromEnv !== undefined || reference.secretArn || reference.secretField || reference.attribute) throw new Error(`${origin}: a standalone value must be a non-secret input without an environment or native attribute binding.`);
    const resolved = resolveInput(reference, {});
    if (resolved.state === "invalid") throw new Error(`${origin} ${formatResourceReference(reference)} must be one of ${reference.values!.join(", ")}. Edit its standalone value in source.`);
    return resolved.state === "supplied" ? resolved.value : undefined;
  }
  const variable = reference.fromEnv;
  if (!variable) {
    throw new Error(
      `${origin} asked for ${formatResourceReference(reference)} to be resolved from the environment, but it declares no "fromEnv".`,
    );
  }

  const where = `${origin} ${formatResourceReference(reference)}`;

  // A secret's value is not read here, and never is: what a deployment needs
  // is the ARN Secrets Manager returned when the authored value was copied into
  // it. Every later consumer — an environment entry, a
  // `.arn` projection, a container's startup secret — sees one already-resolved
  // handle and does not have to know which kind of secret it came from.
  //
  // The projection resolves to the handle too, not to the variable's contents.
  // It shares its secret's path, so one of the two fills that slot in the
  // resolved values and the other must not fill it with something else —
  // reading the raw value here is how the secret itself would end up in a
  // template.
  if (reference.kind === "secret" || reference.secretArn) {
    return readSyncedSecret(
      reference.secretArn ? { ...reference, kind: "secret" } : reference,
      readers.secretBindings,
    );
  }

  // Context first, then the variable, then the declared default — the order
  // every other deployment flag is read in, so a `-c` override still wins over
  // a value parked in `.env`. Requirements belong to consumers, checked by
  // assertRequirementsMet, so only an undefaulted non-optional input fails here.
  const resolved = resolveInput({ ...reference, required: undefined }, readers);
  if (resolved.state === "invalid") {
    throw new Error(
      `${where} must be one of ${reference.values!.join(", ")}. Set ${formatResourceEnv(variable)}.`,
    );
  }
  if (resolved.state === "supplied" || resolved.state === "fallback") return resolved.value;
  if (reference.optional || resolved.state === "not-applicable") return undefined;
  throw new Error(
    `${where} is required and was not supplied. Set ${formatResourceEnv(variable)}.`,
  );
}
