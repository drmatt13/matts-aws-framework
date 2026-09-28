import type { Stack } from "aws-cdk-lib";
import type { ResourceReference } from "./resources";

export const CDK_RESOURCE_BRAND = "@repo/framework/cdk-resource" as const;
export const CDK_GROUP_BRAND = "@repo/framework/cdk-resource-group" as const;
declare const CDK_TYPE: unique symbol;
declare const CDK_GROUP_TYPE: unique symbol;
export type JsonArgument = null | boolean | number | string | readonly JsonArgument[] | { readonly [key: string]: JsonArgument };

/** Serializable identity. It never contains a construct or a resolved attribute. */
export interface CdkResourceSpec {
  readonly $cdk: typeof CDK_RESOURCE_BRAND;
  readonly path: readonly string[];
  readonly optional: boolean;
  /** Set when the catalog left this entry out of the graph being built. */
  readonly absent?: true;
}

export interface NativeGrantBinding {
  readonly capability: "nativeGrant";
  readonly resource: CdkResourceSpec;
  readonly method: string;
  readonly arguments: readonly JsonArgument[];
}

type StringKeys<T> = { [K in keyof T]-?: NonNullable<T[K]> extends string ? K : never }[keyof T];
type GrantMethods<T> = {
  readonly [K in keyof T as K extends `grant${string}`
    ? T[K] extends (grantee: infer G, ...args: infer A) => unknown
      ? G extends { readonly grantPrincipal: unknown }
        ? A extends readonly (JsonArgument | undefined)[] ? K : never
        : never
      : never
    : never]: T[K] extends (grantee: any, ...args: infer A) => unknown
      ? (...args: A) => NativeGrantBinding : never;
};

export type CdkResource<T, Path extends readonly string[] = readonly string[]> = CdkResourceSpec & {
  readonly [CDK_TYPE]: T;
  readonly path: Path;
} & {
  readonly [K in StringKeys<T>]: ResourceReference<"string", Path> & { readonly attribute: K & string };
} & GrantMethods<T>;

export type CdkAttributeReferences<T> = T extends CdkResource<infer Native, infer Path>
  ? { [K in StringKeys<Native>]: ResourceReference<"string", Path> & { readonly attribute: K & string } }[StringKeys<Native>]
  : never;

export function isCdkResource(value: unknown): value is CdkResourceSpec {
  return typeof value === "object" && value !== null && (value as CdkResourceSpec).$cdk === CDK_RESOURCE_BRAND;
}

// ---------------------------------------------------------------------------
// A stack's own resources
//
// One catalog entry for a whole stack, rather than one per construct. The
// stack class is the declaration: what it exposes is what the catalog holds,
// and renaming a field is a compile error at every config that read it.
// ---------------------------------------------------------------------------

/** Serializable identity of a group. Like a resource, it holds no construct. */
export interface CdkResourceGroupSpec {
  readonly $cdkGroup: typeof CDK_GROUP_BRAND;
  readonly path: readonly string[];
  /** Set when the catalog left this stack out of the graph being built. */
  readonly absent?: true;
}

/** A construct, structurally: `node.path` is what nothing else carries. */
type ConstructLike = { readonly node: { readonly id: string; readonly path: string } };

/**
 * A Secrets Manager secret, structurally.
 *
 * Matched by shape rather than by importing `ISecret`, for the reason this
 * module imports only `type { Stack }`: the catalog is loaded by dev servers
 * that must not pull CDK in. `grantRead` is what separates a secret from
 * anything else carrying an ARN.
 */
type SecretLike = { readonly secretArn: string; grantRead(...args: never[]): unknown };

/**
 * The secret fields a stack exposes.
 *
 * Checked before {@link StackResourceKeys}, because a `Secret` construct is
 * also a construct: a field is a secret first, and reading it goes through
 * `.arn`, `.value` or `.field()` rather than through a string attribute.
 */
export type StackSecretKeys<T> = Exclude<
  { [K in keyof T]-?: NonNullable<T[K]> extends SecretLike ? K : never }[keyof T],
  keyof Stack
> & string;

