import { createHash } from "node:crypto";
import * as cdk from "aws-cdk-lib";
import type { IConstruct } from "constructs";
import type { IGrantable } from "aws-cdk-lib/aws-iam";
import type { ISecret } from "aws-cdk-lib/aws-secretsmanager";
import {
  assertRequirementsMet,
  formatResourceReference, frameworkSecretName, getFrameworkTargets, isCdkResource, isCdkResourceGroup,
  isResourceAbsent, isResourceReference, isTargetEnabled,
  resourceAttributeKey, resolveResourceFromEnv, isUnresolvedTokenString, STACK_OWN_VALUE_KEYS,
  type CdkResource, type CdkResourceGroup, type CdkResourceSpec, type CloudMode, type FrameworkConfig,
  type SecretProjections,
  type NativeGrantBinding, type NormalizedTarget, type ResolvedCloudRequirement,
  type ResourceEnvironmentReaders, type ResourceResolver,
  type ResourceReference, type SecretHandle,
} from "@repo/framework/config";


export const RESOURCE_OUTPUT_PREFIX = "framework:resource:v1:";
export const DEPLOYMENT_OUTPUT_DESCRIPTION = "framework:deployment:v1";
export const SECRET_PARAMETER_METADATA = "framework:secret-parameter:v1";

interface Link { readonly scope: IConstruct; readonly value: unknown }
interface Options {
  readonly config: FrameworkConfig;
  readonly mode: CloudMode;
  readonly deployment: string;
  readonly readers?: ResourceEnvironmentReaders;
}
interface Registry {
  options?: Options;
  readonly links: Map<string, Link>;
  readonly integrations: Map<string, { binding: import("./framework-integrations").BoundIntegration; where: string }>;
  readonly pending: Array<() => void>;
  readonly parameters: Map<string, { parameter: cdk.CfnParameter; required: boolean }>;
  readonly edges: Array<{ from: cdk.Stack; to: cdk.Stack; origin: string }>;
  finalized: boolean;
}
const registries = new WeakMap<IConstruct, Registry>();
function registry(scope: IConstruct): Registry {
  const root = scope.node.root;
  let value = registries.get(root);
  if (!value) {
    value = { links: new Map(), integrations: new Map(), pending: [], parameters: new Map(), edges: [], finalized: false };
    registries.set(root, value);
  }
  return value;
}
const keyOf = (reference: { readonly path: readonly string[] }): string => JSON.stringify(reference.path);

/**
 * Why a resource has no value, phrased for the fix that is actually likely.
 *
 * A member of a `resource.stack<T>()` group is supplied by its stack's one
 * `linkResources(this, ...)` call, so a missing one almost always means the
 * stack is not built, or its constructor does not end with that call —
 * `linkResource` for a single member is the escape hatch, not the fix.
 */
function unlinkedMessage(
  state: Registry,
  reference: ResourceReference,
  origin: string,
): string {
  const [root] = reference.path;
  const catalog = state.options?.config.resources as Record<string, unknown> | undefined;
  const name = formatResourceReference(reference);
  if (root !== undefined && reference.path.length > 1 && isCdkResourceGroup(catalog?.[root])) {
    return [
      `${origin}: ${name} is not linked.`,
      `resources.${root} is a resource.stack<T>() entry, so its members come from that stack. Check that:`,
      `  - the stack is constructed in cdk-app/bin/cdk-app.ts for this deployment, and`,
      `  - its constructor ends with linkResources(this, resources.${root}), after every public field is assigned.`,
    ].join("\n");
  }
  return `${origin}: ${name} is not linked. Call linkResource(scope, resources.${reference.path.join(".")}, construct) beside its native definition.`;
}
const digest = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 20);

export function initializeFrameworkResources(scope: IConstruct, options: Options): void {
  const state = registry(scope);
  if (state.options) throw new Error("Framework resources were initialized twice in this app.");
  state.options = options;
  scope.node.addValidation({ validate: () => state.finalized ? [] : ["Call finalizeFrameworkResources(app) after composing the application."] });
}

