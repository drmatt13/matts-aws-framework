import type { ModeModel } from "../shared/model";
import { remapEntity } from "../shared/naming";
import { isSplitMapping, type ClientEnvironmentBinding, type ClientEnvironmentMappings } from "../shared/client-environment";

/** Compare normalized declaration semantics, mapping only known resource identities.
 * Input values, notes, environment names, ARN templates and other authored strings
 * are never searched/replaced. Source evidence and presentation prose are omitted.
 * Map the pre-rename model forward, then compare it to the unchanged candidate.
 */
export function renameEquivalenceSignature(model: ModeModel, remap: Readonly<Record<string, string>> = {}, options: { readonly reparent?: boolean } = {}): string {
  const entity = (id: string) => remapEntity(id, remap);
  const groups = new Set(model.resources.filter(resource => resource.kind === "group").map(resource => resource.id));
  const catalogPath = (segments: readonly string[]) => {
    const before = `resource:${segments.join(".")}`, mapped = entity(before);
    return mapped === before ? segments : mapped.slice("resource:".length).split(".");
  };
  const display = (value: string, resource: string) => {
    const before = `resources.${resource.slice("resource:".length)}`;
    return value === before || value.startsWith(`${before}.`)
      ? `resources.${entity(resource).slice("resource:".length)}${value.slice(before.length)}` : value;
  };
  // Workflow serialization has two explicit resource markers. Plain strings
  // inside the IR remain application data, including strings equal to old IDs.
  const workflowValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(workflowValue);
    if (!value || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    if (object.$resource === "@repo/framework/resource" && Array.isArray(object.path) && object.path.every(part => typeof part === "string")) {
      return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, key === "path" ? catalogPath(object.path as string[]) : workflowValue(child)]));
    }
    if (Object.keys(object).length === 1 && typeof object.$resource === "string") {
      return { $resource: catalogPath(object.$resource.split(".")).join(".") };
    }
    return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, workflowValue(child)]));
  };
  const binding = (value: ClientEnvironmentBinding): ClientEnvironmentBinding => ({ ...value,
    ...(value.kind === "input" ? { name: entity(value.name) } : {}),
    ...(value.kind === "endpoint" ? { port: entity(value.port), ...(value.override ? { override: entity(value.override) } : {}) } : {}),
    ...(value.when ? { when: { ...value.when, input: entity(value.when.input) } } : {}),
  });
  const mappings = (values: ClientEnvironmentMappings) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key,
    isSplitMapping(value) ? { dev: binding(value.dev), prod: binding(value.prod) } : binding(value),
  ]));
  const lanes = (value: ModeModel["targets"][number]["lanes"]) => ({ ...value,
    ...(value.when ? { when: { ...value.when, resource: entity(value.when.resource) } } : {}),
  });
  const order = <Value>(values: readonly Value[]) => [...values].sort((a, b) => JSON.stringify(canonical(a)).localeCompare(JSON.stringify(canonical(b))));
  const signature = {
    mode: model.mode,
    targets: order(model.targets.map(target => ({
      ref: target.ref, id: target.id, kind: target.kind, role: target.role, section: target.section,
      directory: target.directory, constructId: target.constructId, constructIdPinned: target.constructIdPinned,
      lanes: lanes(target.lanes), compute: target.compute, placement: target.placement,
      auth: target.auth, userPool: target.userPool,
      environment: order(target.environment.map(entry => ({ ...entry, value: entry.value.kind === "reference"
        ? { ...entry.value, resource: entity(entry.value.resource), display: display(entry.value.display, entry.value.resource) } : entry.value }))),
      secrets: order(target.secrets.map(secret => ({ ...secret, resource: entity(secret.resource), display: display(secret.display, secret.resource) }))),
      // Access resources are authored ARN templates, not catalog IDs.
      access: target.access, requirements: target.requirements,
      requirementRules: target.requirementRules?.map(rule => ({ ...rule, require: rule.require.map(entity),
        ...(rule.when ? { when: { ...rule.when, resource: entity(rule.when.resource) } } : {}) })),
      outputs: target.outputs,
      permissionSources: target.permissionSources?.map(source => ({ ...source, peer: entity(source.peer) })),
    }))),
    routes: order(model.routes.map(({ origin: _origin, ...route }) => route)),
    resources: order(model.resources.filter(resource => !options.reparent || resource.kind !== "group").map(resource => ({
      id: entity(resource.id), path: catalogPath(resource.path), kind: resource.kind,
      parent: options.reparent && ["input", "secret"].includes(resource.kind)
        ? catalogPath(resource.path).length > 1 ? `resource:${catalogPath(resource.path).slice(0, -1).join(".")}` : undefined
        : resource.parent ? entity(resource.parent) : undefined,
      absent: resource.absent,
      fromEnv: resource.fromEnv, bindingPath: resource.bindingPath,
      authoredValue: resource.authoredValue, default: resource.default, required: resource.required,
      modes: resource.modes, values: resource.values, note: resource.note,
      stackClass: resource.stackClass, frameworkManaged: resource.frameworkManaged,
      networkPlacement: resource.networkPlacement, networkId: resource.networkId,
      clientMappings: resource.clientEnvironment ? mappings(resource.clientEnvironment.mappings) : undefined,
    }))),
    edges: order(model.edges.filter(edge => edge.provenance !== "source" && !(options.reparent && edge.provenance === "derived" && edge.relation === "contains" && groups.has(edge.from))).map(edge => ({
      relation: edge.relation, from: entity(edge.from), to: entity(edge.to), provenance: edge.provenance,
      label: edge.label, attachment: edge.attachment ? entity(edge.attachment) : undefined,
      permissionContext: edge.permissionContext,
    }))),
    workflows: order(model.workflows.map(workflow => ({ ...workflow,
      integrations: workflow.integrations.map(integration => ({ ...integration, ...(integration.resource ? { resource: entity(integration.resource) } : {}) })),
      root: workflowValue(workflow.root),
    }))),
    tagging: Object.fromEntries(Object.entries(model.tagging ?? {}).filter(([id, facts]) => !options.reparent || !groups.has(id) || facts.aws.kind !== "logical" || Object.keys(facts.authored).length > 0 || Object.keys(facts.effective).length > 0).map(([id, facts]) => [entity(id), {
      authored: facts.authored, effective: facts.effective, awsKind: facts.aws.kind,
      inherited: facts.inherited ? { ...facts.inherited, entity: entity(facts.inherited.entity) } : undefined,
      provenance: Object.fromEntries(Object.entries(facts.provenance).map(([key, origin]) => [key, { ...origin, entity: entity(origin.entity) }])),
    }])),
    networks: model.networks, databaseNetworkId: model.databaseNetworkId,
    managedDatabase: model.managedDatabase ? { ...model.managedDatabase, resource: entity(model.managedDatabase.resource) } : undefined,
    gateways: model.gateways?.map(({ title: _title, ...gateway }) => ({ ...gateway, lanes: lanes(gateway.lanes), stackResource: entity(gateway.stackResource) })),
    triggers: model.triggers?.map(trigger => ({ ...trigger, resource: entity(trigger.resource), options: workflowValue(trigger.options) })),
    failureDestinations: model.failureDestinations?.map(destination => ({ ...destination, destination: entity(destination.destination) })),
    localServices: model.localServices?.map(({ source: _source, title: _title, ...service }) => service),
    defaults: model.defaults?.map(({ title: _title, origin: _origin, ...value }) => value),
    fields: Object.fromEntries(Object.entries(model.fields).map(([id, facts]) => [id, facts.map(fact => ({
      field: fact.field, path: fact.path, effective: fact.effective, authored: fact.authored,
      inherited: fact.inherited,
    }))])),
  };
  return JSON.stringify(canonical(signature));
}

/** Map order and source formatting do not carry declaration semantics. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}
