import { CLIENT_ENVIRONMENT_ID, publicInputName, clientReferenceId, type ClientEnvironmentBinding, type ClientEnvironmentMappings, type ClientEnvironmentEntry, type ClientEnvironmentSource, type ClientReferenceOption } from "../shared/client-environment";
import type { ModeModel, ModelEdge } from "../shared/model";
import { deploymentInputPath } from "./deployment-inputs";

/** Resolve references to current Studio identities, without reading client files or output values. */
export function withClientEnvironment(model: ModeModel, settings?: { mappings: ClientEnvironmentMappings; problem?: string }): ModeModel {
  const previous = model.resources.find((resource) => resource.id === CLIENT_ENVIRONMENT_ID)?.clientEnvironment;
  const { mappings, problem } = settings ?? { mappings: previous?.mappings ?? {}, problem: previous?.problem };
  const file = model.resources.find((resource) => resource.deploymentFile?.mode === model.mode);
  const inputSource = (name: string): ClientEnvironmentSource => {
    const entry = file?.deploymentFile?.entries.find((entry) => entry.name === name);
    const catalog = model.resources.find((resource) => resource.fromEnv === name && resource.kind === "input" && !resource.absent);
    return { entity: catalog?.id ?? file?.id, label: `${deploymentInputPath(model.mode)} · ${name}`,
      available: !!entry && (entry.status === "configured" || entry.defaulted), source: entry?.source };
  };
  const options: ClientReferenceOption[] = (file?.deploymentFile?.entries ?? []).filter((entry) => !entry.sensitive && publicInputName(entry.name)).map((entry) => {
    const binding: ClientEnvironmentBinding = { kind: "input", name: entry.name };
    return { id: clientReferenceId(binding), label: entry.name, group: "CDK inputs", binding };
  });
  for (const stack of model.resources.filter((resource) => resource.kind === "stack" && resource.stackClass)) {
    const region: ClientEnvironmentBinding = { kind: "region", stack: stack.stackClass! };
    options.push({ id: clientReferenceId(region), label: `${stack.stackClass}.region`, group: "Stack regions", binding: region });
    for (const output of stack.stackOutputs ?? []) {
      const binding: ClientEnvironmentBinding = { kind: "output", stack: stack.stackClass!, outputs: [output.name] };
      options.push({ id: clientReferenceId(binding), label: `${stack.stackClass}.${output.name}`, group: "Stack outputs", binding });
    }
  }
  const entries = Object.entries(mappings).map(([name, mapping]): ClientEnvironmentEntry => {
    const binding: ClientEnvironmentBinding = mapping[model.mode];
    if (binding.enabled === false) return { name, expression: "Disabled", required: false, status: "disabled", sources: [], note: "" };
    if (binding.kind === "empty") return { name, expression: '""', required: false, status: "empty", sources: [], note: "Empty in production: this local tool does not run there." };
    if (binding.kind === "input") {
      const source = inputSource(binding.name);
      return { name, expression: `\${${binding.name}}`, required: true, status: source.available ? "mapped" : "unavailable", sources: [source], note: "" };
    }
    if (binding.kind === "endpoint") {
      const port = inputSource(binding.port);
      const override = binding.override ? inputSource(binding.override) : undefined;
      const expression = `${binding.protocol}://${binding.host ?? "localhost"}:\${${binding.port}}`;
      return { name, expression: binding.override ? `\${${binding.override}} or ${expression}` : expression,
        required: true, status: (override?.available || port.available) ? "mapped" : "unavailable",
        sources: override?.available ? [override] : [port],
        note: binding.override ? "Use the authored API URL override when present; otherwise build the Vite proxy target from the local API port. Browser requests stay on /api." : "Build the local endpoint from the selected CDK input file's host port." };
    }
    const stack = model.resources.find((resource) => resource.kind === "stack" && resource.stackClass === binding.stack);
    if (binding.kind === "region") return { name, expression: `${binding.stack}.region`, required: true,
      status: stack && !stack.absent ? "mapped" : "unavailable",
      sources: [{ entity: stack?.id, label: `${binding.stack} · deployment region`, available: !!stack && !stack.absent }],
      note: "Use the Cognito deployment's region, which can differ from LOCAL_AWS_REGION. Resolved from deployment metadata later." };
    const output = binding.outputs.map((name) => stack?.stackOutputs?.find((output) => output.name === name)).find(Boolean);
    const available = !!stack && !stack.absent && !!output;
    const optional = !!binding.optional;
    const disabled = stack?.absent === true;
    return { name, expression: `${binding.stack}.${output?.name ?? binding.outputs.join(" or ")}${optional ? ' or ""' : ""}`,
      required: !optional || !disabled, status: available ? "mapped" : optional && disabled ? "empty" : "unavailable",
      sources: [{ entity: stack?.id, label: `${binding.stack} · ${output?.name ?? binding.outputs.join(" or ")}`, available, source: output?.source }],
      note: optional ? "Use the deployed WebSocket stage when this graph builds its API; otherwise leave empty. Local WebSocket runs independently." : "Reference the public CloudFormation output. The mapping does not query AWS or resolve its value." };
  });
  const edges: ModelEdge[] = entries.flatMap((entry) => entry.sources.flatMap((source, at) => source.entity ? [{
    id: `client-environment:${entry.name}:${source.entity}:${at}`, relation: "maps" as const,
    from: CLIENT_ENVIRONMENT_ID, to: source.entity, provenance: "derived" as const,
    label: entry.name, detail: `${entry.expression}. ${entry.note}`, source: source.source,
  }] : []));
  return { ...model, resources: [...model.resources.filter((resource) => resource.id !== CLIENT_ENVIRONMENT_ID), {
    id: CLIENT_ENVIRONMENT_ID, kind: "envFile", path: ["client-app/.env"], absent: false,
    clientEnvironment: { path: "client-app/.env", mode: model.mode, inputs: deploymentInputPath(model.mode), entries, mappings, options, ...(problem ? { problem } : {}) },
  }], edges: [...model.edges.filter((edge) => !edge.id.startsWith("client-environment:")), ...edges] };
}
