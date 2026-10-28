import type { Mode, ModelEdge, Relation } from "../shared/model";
import { nativeGrantLabels } from "../shared/grants";
import { authorizationSummary, NATIVE_GRANT_LABELS } from "../shared/permissions";
import type { ConnectionGroup } from "./connections";
import { resourceIcon } from "./icons";
import { ROLE_LABEL, titleOf, type ModelIndex } from "./lookup";
import type { Availability } from "./deployment";

export interface RelationshipPresentation {
  readonly action: string;
  readonly value: string;
  readonly title: string;
  readonly lines: readonly string[];
  readonly notes: readonly string[];
}

const ACTIONS: Readonly<Record<Relation, string>> = {
  env: "Reads", secret: "Loads secret", supplies: "Supplies input", maps: "Maps into",
  routes: "Routes to", authorizes: "Authorizes", grant: "Grants access",
  database: "Connects to", localReplay: "Local replay", trigger: "Triggers",
  runsTask: "Runs task", startsWorkflow: "Starts workflow", invokesAgent: "Invokes agent",
  usesTool: "Calls tool", step: "Executes step", integration: "Calls service",
  completesCallback: "Completes callback", manageConnections: "Sends replies via",
  contains: "Contains", cdk: "References", deployWhen: "Conditional deployment",
};

/** Keep canonical prefixes out of the fallback when an endpoint belongs to another mode. */
function endpointName(index: ModelIndex, id: string): string {
  const title = titleOf(index, id);
  return title === id ? id.replace(/^(?:resource|lambda|service|task|workflow|agent|gateway|local):/, "") : title;
}

function integrationAction(service: string, operations: readonly string[]): string {
  if (service === "queue") return "Sends messages to";
  if (service === "topic") return "Publishes messages to";
  if (service === "eventBus") return "Publishes events to";
  if (service === "httpConnection") return "Calls HTTP endpoint";
  if (service === "table") {
    const actions: Readonly<Record<string, string>> = { get: "Reads items from", put: "Writes items to", update: "Updates items in", delete: "Deletes items from" };
    return operations.length === 1 ? actions[operations[0]!] ?? "Uses table" : operations.includes("get") ? "Reads and writes table" : "Writes to table";
  }
  return "Calls service";
}

function nativeGrantPresentation(edge: ModelEdge, index: ModelIndex) {
  const context = edge.permissionContext;
  if (context?.kind !== "native") return;
  const resource = index.resources.get(edge.to);
  const bucket = resource && resourceIcon(resource) === "bucket";
  const readWrite = ["grantRead", "grantWrite", "grantReadWrite"].includes(context.method);
  // These helpers also exist on secrets and custom constructs. Only bucket
  // evidence makes their argument an object-key scope.
  const action = readWrite && !bucket ? NATIVE_GRANT_LABELS[context.method]!
    : nativeGrantLabels[context.method as keyof typeof nativeGrantLabels] ?? (context.method === "grant" ? "Allow AWS actions" : "Grants access");
  const args = context.arguments;
  const objectScope = bucket && readWrite && (args.length === 0 || args.length === 1 && typeof args[0] === "string")
    ? !args.length || args[0] === "*" ? "All objects" : args[0] === "" ? '""' : String(args[0])
    : undefined;
  return { action, objectScope };
}