export function hasFrameworkResources(scope: IConstruct): boolean { return !!registry(scope).options; }

/** The config, graph and deployment name this app was initialized with. */
export function frameworkResourceOptions(scope: IConstruct): Readonly<Options> | undefined { return registry(scope).options; }

/** A stack's secret, for a stack that links one field rather than all of them. */
export function linkResource(scope: IConstruct, reference: SecretProjections, construct: ISecret): ISecret;
export function linkResource<T>(scope: IConstruct, reference: CdkResource<T>, construct: NoInfer<T>): T;
export function linkResource(scope: IConstruct, reference: ResourceReference<"secret">, construct: ISecret): ISecret;
export function linkResource(scope: IConstruct, reference: ResourceReference<"string">, value: string): string;
export function linkResource(scope: IConstruct, reference: CdkResourceSpec | SecretProjections | ResourceReference, value: unknown): unknown {
  if ((!isCdkResource(reference) && !isResourceReference(reference)) || !reference.path.length) {
    throw new Error("linkResource() takes a reference from defineResources().");
  }
  if (isResourceReference(reference) && (reference.fromEnv || reference.attribute || reference.secretArn || reference.secretField)) {
    throw new Error("Link the catalog resource itself, not an input or attribute projection.");
  }
  const state = registry(scope);
  if (state.finalized) throw new Error("Resources cannot be linked after framework finalization.");
  const key = keyOf(reference);
  const existing = state.links.get(key);
  if (existing) throw new Error(`resources.${reference.path.join(".")} is linked twice: ${existing.scope.node.path} and ${scope.node.path}.`);
  cdk.Stack.of(scope);
  // A stack entry's member is whatever its field holds, and the field decides:
  // a construct to read attributes and grants from, or a string the stack
  // computed. The reference carries both brands precisely because the name
  // alone cannot say which, so the value is what settles it here.
  const linksConstruct = !!value && typeof value === "object" && !!(value as IConstruct).node;
  if (isCdkResource(reference) && linksConstruct) {
    if ((value as IConstruct).node.root !== scope.node.root) throw new Error("A resource and its consumers must belong to the same CDK application.");
  } else if (isCdkResource(reference)) {
    if (typeof value !== "string" || cdk.SecretValue.isSecretValue(value)) {
      throw new Error(`resources.${reference.path.join(".")} must link to a CDK construct or to a plain string the stack computed.`);
    }
  } else if (reference.kind === "secret") {
    if (!value || typeof (value as ISecret).secretArn !== "string" || typeof (value as ISecret).grantRead !== "function") throw new Error(`${formatResourceReference(reference)} must link to an ISecret.`);
  } else if (typeof value !== "string" || cdk.SecretValue.isSecretValue(value)) {
    throw new Error(`${formatResourceReference(reference)} must link to a non-secret string.`);
  }
  const owner = value && typeof value === "object" && (value as IConstruct).node ? value as IConstruct : scope;
  if (owner.node.root !== scope.node.root) throw new Error("A resource must belong to the same CDK application as its link.");
  state.links.set(key, { scope: owner, value });
  return value;
}

/**
 * Links everything a stack exposes, in one call.
 *
 * The stack's own public fields are the catalog: what it holds is read here,
 * and each field is linked under the name it already has — a construct, or a
 * string the stack computed, which is the same kind of answer and reached the
 * same way. Accessors count too, so a private construct can publish one
 * attribute without publishing itself. A field the stack keeps private is not a
 * resource, because `keyof` never offered it to the catalog's type.
 *
 * Call it last in the constructor. Fields assigned after this line have not
 * been set yet, and a resource nobody linked is reported by name at synthesis
 * rather than silently skipped.
 */
