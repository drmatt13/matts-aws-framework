import { CLIENT_ENVIRONMENT_FILES, CLIENT_ENVIRONMENT_ID, clientBindingFor, publicInputName, clientReferenceId, type ClientEnvironmentBinding, type ClientEnvironmentMappings, type ClientReferenceOption } from "../shared/client-environment";
import type { ModeModel, ModelEdge } from "../shared/model";
import { deploymentInputPath } from "./deployment-inputs";
import { previewClientBinding } from "../shared/client-environment-preview";

/** Resolve references to current Studio identities, without reading client files or output values. */
export function withClientEnvironment(model: ModeModel, settings?: { mappings: ClientEnvironmentMappings; problem?: string }): ModeModel {
  const previous = model.resources.find((resource) => resource.id === CLIENT_ENVIRONMENT_ID)?.clientEnvironment;
  const { mappings, problem } = settings ?? { mappings: previous?.mappings ?? {}, problem: previous?.problem };
  // An input declared `.only()` the other graph is still offered: one recipe serves both graphs.
  const options: ClientReferenceOption[] = model.resources.filter((resource) => resource.kind === "input" && resource.fromEnv && publicInputName(resource.fromEnv)).map((resource) => {
    const binding: ClientEnvironmentBinding = { kind: "input", name: resource.fromEnv! };
    return { id: clientReferenceId(binding), label: `${resource.path.join(".")} (${resource.fromEnv})${resource.absent ? ` · ${model.mode === "dev" ? "production" : "development"} only` : ""}`, group: "Input parameters", binding };
  });
  for (const stack of model.resources.filter((resource) => resource.kind === "stack" && resource.stackClass)) {
    const region: ClientEnvironmentBinding = { kind: "region", stack: stack.stackClass! };
    options.push({ id: clientReferenceId(region), label: `${stack.stackClass}.region`, group: "Stack regions", binding: region });
    for (const output of stack.stackOutputs ?? []) {
      const binding: ClientEnvironmentBinding = { kind: "output", stack: stack.stackClass!, outputs: [output.name] };
      options.push({ id: clientReferenceId(binding), label: `${stack.stackClass}.${output.name}`, group: "Stack outputs", binding });
    }
  }
  const entries = Object.entries(mappings).map(([name, mapping]) => previewClientBinding(name, clientBindingFor(mapping, model.mode), model));
  const file = CLIENT_ENVIRONMENT_FILES[model.mode];
  const edges: ModelEdge[] = entries.flatMap((entry) => entry.sources.flatMap((source, at) => source.entity ? [{
    id: `client-environment:${entry.name}:${source.entity}:${at}`, relation: "maps" as const,
    from: source.entity, to: CLIENT_ENVIRONMENT_ID, provenance: "derived" as const,
    // One connection in both graphs: its detail must not depend on which graph built it.
    label: entry.name, detail: `Maps ${entry.expression} into ${entry.name} in the client environment. Environment export resolves its value.`, source: source.source,
  }] : []));
  return { ...model, resources: [...model.resources.filter((resource) => resource.id !== CLIENT_ENVIRONMENT_ID), {
    id: CLIENT_ENVIRONMENT_ID, kind: "envFile", path: ["Client environment"], absent: false,
    clientEnvironment: { path: file, mode: model.mode, inputs: deploymentInputPath(model.mode), entries, mappings, options, ...(problem ? { problem } : {}) },
  }], edges: [...model.edges.filter((edge) => !edge.id.startsWith("client-environment:")), ...edges] };
}