/** Purpose first. Raw source explanations and permission evidence stay in the inspector. */
export function presentRelationship(edge: ModelEdge, index: ModelIndex): RelationshipPresentation {
  let action = ACTIONS[edge.relation];
  const destination = endpointName(index, edge.to);
  let value = destination;
  const lines: string[] = [];
  const context = edge.permissionContext;
  if (["routes", "env", "secret", "maps", "supplies", "trigger"].includes(edge.relation)) value = edge.label.trim() || destination;
  if (edge.relation === "database") {
    if (context?.kind === "database" && context.connection === "direct") action = "Connects directly to";
    const local = index.localServices.has(edge.to);
    lines.push(local ? "Framework supplies the local connection settings." : "Framework supplies connection settings, private networking and IAM login.");
    if (context?.kind === "database" && context.readers) lines.push(local ? "Writer and reader connections share the local database." : "Includes writer and reader connections.");
  } else if (edge.relation === "contains") {
    if (index.resources.get(edge.to)?.frameworkManaged === "database") action = "Provides database";
  } else if (edge.relation === "localReplay") {
    value = endpointName(index, edge.from);
  } else if (edge.relation === "deployWhen") {
    value = `$${endpointName(index, edge.from)}`;
    const when = index.targets.get(edge.to)?.lanes.when;
    if (when) lines.push(`Deploys when ${endpointName(index, edge.from)} equals ${JSON.stringify(when.equals)}.`);
  } else if (edge.relation === "supplies") {
    const requirement = edge.inputRequirement;
    const entry = index.resources.get(edge.from)?.deploymentFile?.entries.find(entry => entry.name === edge.label);
    if (requirement?.status === "default" || !requirement && entry?.defaulted) lines.push("Uses the declaration default.");
    else if (requirement?.status === "unknown") lines.push("Input status unavailable.");
    else if (requirement?.status !== "missing" && entry?.status === "empty") lines.push("Empty in this file.");
    else if (requirement?.status !== "missing" && entry?.status === "missing") lines.push("Not set in this file.");
  } else if (edge.relation === "trigger") {
    if (context?.kind === "trigger" && value.toLowerCase() === context.adapter.toLowerCase()) value = destination;
    if (edge.sourceConstruct) lines.push(`Defined by ${edge.sourceConstruct}`);
  } else if (context?.kind === "subscription") {
    action = "Delivers messages to";
  } else if (context?.kind === "trigger-dlq" || context?.kind === "failure") {
    action = "Sends failed events to";
  } else if (context?.kind === "native") {
    const grant = nativeGrantPresentation(edge, index)!;
    action = grant.action;
    if (grant.objectScope !== undefined) lines.push(`Object scope: ${grant.objectScope}`);
  } else if (edge.relation === "step") {
    const target = context?.kind === "step" ? context.target : index.targets.get(edge.to)?.kind;
    action = target === "lambda" ? "Invokes function" : target === "task" ? ACTIONS.runsTask
      : target === "workflow" ? ACTIONS.startsWorkflow : target === "agent" ? ACTIONS.invokesAgent : ACTIONS.step;
    if (context?.kind === "step" && context.callback) lines.push("Waits for a workflow callback.");
  } else if (context?.kind === "integration") {
    action = integrationAction(context.service, context.operations);
    if (context.operations.length > 1 || action === ACTIONS.integration) lines.push(`Operations: ${context.operations.join(", ")}`);
  } else if (edge.relation === "cdk") {
    if (edge.label === "EventBridge rule") action = "Routes events to";
    else if (edge.label === "Dead-letter queue") action = "Sends failed messages to";
  }
  if (edge.inputRequirement?.status === "missing") lines.push("Required value missing.");
  return { action, value, title: `${action}: ${value}`, lines, notes: edge.authorization ? authorizationSummary(edge.authorization) : [] };
}

// Same-type bundles name what they carry; different types have their own connections.
const FAMILIES: Readonly<Record<Relation, { readonly singular: string; readonly plural: string; readonly verb: string }>> = {
  env: { singular: "environment value", plural: "environment values", verb: "Reads" },
  secret: { singular: "startup secret", plural: "startup secrets", verb: "Loads" },
  supplies: { singular: "input", plural: "inputs", verb: "Supplies" },
  maps: { singular: "client variable", plural: "client variables", verb: "Maps" },
  routes: { singular: "API route", plural: "API routes", verb: "Routes to" },
  authorizes: { singular: "API route", plural: "API routes", verb: "Authorizes" },
  grant: { singular: "permission", plural: "permissions", verb: "Grants access" },
  database: { singular: "database", plural: "databases", verb: "Connects to" },
  localReplay: { singular: "event handler", plural: "event handlers", verb: "Local replay" },
  trigger: { singular: "event trigger", plural: "event triggers", verb: "Triggers" },
  runsTask: { singular: "task", plural: "tasks", verb: "Runs" },
  startsWorkflow: { singular: "workflow", plural: "workflows", verb: "Starts" },
  invokesAgent: { singular: "agent", plural: "agents", verb: "Invokes" },
  usesTool: { singular: "agent tool", plural: "agent tools", verb: "Calls" },
  step: { singular: "workflow step", plural: "workflow steps", verb: "Executes" },
  integration: { singular: "service call", plural: "service calls", verb: "Makes" },
  completesCallback: { singular: "callback", plural: "callbacks", verb: "Completes" },
  manageConnections: { singular: "WebSocket API", plural: "WebSocket APIs", verb: "Sends replies via" },
  contains: { singular: "resource", plural: "resources", verb: "Contains" },
  cdk: { singular: "resource reference", plural: "resource references", verb: "Uses" },
  deployWhen: { singular: "deployment condition", plural: "deployment conditions", verb: "Conditional deployment" },
};