export function linkResources<T extends IConstruct>(scope: T, group: CdkResourceGroup<T>): void {
  if (!isCdkResourceGroup(group) || !group.path.length) {
    throw new Error("linkResources() takes a resource.stack() entry from defineResources().");
  }
  const linkable = (value: unknown): boolean =>
    value !== scope &&
    (typeof value === "string" ||
      (!!value && typeof value === "object" && typeof (value as IConstruct).node?.path === "string"));

  const fields = new Map<string, IConstruct | string>();
  // Accessors first, so an own field of the same name wins. The walk stops at
  // `Stack.prototype`, which is exactly the line `Exclude<..., keyof Stack>`
  // draws in the group's type: a `get documentsBucketArn()` on this class is a
  // resource, and the `region` every stack inherits is not.
  for (
    let prototype = Object.getPrototypeOf(scope) as object | null;
    prototype && prototype !== cdk.Stack.prototype;
    prototype = Object.getPrototypeOf(prototype) as object | null
  ) {
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(prototype))) {
      if (name.startsWith("_") || name === "constructor" || !descriptor.get) continue;
      const value = (scope as unknown as Record<string, unknown>)[name];
      if (linkable(value)) fields.set(name, value as IConstruct | string);
    }
  }
  for (const [name, value] of Object.entries(scope)) {
    // `region`, `account`, `environment`, `templateFile` and `artifactId` sit
    // on every stack instance. The same exclusion, at runtime.
    if (name.startsWith("_") || STACK_OWN_VALUE_KEYS.has(name) || !linkable(value)) continue;
    fields.set(name, value as IConstruct | string);
  }
  if (!fields.size) {
    throw new Error(`resources.${group.path.join(".")} found nothing to link on ${scope.node.path}. Call linkResources() after the stack's public fields are assigned.`);
  }
  for (const [name, field] of fields) {
    linkResource(scope, (group as unknown as Record<string, CdkResource<IConstruct>>)[name]!, field as IConstruct);
  }
}

/** Workflow operation metadata and ordinary resource links share application ownership. */
export function integrationRegistry(scope: IConstruct) { return registry(scope).integrations; }

/**
 * The construct a catalog entry was linked to, and where it was linked.
 *
 * A workflow reaching a table uses this rather than a registry of its own: the
 * construct is already linked for every other consumer, so there is one place
 * an application says what a name means.
 */
export function linkedConstruct(
  scope: IConstruct, reference: CdkResourceSpec,
): { readonly construct: unknown; readonly owner: IConstruct } | undefined {
  const link = registry(scope).links.get(keyOf(reference));
  return link ? { construct: link.value, owner: link.scope } : undefined;
}

/** Every catalog path this app has linked, for a message that names the alternatives. */
export function linkedResourcePaths(scope: IConstruct): readonly string[] {
  return [...registry(scope).links.keys()].map((key) => (JSON.parse(key) as string[]).join("."));
}

export function deferResourceAttachment(scope: IConstruct, action: () => void): void {
  const state = registry(scope);
  // Low-level stacks may still be exercised with explicit fixture values.
  if (!state.options) { action(); return; }
  if (state.finalized) throw new Error("A workload was added after framework finalization.");
  state.pending.push(action);
}

function noteEdge(scope: IConstruct, link: Link, origin: string): void {
  const from = cdk.Stack.of(scope);
  const to = cdk.Stack.of(link.scope);
  if (from !== to) registry(scope).edges.push({ from, to, origin });
}

