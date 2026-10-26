import { CLIENT_ENVIRONMENT_ID, publicInputName, clientReferenceId, type ClientEnvironmentBinding, type ClientEnvironmentMappings, type ClientReferenceOption } from "../shared/client-environment";
import type { ModeModel, ModelEdge } from "../shared/model";
import { deploymentInputPath } from "./deployment-inputs";
import { previewClientBinding } from "../shared/client-environment-preview";

/** Resolve references to current Studio identities, without reading client files or output values. */
export function withClientEnvironment(model: ModeModel, settings?: { mappings: ClientEnvironmentMappings; problem?: string }): ModeModel {
  const previous = model.resources.find((resource) => resource.id === CLIENT_ENVIRONMENT_ID)?.clientEnvironment;
  const { mappings, problem } = settings ?? { mappings: previous?.mappings ?? {}, problem: previous?.problem };
  const options: ClientReferenceOption[] = model.resources.filter((resource) => resource.kind === "input" && !resource.absent && resource.fromEnv && publicInputName(resource.fromEnv)).map((resource) => {
    const binding: ClientEnvironmentBinding = { kind: "input", name: resource.fromEnv! };
    return { id: clientReferenceId(binding), label: `${resource.path.join(".")} (${resource.fromEnv})`, group: "Input parameters", binding };
  });
  for (const stack of model.resources.filter((resource) => resource.kind === "stack" && resource.stackClass)) {
    const region: ClientEnvironmentBinding = { kind: "region", stack: stack.stackClass! };
    options.push({ id: clientReferenceId(region), label: `${stack.stackClass}.region`, group: "Stack regions", binding: region });
    for (const output of stack.stackOutputs ?? []) {
      const binding: ClientEnvironmentBinding = { kind: "output", stack: stack.stackClass!, outputs: [output.name] };
      options.push({ id: clientReferenceId(binding), label: `${stack.stackClass}.${output.name}`, group: "Stack outputs", binding });
    }
  }
  const entries = Object.entries(mappings).map(([name, mapping]) => previewClientBinding(name, mapping[model.mode], model));
  const edges: ModelEdge[] = entries.flatMap((entry) => entry.sources.flatMap((source, at) => source.entity ? [{
    id: `client-environment:${entry.name}:${source.entity}:${at}`, relation: "maps" as const,
    from: source.entity, to: CLIENT_ENVIRONMENT_ID, provenance: "derived" as const,
    label: entry.name, detail: `Maps ${entry.expression} into ${entry.name} in client-app/.env. ${entry.note} Environment export resolves its value.`, source: source.source,
  }] : []));
  return { ...model, resources: [...model.resources.filter((resource) => resource.id !== CLIENT_ENVIRONMENT_ID), {
    id: CLIENT_ENVIRONMENT_ID, kind: "envFile", path: ["client-app/.env"], absent: false,
    clientEnvironment: { path: "client-app/.env", mode: model.mode, inputs: deploymentInputPath(model.mode), entries, mappings, options, ...(problem ? { problem } : {}) },
  }], edges: [...model.edges.filter((edge) => !edge.id.startsWith("client-environment:")), ...edges] };
}
