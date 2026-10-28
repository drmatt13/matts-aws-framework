import type { ClientEnvironmentBinding, ClientEnvironmentEntry, ClientEnvironmentSource } from "./client-environment";
import type { ModeModel } from "./model";

/**
 * Symbolic previews for both saved and draft mappings. Never reads values or contacts AWS.
 *
 * Whether a field is generated is inferred, the same way the export decides it: an input outside
 * this graph leaves the field blank, as does an optional input with no value and no default. A
 * required one without either needs attention.
 */
export function previewClientBinding(name: string, binding: ClientEnvironmentBinding, model: ModeModel): ClientEnvironmentEntry {
  const inputs = `cdk-app/.env.${model.mode}`;
  const graph = model.mode === "dev" ? "development" : "production";
  const inputSource = (name: string) => {
    const catalog = model.resources.find((resource) => resource.fromEnv === name && resource.kind === "input");
    const entry = catalog?.inputSources?.find((source) => source.file === inputs)?.entry;
    // The server resolved each input with the framework's resolver; the preview only reads the state.
    const state = catalog?.inputState ?? (catalog?.absent ? "not-applicable" : catalog?.default !== undefined ? "fallback" : catalog?.required ? "missing" : "unresolved");
    const absent = state === "not-applicable";
    const supplied = !!catalog && (state === "supplied" || state === "fallback");
    const required = !!catalog && state === "missing";
    const source: ClientEnvironmentSource = { entity: catalog?.id, label: catalog ? `${catalog.path.join(".")} · ${name}` : `${name} (undeclared input parameter)`, available: supplied, source: entry?.source };
    return { source, catalog, state, absent, supplied, required };
  };
  /** Why an input leaves the field blank here, or what it needs. */
  const unsupplied = (input: ReturnType<typeof inputSource>, label: string, expression: string): ClientEnvironmentEntry =>
    !input.catalog ? { name, expression, required: true, status: "unavailable", sources: [input.source], note: `Declare ${label} as a public input parameter.` }
    : input.state === "invalid" ? { name, expression, required: true, status: "unavailable", sources: [input.source], note: `${label} in ${inputs} is not one of its declared choices.` }
    // An input this graph does not hold connects nothing here; the other graph still shows the link.
    : input.absent ? { name, expression, required: false, status: "empty", sources: [], note: `${label} is not declared in ${graph}, so this field is blank there.` }
    : input.required ? { name, expression, required: true, status: "unavailable", sources: [input.source], note: `Set ${label} in ${inputs}. It is required in ${graph}.` }
    : { name, expression, required: false, status: "empty", sources: [input.source], note: `Blank until ${label} is set in ${inputs} or given a default.` };
  if (binding.when) {
    const { when, ...value } = binding;
    const condition = inputSource(when.input);
    if (condition.absent) return { ...unsupplied(condition, when.input, previewClientBinding(name, value, model).expression) };
    const outcome = condition.catalog?.inputComparisons?.[when.equals];
    const preview = previewClientBinding(name, value, model);
    if (preview.status === "empty" && !preview.sources.length) return preview;
    if (outcome !== "holds") return { name, expression: preview.expression, required: outcome !== "fails", status: outcome === "fails" ? "empty" : "unavailable", sources: [condition.source],
      note: outcome === "fails" ? `Blank because ${when.input} does not match ${JSON.stringify(when.equals)} in ${graph}.` : `The ${when.input} input condition needs evaluation. Review the input parameter and mapping.` };
    return { ...preview, sources: [condition.source, ...preview.sources], note: preview.status === "mapped" ? `${preview.note} Only while ${when.input} is ${JSON.stringify(when.equals)}.` : preview.note };
  }
  if (binding.kind === "empty") return { name, expression: '""', required: false, status: "empty", sources: [], note: `Written blank in ${graph}.` };
  if (binding.kind === "input") {
    if (!binding.name) return { name, expression: "Choose an input", required: true, status: "unavailable", sources: [], note: `Choose a public CDK input from ${inputs}.` };
    const input = inputSource(binding.name);
    const expression = `\${${binding.name}}`;
    return input.supplied ? { name, expression, required: true, status: "mapped", sources: [input.source], note: `Read ${binding.name} through its input parameter in ${graph}.` }
      : unsupplied(input, binding.name, expression);
  }
  if (binding.kind === "endpoint") {
    if (!binding.port) return { name, expression: "Choose a port input", required: true, status: "unavailable", sources: [], note: "Choose the CDK input that supplies this URL's port." };
    const port = inputSource(binding.port);
    const override = binding.override ? inputSource(binding.override) : undefined;
    const url = `${binding.protocol}://${binding.host ?? "localhost"}:\${${binding.port}}`;
    const expression = binding.override ? `\${${binding.override}} or ${url}` : url;
    if (override?.supplied) return { name, expression, required: true, status: "mapped", sources: [override.source], note: `Use ${binding.override} in ${graph}.` };
    return port.supplied ? { name, expression, required: true, status: "mapped", sources: [port.source], note: binding.override ? `Built from ${binding.port} unless ${binding.override} is set.` : `Built from ${binding.port} in ${graph}.` }
      : unsupplied(port, binding.port, expression);
  }
  const stack = model.resources.find((resource) => resource.kind === "stack" && resource.stackClass === binding.stack);
  if (!binding.stack) return { name, expression: "Choose a stack", required: true, status: "unavailable", sources: [], note: "Choose the stack that supplies this field." };
  if (binding.kind === "region") return { name, expression: `${binding.stack}.region`, required: true,
    status: stack && !stack.absent ? "mapped" : "unavailable",
    sources: [{ entity: stack?.id, label: `${binding.stack} · deployment region`, available: !!stack && !stack.absent }],
    note: stack && !stack.absent ? "Use this stack's deployment region, which can differ from LOCAL_AWS_REGION." : `${binding.stack} is not present in this environment.` };
  const output = binding.outputs.map((name) => stack?.stackOutputs?.find((output) => output.name === name)).find(Boolean);
  if (!binding.outputs.length) return { name, expression: `${binding.stack} · choose an output`, required: true, status: "unavailable", sources: [], note: "Choose a public output from this stack." };
  const available = !!stack && !stack.absent && !!output;
  const empty = !!binding.optional && stack?.absent === true;
  return { name, expression: `${binding.stack}.${output?.name ?? binding.outputs.join(" or ")}${binding.optional ? ' or ""' : ""}`,
    required: !empty, status: available ? "mapped" : empty ? "empty" : "unavailable",
    sources: [{ entity: stack?.id, label: `${binding.stack} · ${output?.name ?? binding.outputs.join(" or ")}`, available, source: output?.source }],
    note: available ? "Public stack output reference. Its deployed value has not been checked." : empty ? "This stack is off in this environment, so the value is empty."
      : !stack || stack.absent ? `${binding.stack} is not present in this environment.` : `No matching public output in ${binding.stack}. Select an available output.` };
}