/** Native getter access happens here, after all constructs have been registered. */
export function resolveLinkedResource(
  scope: IConstruct, reference: ResourceReference, origin: string, required = false,
): string | SecretHandle | undefined {
  if (isResourceAbsent(reference)) {
    if (required) throw new Error(`${origin}: ${formatResourceReference(reference)} is required, and framework-config/resources.ts declares it as undefined for this deployment.`);
    return undefined;
  }
  const state = registry(scope);
  if (reference.fromEnv) {
    if (reference.kind === "secret" || reference.secretArn) {
      const handle = deploymentSecret(scope, reference, required);
      return reference.secretArn ? handle?.secretArn : handle;
    }
    return resolveResourceFromEnv(reference, state.options?.readers ?? {}, origin) as string | undefined;
  }
  const link = state.links.get(keyOf(reference));
  if (!link) {
    if (reference.optional && !required) return undefined;
    throw new Error(unlinkedMessage(state, reference, origin));
  }
  if (reference.kind === "secret" || reference.secretArn) {
    const secret = link.value as ISecret;
    if (typeof secret.secretArn !== "string") throw new Error(`${origin}: ${formatResourceReference(reference)} is not linked to a secret.`);
    if (cdk.Token.isUnresolved(secret.secretArn)) noteEdge(scope, link, `${origin}: ${formatResourceReference(reference)}`);
    return reference.secretArn ? secret.secretArn : {
      secretArn: secret.secretArn,
      ...(secret.encryptionKey ? { encryptionKeyArn: secret.encryptionKey.keyArn } : {}),
    };
  }
  const value = reference.attribute ? (link.value as Record<string, unknown>)[reference.attribute] : link.value;
  if (typeof value !== "string" || cdk.SecretValue.isSecretValue(value)) {
    throw new Error(`${origin}: ${formatResourceReference(reference)} at ${link.scope.node.path} is not a public string attribute.`);
  }
  // Only a construct's own attribute names its producing stack. A string a
  // stack computed may hold a token from somewhere else entirely — a website
  // stack's CloudFront URL, say — and recording the linking stack as its
  // producer would invent an edge, and with it a cycle CloudFormation does not
  // have. CDK resolves that token to its real stack and adds the reference
  // itself, so there is nothing here to record.
  if (cdk.Token.isUnresolved(value) && link.value !== value) {
    noteEdge(scope, link, `${origin}: ${formatResourceReference(reference)}`);
  }
  return value;
}

function deploymentSecret(scope: IConstruct, reference: ResourceReference, required: boolean): SecretHandle | undefined {
  const state = registry(scope);
  const options = state.options;
  if (!options || !reference.fromEnv) throw new Error("Initialize framework resources before resolving a deployment secret.");
  const configured = !!options.readers?.env?.[reference.fromEnv]?.trim();
  const stack = cdk.Stack.of(scope);
  const key = `${stack.node.path}:${keyOf(reference)}`;
  let entry = state.parameters.get(key);
  if (!configured && !required && !entry) return undefined;
  if (!entry) {
    const parameter = new cdk.CfnParameter(stack, `FrameworkResourceArn${digest(keyOf(reference))}`, {
      type: "String", description: `Managed resource ARN for ${reference.path.join(".")}; supplied by npm run deploy.`,
      allowedPattern: "arn:[^:]+:secretsmanager:[^:]+:[0-9]{12}:secret:.+",
    });
    entry = { parameter, required };
    state.parameters.set(key, entry);
    parameter.node.addMetadata(SECRET_PARAMETER_METADATA, {
      version: 1, path: reference.path, variable: reference.fromEnv,
      name: frameworkSecretName(options.deployment, reference.fromEnv), deployment: options.deployment,
      mode: options.mode, account: stack.account, region: stack.region,
      parameter: stack.getLogicalId(parameter),
    });
  }
  entry.required ||= required;
  return { secretArn: entry.parameter.valueAsString };
}

/** Direct CDK consumers use the same generated ARN parameter as workload consumers. */
export function resolveDeploymentSecret(scope: IConstruct, reference: ResourceReference<"secret">, required = false): SecretHandle | undefined {
  return deploymentSecret(scope, reference, required);
}

/**
 * This lane's answer to `resolveCloudValues`, with its requirements checked.
 *
 * The policy is shared with the local runner; what differs is the lookup. Here
 * it is the link registry, and anything that resolves at all counts as
 * supplied — a CDK token included, because its value arrives at deploy time.
 * Asking is also what mints the ARN parameter for a required secret, so the
 * check and the wiring stay one pass.
 */
export function resourceValuesForTarget(scope: IConstruct, target: NormalizedTarget): ResourceResolver {
  const lookup = (reference: ResourceReference) =>
    resolveLinkedResource(scope, reference, target.reference, true);
  const required = new Set(
    assertRequirementsMet(
      target.cloud.requirements as readonly ResolvedCloudRequirement[],
      {
        select: (reference) => lookup(reference) as string | undefined,
        supplied: (reference) => lookup(reference) !== undefined,
      },
      `${target.reference}:`,
    ).map(keyOf),
  );
  return (reference, origin) =>
    resolveLinkedResource(scope, reference, origin, required.has(keyOf(reference)));
}