/**
 * The construct fields a stack adds to what every stack already has.
 *
 * `keyof` omits private and protected members, so a field becomes a resource
 * only once the stack offers it to its callers — and `keyof Stack` drops the
 * inherited `node` and `nestedStackParent`, which are constructs but nobody's
 * resources.
 */
export type StackResourceKeys<T> = Exclude<
  { [K in keyof T]-?: NonNullable<T[K]> extends ConstructLike ? K : never }[keyof T],
  keyof Stack | StackSecretKeys<T>
> & string;

/**
 * The plain string fields a stack adds to what every stack already has.
 *
 * A stack holds values a construct cannot be asked for: `domain.baseUrl()` is a
 * method, a trusted-origin list is a join of several inputs. Those are the
 * stack's answers as much as its buckets are, so they belong to the same entry
 * rather than to a separate declaration linked from somewhere else in the
 * composition root.
 *
 * This is also why a stack must not expose a string built from a secret's
 * value: a public string field *is* a resource, and a workload may put it in an
 * environment variable. Keep such a value private.
 *
 * `Exclude<..., keyof Stack>` drops `region`, `account`, `environment`,
 * `templateFile` and `artifactId` — strings on every stack, and nobody's
 * resources. {@link STACK_OWN_VALUE_KEYS} is the same exclusion at runtime.
 */
export type StackValueKeys<T> = Exclude<
  { [K in keyof T]-?: NonNullable<T[K]> extends string ? K : never }[keyof T],
  keyof Stack
> & string;

/**
 * `Stack`'s own string properties, which `Exclude<..., keyof Stack>` removes
 * from {@link StackValueKeys} and this removes from the link walk.
 *
 * Listed rather than derived: reading them off a throwaway `Stack` would mean
 * constructing one, and this file is the browser-safe half that may not import
 * CDK as a value.
 */
export const STACK_OWN_VALUE_KEYS: ReadonlySet<string> = new Set([
  "region", "account", "environment", "templateFile", "artifactId",
]);

/**
 * How a secret is read, and the only way one is read off a stack.
 *
 * The field name says which secret; it does not say what the workload wants
 * from it, and those are three different things with three different
 * consequences. `.arn` is the address — a plain, public string — and delivering
 * it is what grants the workload permission to read the secret for itself.
 * `.value` hands a container the whole document at startup. `.field()` hands it
 * one key. Neither of the last two reaches a CloudFormation template.
 */
export interface SecretProjections<Path extends readonly string[] = readonly string[]>
  extends CdkResourceSpec {
  readonly path: Path;
  /** The secret's ARN, for a workload that reads the secret itself. */
  readonly arn: ResourceReference<"string", Path> & { readonly secretArn: true };
  /** The whole secret document, injected into a container at startup. */
  readonly value: ResourceReference<"secret", Path>;
  /** One JSON key of the secret document, injected into a container at startup. */
  field(key: string): ResourceReference<"secret", Path> & { readonly secretField: string };
}

export type CdkResourceGroup<T, Path extends readonly string[] = readonly string[]> = CdkResourceGroupSpec & {
  readonly [CDK_GROUP_TYPE]: T;
  readonly path: Path;
} & {
  readonly [K in StackResourceKeys<T>]: CdkResource<NonNullable<T[K]>, readonly [...Path, K]>;
} & {
  readonly [K in StackValueKeys<T>]: ResourceReference<"string", readonly [...Path, K]>;
} & {
  readonly [K in StackSecretKeys<T>]: SecretProjections<readonly [...Path, K]>;
};

export function isCdkResourceGroup(value: unknown): value is CdkResourceGroupSpec {
  return typeof value === "object" && value !== null && (value as CdkResourceGroupSpec).$cdkGroup === CDK_GROUP_BRAND;
}

/**
 * A group mints each member on access, because the member names live in the
 * stack's type and a type cannot be enumerated at runtime. Every reader —
 * config, synthesis, the local runner — asks for the field it wants by name,
 * so the set that is never asked for is the set that never has to exist.
 *
 * Each member carries both brands, because the name alone does not say whether
 * the stack's field holds a construct or a string, and a type cannot be
 * consulted here. `resources.cognito.userPool` is read as a construct — its
 * attributes, its grants — and `resources.cognito.userPoolDomainUrl` is read as
 * a string; the types keep those apart at every call site, and what the stack
 * linked decides which one a resolver finds. Minting two shapes would mean
 * guessing at access time, which is the guess this avoids.
 *
 * A secret is the one field that is never read bare, because the three things
 * you can want from it differ — see {@link SecretProjections}. That projection
 * is what carries `kind: "secret"`, so the ambiguity the other two live with
 * never arises for a secret.
 */