function familyOf(edge: ModelEdge) {
  return edge.permissionContext?.kind === "subscription" ? { singular: "subscription", plural: "subscriptions", verb: "Delivers messages to" }
    : edge.permissionContext?.kind === "trigger-dlq" || edge.permissionContext?.kind === "failure" ? { singular: "failure destination", plural: "failure destinations", verb: "Sends failed events to" }
    : FAMILIES[edge.relation];
}

export function presentConnection(connection: ConnectionGroup, mode: Mode, index: ModelIndex) {
  const members = connection.members.map(member => ({ member, edge: member.models[mode] ?? member.edge }));
  if (members.length === 1) return { ...presentRelationship(members[0]!.edge, index), homogeneous: true };
  const family = familyOf(members[0]!.edge);
  const action = family.verb;
  const value = `${members.length} ${family.plural}`;
  const title = `${action}: ${value}`;
  const lines = members.slice(0, 4).map(({ edge, member }) => {
    const native = nativeGrantPresentation(edge, index);
    const presentation = presentRelationship(edge, index);
    const compact = ["env", "secret", "supplies", "maps", "routes"].includes(edge.relation);
    const label = `${compact ? presentation.value : presentation.title}${native?.objectScope !== undefined ? ` · ${native.objectScope}` : ""}`;
    const otherMode = member.models[mode] ? "" : member.models.dev ? " (Dev)" : " (Prod)";
    return `${label}${otherMode}${edge.inputRequirement?.status === "missing" ? " — required value missing" : ""}`;
  });
  if (members.length > 4) lines.push(`+${members.length - 4} more`);
  const hiddenMissing = members.slice(4).filter(({ edge }) => edge.inputRequirement?.status === "missing").length;
  if (hiddenMissing) lines.push(`${hiddenMissing} more required ${hiddenMissing === 1 ? "value" : "values"} missing.`);
  return { action, value, title, lines, notes: [], homogeneous: true };
}

/** A fact is qualified whenever it describes only one environment's source evidence. */
export interface ConnectionHoverDetail {
  readonly text: string;
  readonly kind: "detail" | "permission";
  readonly tone?: "warning";
  readonly modes?: readonly Mode[];
}

export interface ConnectionHoverRow {
  readonly id: string;
  readonly label: string;
  readonly availability: Availability;
  readonly details: readonly ConnectionHoverDetail[];
}

export interface ConnectionHoverEndpoint {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  /** Present only when the same endpoint has different identities in its two graphs. */
  readonly variants?: readonly { readonly mode: Mode; readonly label: string; readonly kind: string }[];
}

export interface ConnectionHoverPresentation {
  readonly title: string;
  readonly from: ConnectionHoverEndpoint;
  readonly to: ConnectionHoverEndpoint;
  readonly availability: Availability;
  readonly aggregated: boolean;
  /** Every original relationship, including those present only in the other environment. */
  readonly rows: readonly ConnectionHoverRow[];
  /** Facts shared by every row; row-specific differences remain beside their owner. */
  readonly details: readonly ConnectionHoverDetail[];
}

const HOVER_MODES: readonly Mode[] = ["dev", "prod"];
type HoverIndexes = Readonly<Record<Mode, ModelIndex>>;

