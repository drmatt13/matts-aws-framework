import { clientBindingFor, clientMappingsError, publicInputName, type ClientEnvironmentMappings } from "./client-environment-mapping";
import { ROOT_ENV_STACK_OUTPUTS } from "./root-env-outputs";
import { resolveInput, isResourceValueReference, type InputResolution, type ResourceReference } from "@repo/framework/config";
import { collectDeploymentStacks, type DeploymentStack } from "./resource-export";

/**
 * Resolve reviewed client references from one deployment, before any file write.
 *
 * An input is read through the framework's own resolver, from the catalog declarations the
 * deployed graph was built from, the deployed graph's inputs file, and the project's CDK
 * context — the sources synthesis read. An input outside this graph, or an optional one with
 * no value and no default, leaves its field blank; a required one with neither stops the export.
 */
export function resolveClientEnvironmentMappings(mappings: ClientEnvironmentMappings, context: {
  readonly deployment: string;
  readonly stacks: readonly DeploymentStack[];
  /** The deployed graph's inputs file, parsed. */
  readonly inputs: Readonly<Record<string, string | undefined>>;
  /** The catalog, resolved for the deployed graph. */
  readonly declarations: readonly ResourceReference[];
  /** Persistent CDK context, which overrides an input as it did during synthesis. */
  readonly getContext?: (key: string) => unknown;
}): Record<string, string> {
  const error = clientMappingsError(mappings);
  if (error) throw new Error(error);
  const { identity, stacks } = collectDeploymentStacks(context.stacks, context.deployment);
  if (context.inputs.PROD_DEPLOYMENT !== undefined && context.inputs.PROD_DEPLOYMENT !== String(identity.mode === "prod")) {
    throw new Error(`Client inputs must match the ${identity.mode === "prod" ? "production" : "development"} deployment. Existing local files were preserved.`);
  }
  const fail = (name: string, reason: string): never => { throw new Error(`${name}: ${reason} Existing local files were preserved.`); };
  const declared = new Map(context.declarations.filter((reference) => !reference.secretArn && (reference.fromEnv || isResourceValueReference(reference) || Object.values(reference.modes ?? {}).some(policy => policy.value !== undefined)))
    .flatMap((reference): [string, ResourceReference][] => [
      [`resource:${reference.path.join(".")}`, reference], ...(reference.fromEnv ? [[reference.fromEnv, reference] as [string, ResourceReference]] : []),
    ]));
  const input = (name: string, field: string): InputResolution => {
    const reference = declared.get(name);
    if (!publicInputName(name) || reference?.kind === "secret" || (reference?.fromEnv && !publicInputName(reference.fromEnv))) return fail(field, "Secret inputs cannot be exported to the browser.");
    if (!reference) return fail(field, `Declare ${name} as a public input parameter.`);
    const resolved = resolveInput(reference, { env: context.inputs, getContext: context.getContext });
    if (resolved.state === "invalid") fail(field, `The ${name} input parameter does not match its declared choices.`);
    return resolved;
  };
  const valueOf = (resolved: InputResolution) => resolved.state === "supplied" || resolved.state === "fallback" ? resolved.value : undefined;
  /** A field whose input supplies nothing: blank unless the input is required here. */
  const unsupplied = (resolved: InputResolution, name: string, field: string) =>
    resolved.state === "missing" ? fail(field, `Set ${name} in cdk-app/.env.${identity.mode} or supply a declaration default.`) : "";
  const result: Record<string, string> = {};
  const publicOutputs: Readonly<Record<string, Readonly<Record<string, string>>>> = ROOT_ENV_STACK_OUTPUTS;
  for (const [name, mapping] of Object.entries(mappings)) {
    const binding = clientBindingFor(mapping, identity.mode);
    if (binding.when) {
      const selector = input(binding.when.input, name);
      if (selector.state === "not-applicable") { result[name] = ""; continue; }
      const selected = valueOf(selector);
      if (selected === undefined) fail(name, `Set the ${binding.when.input} input parameter or supply a declaration default.`);
      if (selected !== binding.when.equals) { result[name] = ""; continue; }
    }
    let value: string;
    if (binding.kind === "empty") value = "";
    else if (binding.kind === "input") {
      const resolved = input(binding.name, name);
      value = valueOf(resolved) ?? unsupplied(resolved, binding.name, name);
    } else if (binding.kind === "endpoint") {
      const override = binding.override ? valueOf(input(binding.override, name)) : undefined;
      const port = input(binding.port, name);
      if (override !== undefined) {
        value = override;
        validateUrl(name, value, binding.protocol.startsWith("ws") ? ["ws:", "wss:"] : ["http:", "https:"], fail);
      } else if (valueOf(port) === undefined) value = unsupplied(port, binding.port, name);
      else {
        const supplied = valueOf(port)!;
        if (!/^[1-9][0-9]*$/.test(supplied) || Number(supplied) > 65535) fail(name, `${binding.port} must supply a port between 1 and 65535.`);
        value = `${binding.protocol}://${binding.host ?? "localhost"}:${supplied}`;
        validateUrl(name, value, [binding.protocol + ":"], fail);
      }
    } else {
      const allowed = Object.hasOwn(publicOutputs, binding.stack) ? publicOutputs[binding.stack] : undefined;
      if (binding.kind === "output" && binding.outputs.some((output) => !Object.hasOwn(allowed ?? {}, output))) fail(name, "Choose a public stack output offered by Studio.");
      const matching = stacks.filter((stack) => stack.StackName === `${identity.deployment}-${binding.stack}`);
      if (matching.length > 1) fail(name, `Duplicate deployed stack ${binding.stack}.`);
      const stack = matching[0];
      if (!stack) {
        if (binding.kind === "output" && binding.optional) value = "";
        else return fail(name, `${binding.stack} is absent from this deployment.`);
      } else if (binding.kind === "region") value = identity.region;
      else {
        value = binding.outputs.map((key) => stack.Outputs?.find((output) => output.OutputKey === key)?.OutputValue).find((value) => !!value?.trim()) ?? "";
        if (!value) fail(name, `${binding.stack} has no value for ${binding.outputs.join(" or ")}.`);
      }
    }
    if (value) {
      const protocols: Readonly<Record<string, readonly string[]>> = {
        VITE_API_GATEWAY_URL: ["http:", "https:"], VITE_LOCAL_WS_URL: ["ws:", "wss:"],
        VITE_API_GATEWAY_WS_URL: ["ws:", "wss:"], VITE_WS_TESTER_URL: ["http:", "https:"], VITE_COGNITO_DOMAIN: ["https:"],
      };
      if (protocols[name]) {
        const url = validateUrl(name, value, protocols[name]!, fail);
        if (name === "VITE_COGNITO_DOMAIN") {
          if (url.search || url.hash || url.pathname !== "/") fail(name, "The Cognito domain must be an HTTPS origin.");
          value = url.origin;
        }
      }
    }
    result[name] = value;
  }
  return result;
}

function validateUrl(name: string, value: string, protocols: readonly string[], fail: (name: string, reason: string) => never): URL {
  let parsed: URL;
  try { parsed = new URL(value); } catch { return fail(name, "The selected source must supply a valid URL."); }
  if (!protocols.includes(parsed.protocol) || parsed.username || parsed.password) fail(name, `The URL must use ${protocols.join(" or ")} without embedded credentials.`);
  return parsed;
}