export function cdkResourceGroup<T>(
  path: readonly string[] = [],
  absent = false,
): CdkResourceGroup<T> {
  const spec = Object.freeze({
    $cdkGroup: CDK_GROUP_BRAND,
    path: Object.freeze([...path]),
    ...(absent ? { absent: true as const } : {}),
  });
  const members = new Map<string, CdkResource<unknown>>();
  return new Proxy(spec, {
    get(target, property, receiver) {
      if (typeof property !== "string") return Reflect.get(target, property, receiver);
      if (Object.prototype.hasOwnProperty.call(target, property)) return Reflect.get(target, property, receiver);
      if (["then", "toJSON", "constructor", "__proto__", "prototype"].includes(property)) return undefined;
      let member = members.get(property);
      if (!member) {
        // The brand is spelled out rather than imported, as it is below: this
        // module stays free of a cycle back into ./resources.
        member = cdkResource<unknown>([...path, property], {
          $resource: "@repo/framework/resource",
          kind: "string",
          ...(absent ? { absent: true as const } : {}),
        });
        members.set(property, member);
      }
      return member;
    },
  }) as unknown as CdkResourceGroup<T>;
}

export function withCdkResourceGroupPath(group: CdkResourceGroupSpec, path: readonly string[]): CdkResourceGroup<object> {
  return cdkResourceGroup<object>(path, group.absent === true);
}

/**
 * Every string a group offers: each construct's string attributes, each string
 * field the stack computed, and each secret's ARN.
 */
export type CdkGroupAttributeReferences<G> = G extends CdkResourceGroup<infer Native, infer Path>
  ?
      | {
          [K in StackResourceKeys<Native>]: CdkAttributeReferences<
            CdkResource<NonNullable<Native[K]>, readonly [...Path, K]>
          >;
        }[StackResourceKeys<Native>]
      | {
          [K in StackValueKeys<Native>]: ResourceReference<"string", readonly [...Path, K]>;
        }[StackValueKeys<Native>]
      | {
          [K in StackSecretKeys<Native>]: SecretProjections<readonly [...Path, K]>["arn"];
        }[StackSecretKeys<Native>]
  : never;

/** Every secret a group offers, as the references a container's `secrets` accepts. */
export type CdkGroupSecretReferences<G> = G extends CdkResourceGroup<infer Native, infer Path>
  ? {
      [K in StackSecretKeys<Native>]:
        | SecretProjections<readonly [...Path, K]>["value"]
        | ReturnType<SecretProjections<readonly [...Path, K]>["field"]>;
    }[StackSecretKeys<Native>]
  : never;

/** Whether a reference names a member of this group. */
export function isGroupMember(group: CdkResourceGroupSpec, path: readonly string[]): boolean {
  return path.length === group.path.length + 1 && group.path.every((part, index) => path[index] === part);
}

export function assertJsonArguments(value: unknown, origin: string): void {
  const seen = new Set<object>();
  const visit = (item: unknown): void => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object" || item === null || seen.has(item)) throw new Error(`${origin} accepts finite JSON arguments, not constructs, functions, or circular values.`);
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new Error(`${origin} accepts JSON arguments. Apply grants requiring construct arguments in application CDK.`);
    }
    seen.add(item);
    for (const child of Object.values(item)) visit(child);
    seen.delete(item);
  };
  visit(value);
}

/**
 * A {@link ResourceReference}'s own optional fields, which a group member must
 * answer `undefined` for rather than turn into an attribute.
 *
 * A member carries the reference brand, so every reader treats it as a
 * reference and asks it whether it has a `fromEnv`, a `default`, an
 * `attribute`. Minting one on the way past would answer "yes" to all of them
 * with an object, which is how a generated env example ends up reading
 * "read locally from [object Object]". The fields the spec already owns —
 * `path`, `optional`, `kind`, `absent` — are answered by the spec itself, and
 * `arn`/`value`/`field` are answered by the secret projections above.
 */
