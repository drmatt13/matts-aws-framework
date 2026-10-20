import type { ClientEnvironmentBinding, ClientEnvironmentEntry, ClientEnvironmentSource } from "./client-environment";
import type { ModeModel } from "./model";

/** Symbolic previews for both saved and draft mappings. Never reads values or contacts AWS. */
export function previewClientBinding(name: string, binding: ClientEnvironmentBinding, model: ModeModel): ClientEnvironmentEntry {
  const file = model.resources.find((resource) => resource.deploymentFile?.mode === model.mode);
  const inputs = file?.deploymentFile?.path ?? `cdk-app/.env.${model.mode}`;
  const inputSource = (name: string): ClientEnvironmentSource => {
    const entry = file?.deploymentFile?.entries.find((entry) => entry.name === name);
    const catalog = model.resources.find((resource) => resource.fromEnv === name && resource.kind === "input" && !resource.absent);
    return { entity: catalog?.id ?? file?.id, label: `${inputs} · ${name}`,
      available: !!entry && (entry.status === "configured" || entry.defaulted), source: entry?.source };
  };
  if (binding.enabled === false) return { name, expression: "Disabled", required: false, status: "disabled", sources: [], note: "This field is omitted in this environment; its source is retained." };
  if (binding.kind === "empty") return { name, expression: '""', required: false, status: "empty", sources: [], note: "Write an empty value in this environment. Disable the field to omit it instead." };
  if (binding.kind === "input") {
    const source = inputSource(binding.name);
    return { name, expression: `\${${binding.name}}`, required: true, status: source.available ? "mapped" : "unavailable", sources: [source],
      note: source.available ? `Read ${binding.name} from ${inputs}, or its declared default.` : `Set ${binding.name} in ${inputs}, or supply a declaration default.` };
  }
  if (binding.kind === "endpoint") {
    const port = inputSource(binding.port);
    const override = binding.override ? inputSource(binding.override) : undefined;
    const expression = `${binding.protocol}://${binding.host ?? "localhost"}:\${${binding.port}}`;
    const available = !!override?.available || port.available;
    return { name, expression: binding.override ? `\${${binding.override}} or ${expression}` : expression,
      required: true, status: available ? "mapped" : "unavailable", sources: override?.available ? [override] : [port],
      note: available ? (binding.override ? "Use the URL override when set; otherwise build the URL from the port." : `Build the URL from a port in ${inputs}.`)
        : `Set ${binding.port}${binding.override ? ` or ${binding.override}` : ""} in ${inputs}.` };
  }
  const stack = model.resources.find((resource) => resource.kind === "stack" && resource.stackClass === binding.stack);
  if (binding.kind === "region") return { name, expression: `${binding.stack}.region`, required: true,
    status: stack && !stack.absent ? "mapped" : "unavailable",
    sources: [{ entity: stack?.id, label: `${binding.stack} · deployment region`, available: !!stack && !stack.absent }],
    note: stack && !stack.absent ? "Use this stack's deployment region, which can differ from LOCAL_AWS_REGION." : `${binding.stack} is not present in this environment.` };
  const output = binding.outputs.map((name) => stack?.stackOutputs?.find((output) => output.name === name)).find(Boolean);
  const available = !!stack && !stack.absent && !!output;
  const empty = !!binding.optional && stack?.absent === true;
  return { name, expression: `${binding.stack}.${output?.name ?? binding.outputs.join(" or ")}${binding.optional ? ' or ""' : ""}`,
    required: !empty, status: available ? "mapped" : empty ? "empty" : "unavailable",
    sources: [{ entity: stack?.id, label: `${binding.stack} · ${output?.name ?? binding.outputs.join(" or ")}`, available, source: output?.source }],
    note: available ? "Public stack output reference. Its deployed value has not been checked." : empty ? "This stack is off in this environment, so the value is empty."
      : !stack || stack.absent ? `${binding.stack} is not present in this environment.` : `No matching public output in ${binding.stack}. Select an available output.` };
}