function hoverEndpoint(id: string, indexes: HoverIndexes): ConnectionHoverEndpoint {
  const known = (index: ModelIndex) => index.gateways.has(id) || index.targets.has(id) || index.routes.has(id) || index.resources.has(id) || index.localServices.has(id) || index.defaults.has(id);
  const describe = (index: ModelIndex) => {
    const target = index.targets.get(id);
    const resource = index.resources.get(id);
    const resourceKinds = { envFile: "Environment file", stack: "Stack", member: "Stack member", construct: "Construct", input: "Input", secret: "Secret", group: "Input group" };
    const kind = index.gateways.has(id) ? "API Gateway" : target ? ROLE_LABEL[target.role]
      : index.routes.has(id) ? "API route" : index.localServices.has(id) ? "Database"
        : index.defaults.has(id) ? "Defaults" : resource?.frameworkManaged === "database" && resource.kind !== "stack" ? "Database"
          : resource ? resourceKinds[resource.kind] : "Resource";
    return { kind, label: endpointName(index, id) };
  };
  const variants = HOVER_MODES.flatMap(mode => {
    const index = indexes[mode];
    // Ghost catalog entries keep selection identity but supply no declaration in this graph.
    return known(index) && !index.resources.get(id)?.absent ? [{ mode, ...describe(index) }] : [];
  });
  const primary = variants[0] ?? describe(HOVER_MODES.map(mode => indexes[mode]).find(known) ?? indexes.dev);
  const differs = variants.some(variant => variant.label !== primary.label || variant.kind !== primary.kind);
  return { id, kind: primary.kind, label: primary.label, ...(differs ? { variants } : {}) };
}

/** Supply rows use catalog names; the variable-to-source mapping remains in the inspector. */
function hoverMemberLabel(edge: ModelEdge, connection: ConnectionGroup, index: ModelIndex): string {
  const presentation = presentRelationship(edge, index);
  if (edge.relation === "supplies") {
    const parameter = index.resources.get(edge.to);
    const group = index.resources.get(connection.to);
    return parameter?.path.slice(group?.kind === "group" ? group.path.length : -1).join(".") || presentation.value;
  }
  // Rows with distinct operations retain their verbs; homogeneous bindings read as a list.
  return ["env", "secret", "maps", "routes", "trigger"].includes(edge.relation) || presentation.action === familyOf(edge).verb
    ? presentation.value : presentation.title;
}

const detailKey = (detail: ConnectionHoverDetail): string => JSON.stringify([detail.kind, detail.tone, detail.text, detail.modes]);

/**
 * A tooltip describes both graphs at once. It never borrows the selected graph's
 * resource names, requirements or permissions to explain another environment.
 * Keep the older compact presentation API for labels, descriptions and inspectors.
 */