const REFERENCE_FIELDS = ["fromEnv", "values", "secretArn", "secretField", "note", "default", "attribute"];

/** Only accessed attributes become references; the native construct is never enumerated. */
export function cdkResource<T>(
  path: readonly string[] = [],
  extra: Readonly<Record<string, unknown>> = {},
): CdkResource<T> {
  const spec = Object.freeze({ $cdk: CDK_RESOURCE_BRAND, path: Object.freeze([...path]), optional: false, ...extra });
  // Set by `cdkResourceGroup`, and the one thing that distinguishes a stack
  // member from a standalone `resource.cdk<T>()`.
  const isGroupMember = extra.$resource !== undefined;
  const absent = extra.absent === true ? { absent: true as const } : {};
  // Memoized, so `resources.orders.bucket.bucketName` is the same reference
  // every time it is read. Nothing depends on identity — comparison is by
  // value — but a proxy that minted a new object per access would make an
  // ordinary `assert.equal` lie, and that is a surprise with no upside.
  const projections = new Map<string, unknown>();
  const projection = (key: string, fields: Readonly<Record<string, unknown>>) => {
    let existing = projections.get(key);
    if (!existing) {
      existing = Object.freeze({
        $resource: "@repo/framework/resource",
        path: spec.path,
        optional: false,
        ...absent,
        ...fields,
      });
      projections.set(key, existing);
    }
    return existing;
  };
  return new Proxy(spec, {
    get(target, property, receiver) {
      if (property === Symbol.toPrimitive) return () => { throw new Error("A resource reference is not a value. Use its attribute in a workload environment."); };
      if (typeof property !== "string") return Reflect.get(target, property, receiver);
      if (Object.prototype.hasOwnProperty.call(target, property)) return Reflect.get(target, property, receiver);
      if (["then", "toJSON", "constructor", "__proto__", "prototype"].includes(property)) return undefined;
      if (isGroupMember && REFERENCE_FIELDS.includes(property)) return undefined;
      // The secret projections. Offered on every member at runtime and on only
      // the secret ones in the type, the way attributes already are.
      if (isGroupMember && property === "arn") return projection("arn", { kind: "string", secretArn: true });
      if (isGroupMember && property === "value") return projection("value", { kind: "secret" });
      if (isGroupMember && property === "field") return (key: string) => {
        if (typeof key !== "string" || !/^[^:\s]+$/.test(key)) {
          throw new Error(`resources.${path.join(".")}.field(${JSON.stringify(key)}) names one JSON key of the secret document.`);
        }
        return projection(`field:${key}`, { kind: "secret", secretField: key });
      };
      if (property.startsWith("grant")) return (...args: unknown[]): NativeGrantBinding => {
        const trimmed = [...args];
        while (trimmed[trimmed.length - 1] === undefined && trimmed.length) trimmed.pop();
        assertJsonArguments(trimmed, property);
        return Object.freeze({ capability: "nativeGrant", resource: spec, method: property, arguments: trimmed as JsonArgument[] });
      };
      return projection(`attribute:${property}`, { kind: "string", attribute: property });
    },
  }) as unknown as CdkResource<T>;
}

export function withCdkResourcePath(reference: CdkResourceSpec, path: readonly string[]): CdkResource<object> {
  const { $cdk, path: ignored, optional, ...extra } = reference as CdkResourceSpec & Record<string, unknown>;
  return cdkResource(path, extra);
}

/**
 * A catalog path as a stable kebab-case id: `["orders","recordsTable"]` becomes
 * `orders-records-table`.
 *
 * What a workflow integration is named by. Derived rather than declared, so one
 * construct cannot end up with two spellings.
 */
export function integrationIdForPath(path: readonly string[]): string {
  return path
    .map((part) => part.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase())
    .join("-");
}

/** An unambiguous key shared by synthesis, export, and local execution. */
export function resourceAttributeKey(reference: Pick<ResourceReference, "path" | "attribute" | "secretArn" | "kind">): string {
  return JSON.stringify([reference.path, reference.attribute ?? (reference.secretArn || reference.kind === "secret" ? "secretArn" : "value")]);
}
