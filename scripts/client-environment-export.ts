import { clientMappingsError, publicInputName, type ClientEnvironmentMappings } from "./client-environment-mapping";
import { ROOT_ENV_STACK_OUTPUTS } from "./root-env-outputs";
import { collectDeploymentStacks, type DeploymentStack } from "./resource-export";

/** Resolve reviewed client references from one deployment and its authored inputs, before any file write. */
export function resolveClientEnvironmentMappings(mappings: ClientEnvironmentMappings, context: {
  readonly deployment: string;
  readonly stacks: readonly DeploymentStack[];
  readonly inputs: Readonly<Record<string, string | undefined>>;
  readonly defaults?: Readonly<Record<string, string | undefined>>;
  readonly sensitiveInputs?: ReadonlySet<string>;
}): Record<string, string> {
  const error = clientMappingsError(mappings);
  if (error) throw new Error(error);
  const { identity, stacks } = collectDeploymentStacks(context.stacks, context.deployment);
  if (context.inputs.PROD_DEPLOYMENT !== undefined && context.inputs.PROD_DEPLOYMENT !== String(identity.mode === "prod")) {
    throw new Error(`Client inputs must match the ${identity.mode === "prod" ? "production" : "development"} deployment. Existing local files were preserved.`);
  }
  const fail = (name: string, reason: string): never => { throw new Error(`${name}: ${reason} Existing local files were preserved.`); };
  const input = (name: string, field: string) => {
    if (!publicInputName(name) || context.sensitiveInputs?.has(name)) fail(field, "Secret inputs cannot be exported to the browser.");
    const authored = Object.hasOwn(context.inputs, name) ? context.inputs[name] : undefined;
    return authored?.trim() ? authored : Object.hasOwn(context.defaults ?? {}, name) ? context.defaults![name] ?? "" : "";
  };
  const result: Record<string, string> = {};
  const publicOutputs: Readonly<Record<string, Readonly<Record<string, string>>>> = ROOT_ENV_STACK_OUTPUTS;
  for (const [name, modes] of Object.entries(mappings)) {
    const binding = modes[identity.mode];
    if (binding.enabled === false) continue;
    let value: string;
    if (binding.kind === "empty") value = "";
    else if (binding.kind === "input") {
      value = input(binding.name, name);
      if (!value.trim()) fail(name, `Set ${binding.name} in cdk-app/.env.${identity.mode} or supply a declaration default.`);
    } else if (binding.kind === "endpoint") {
      const override = binding.override ? input(binding.override, name) : "";
      if (override.trim()) {
        value = override;
        validateUrl(name, value, binding.protocol.startsWith("ws") ? ["ws:", "wss:"] : ["http:", "https:"], fail);
      } else {
        const port = input(binding.port, name);
        if (!/^[1-9][0-9]*$/.test(port) || Number(port) > 65535) fail(name, `${binding.port} must supply a port between 1 and 65535.`);
        value = `${binding.protocol}://${binding.host ?? "localhost"}:${port}`;
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