export function applyNativeGrant(scope: IConstruct, grantee: IGrantable, binding: NativeGrantBinding, origin: string): void {
  if (isResourceAbsent(binding.resource)) return;
  const link = registry(scope).links.get(keyOf(binding.resource));
  if (!link) throw new Error(`${origin}: resources.${binding.resource.path.join(".")} has no construct for ${binding.method}().`);
  const method = (link.value as Record<string, unknown>)[binding.method];
  if (typeof method !== "function") throw new Error(`${origin}: ${link.scope.node.path} has no ${binding.method}() grant.`);
  const grant = method.call(link.value, grantee, ...binding.arguments);
  if (grant?.success === false) throw new Error(`${origin}: ${binding.method}() failed at ${link.scope.node.path}.`);
  if (grant?.principalStatements?.some((statement: { resources: string[] }) => statement.resources.some(cdk.Token.isUnresolved))) {
    noteEdge(scope, link, `${origin}: resources.${binding.resource.path.join(".")}.${binding.method}()`);
  }
}

export function finalizeFrameworkResources(scope: IConstruct): void {
  const state = registry(scope);
  if (state.finalized) throw new Error("Framework resources were finalized twice.");
  if (!state.options) throw new Error("Initialize framework resources before finalizing them.");
  for (const action of state.pending) action();
  const { config, mode, deployment } = state.options;
  const stacks = scope.node.root.node.findAll().filter(cdk.Stack.isStack);
  if (mode === "dev") {
    const published = new Set<string>();
    for (const target of getFrameworkTargets(config)) {
      if (!isTargetEnabled(config, target.kind, target.id, "local")) continue;
      const references = [...Object.values(target.environment).filter(isResourceReference), ...Object.values(target.secrets).filter((ref) => !ref.fromEnv)];
      for (const reference of references) {
        if (isResourceAbsent(reference) || (reference.fromEnv && !reference.secretArn)) continue;
        const key = resourceAttributeKey(reference);
        if (published.has(key)) continue;
        const owner = state.links.get(keyOf(reference))?.scope ?? stacks[0];
        if (!owner) throw new Error(`No stack can publish ${formatResourceReference(reference)}.`);
        const needed = target.cloud.requirements.some(requirement => requirement.require.some(required => keyOf(required) === keyOf(reference)) && (!requirement.when || resolveLinkedResource(owner, requirement.when.resource, `local ${target.reference}`) === requirement.when.equals));
        const value = resolveLinkedResource(owner, reference, `local ${target.reference}`, needed);
        if (value === undefined) continue;
        new cdk.CfnOutput(cdk.Stack.of(owner), `FrameworkResource${digest(key)}`, {
          value: typeof value === "string" ? value : value.secretArn,
          description: `${RESOURCE_OUTPUT_PREFIX}${key}`,
        });
        published.add(key);
      }
    }
  }
  for (const stack of stacks) {
    new cdk.CfnOutput(stack, "FrameworkDeployment", {
      value: cdk.Stack.of(stack).toJsonString({ version: 1, deployment, mode, account: stack.account, region: stack.region }),
      description: DEPLOYMENT_OUTPUT_DESCRIPTION,
    });
  }
  const active = new Set<cdk.Stack>();
  const done = new Set<cdk.Stack>();
  const visit = (stack: cdk.Stack, trail: string[]): void => {
    if (active.has(stack)) throw new Error(`Resource dependency cycle: ${[...trail, stack.stackName].join(" -> ")}`);
    if (done.has(stack)) return;
    active.add(stack);
    for (const edge of state.edges.filter((edge) => edge.from === stack)) visit(edge.to, [...trail, `${stack.stackName} (${edge.origin})`]);
    for (const dependency of stack.dependencies) visit(dependency, [...trail, stack.stackName]);
    active.delete(stack); done.add(stack);
  };
  for (const stack of stacks) visit(stack, []);
  state.finalized = true;
}