export function presentConnectionHover(connection: ConnectionGroup, indexes: HoverIndexes): ConnectionHoverPresentation {
  const primaryMode = connection.members[0]?.models.dev ? "dev" : "prod";
  const primaryEdge = connection.members[0]?.models[primaryMode] ?? connection.edge;
  const rows = connection.members.map((member): ConnectionHoverRow => {
    const variants = HOVER_MODES.flatMap(mode => {
      const edge = member.models[mode];
      return edge ? [{ mode, edge, presentation: presentRelationship(edge, indexes[mode]), label: hoverMemberLabel(edge, connection, indexes[mode]) }] : [];
    });
    const labels = new Map<string, Mode[]>();
    const facts = new Map<string, { detail: Omit<ConnectionHoverDetail, "modes">; modes: Mode[] }>();
    const add = (detail: Omit<ConnectionHoverDetail, "modes">, mode: Mode) => {
      const key = detailKey(detail);
      const fact = facts.get(key) ?? { detail, modes: [] };
      if (!fact.modes.includes(mode)) fact.modes.push(mode);
      facts.set(key, fact);
    };
    for (const variant of variants) {
      labels.set(variant.label, [...(labels.get(variant.label) ?? []), variant.mode]);
      for (const text of variant.presentation.lines) add({ text, kind: "detail", ...(text === "Required value missing." ? { tone: "warning" as const } : {}) }, variant.mode);
      for (const text of variant.presentation.notes) add({ text, kind: "permission" }, variant.mode);
    }
    const details: ConnectionHoverDetail[] = [];
    if (labels.size > 1) for (const [text, modes] of labels) details.push({ text, kind: "detail", modes });
    // A qualifier only distinguishes this member's graphs from each other.
    for (const { detail, modes } of facts.values()) details.push({ ...detail, ...(modes.length === variants.length ? {} : { modes }) });
    const fallback = variants[0]?.presentation ?? presentRelationship(member.edge, indexes[primaryMode]);
    const noun = familyOf(variants[0]?.edge ?? member.edge).singular;
    return {
      id: member.edge.id,
      label: labels.size > 1 ? noun[0]!.toUpperCase() + noun.slice(1) : variants[0]?.label ?? fallback.value,
      availability: member.availability,
      details,
    };
  });
  const sharedKeys = new Set(rows[0]?.details.map(detailKey));
  for (const row of rows.slice(1)) {
    const keys = new Set(row.details.map(detailKey));
    for (const key of sharedKeys) if (!keys.has(key)) sharedKeys.delete(key);
  }
  const details = (rows[0]?.details ?? []).filter(detail => sharedKeys.has(detailKey(detail)));
  const single = rows.length === 1;
  const presentation = presentRelationship(primaryEdge, indexes[primaryMode]);
  const distinctLabels = single && HOVER_MODES.every(mode => connection.members[0]?.models[mode])
    && hoverMemberLabel(connection.members[0]!.models.dev!, connection, indexes.dev) !== hoverMemberLabel(connection.members[0]!.models.prod!, connection, indexes.prod);
  const family = familyOf(primaryEdge);
  const from = hoverEndpoint(connection.from, indexes), to = hoverEndpoint(connection.to, indexes);
  const value = primaryEdge.relation === "supplies" ? rows[0]!.label : presentation.value;
  return {
    title: !single ? `${family.verb}: ${rows.length} ${family.plural}`
      : distinctLabels ? `${family.verb}: ${family.singular}`
      : endpointTitle(presentation, primaryEdge.relation, value, [from.label, to.label]),
    from,
    to,
    availability: connection.availability,
    aggregated: !single,
    rows: rows.map(row => ({ ...row, details: row.details.filter(detail => !sharedKeys.has(detailKey(detail))) })),
    details: single ? details : details.map(detail => SHARED_DETAILS[detail.text] ? { ...detail, text: SHARED_DETAILS[detail.text]!(family.singular) } : detail),
  };
}

/**
 * A heading with From and To beneath it: "action: value", unless the value only repeats one of those
 * endpoint names. An authored label (route key, variable, event) is information even when a handler shares its name.
 */
function endpointTitle(presentation: RelationshipPresentation, relation: Relation, value: string, endpoints: readonly string[]): string {
  const repeats = !["routes", "env", "secret", "maps", "trigger"].includes(relation) && endpoints.some(name => value === name || value === `$${name}`);
  return repeats ? standaloneAction(presentation.action, relation) : `${presentation.action}: ${value}`;
}

/** The inspector heading of one connection, consistent with its hover title. */
export function connectionTitle(edge: ModelEdge, index: ModelIndex): string {
  const presentation = presentRelationship(edge, index);
  return endpointTitle(presentation, edge.relation, presentation.value, [endpointName(index, edge.from), endpointName(index, edge.to)]);
}

/** From and To name both ends, so a title whose value only repeats one keeps a complete verb phrase. */
function standaloneAction(action: string, relation: Relation): string {
  if (relation === "database") return `${action} database`;
  if (relation === "deployWhen") return "Controls deployment";
  return action.replace(/ (?:to|into|via|from|in)$/, "");
}

/** A fact every member shares reads as one sentence about all of them, below the list. */
const SHARED_DETAILS: Readonly<Record<string, (member: string) => string>> = {
  "Uses the declaration default.": member => `Every ${member} uses its declaration default.`,
  "Empty in this file.": member => `Every ${member} is empty in this file.`,
  "Not set in this file.": member => `No ${member} is set in this file.`,
  "Input status unavailable.": member => `Input status is unavailable for every ${member}.`,
  "Required value missing.": member => `Every ${member} is missing its required value.`,
};
