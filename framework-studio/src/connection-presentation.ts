import type { Mode, ModelEdge, Relation } from "../shared/model";
import { nativeGrantLabels } from "../shared/grants";
import { authorizationSummary, NATIVE_GRANT_LABELS } from "../shared/permissions";
import type { ConnectionGroup } from "./connections";
import { resourceIcon } from "./icons";
import { RELATION_LABEL, titleOf, type ModelIndex } from "./lookup";

export interface RelationshipPresentation {
  readonly title: string;
  readonly lines: readonly string[];
  readonly notes: readonly string[];
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
    : nativeGrantLabels[context.method as keyof typeof nativeGrantLabels] ?? (context.method === "grant" ? "Allow AWS actions" : "Resource access");
  const args = context.arguments;
  const objectScope = bucket && readWrite && (args.length === 0 || args.length === 1 && typeof args[0] === "string")
    ? !args.length || args[0] === "*" ? "All objects" : args[0] === "" ? '""' : String(args[0])
    : undefined;
  return { action, objectScope };
}

/** Purpose first. Raw source explanations and permission evidence stay in the inspector. */
export function presentRelationship(edge: ModelEdge, index: ModelIndex): RelationshipPresentation {
  let title = `${RELATION_LABEL[edge.relation]}: ${edge.label}`;
  const lines: string[] = [];
  const context = edge.permissionContext;
  if (edge.relation === "database") {
    title = context?.kind === "database" && context.connection === "direct" ? "Connects directly to PostgreSQL" : "Connects to PostgreSQL";
    const local = index.localServices.has(edge.to);
    lines.push(local ? "Framework supplies the local connection settings." : "Framework supplies connection settings, private networking and IAM login.");
    if (context?.kind === "database" && context.readers) lines.push(local ? "Writer and reader connections share the local database." : "Includes writer and reader connections.");
  } else if (edge.relation === "contains") {
    title = index.resources.get(edge.to)?.frameworkManaged === "database" ? "Provides the application database" : `Contains: ${titleOf(index, edge.to)}`;
  } else if (edge.relation === "localReplay") {
    title = "Local replay: AWS invocations";
  } else if (edge.relation === "deployWhen") {
    title = `Deploys when: ${index.resources.get(edge.to)?.fromEnv ?? titleOf(index, edge.to)}`;
    const when = index.targets.get(edge.from)?.lanes.when;
    if (when) lines.push(`Matches ${JSON.stringify(when.equals)}.`);
  } else if (edge.relation === "supplies") {
    const requirement = edge.inputRequirement;
    const entry = index.resources.get(edge.from)?.deploymentFile?.entries.find(entry => entry.name === edge.label);
    if (requirement?.status === "default" || !requirement && entry?.defaulted) lines.push("Uses the declaration default.");
    else if (requirement?.status === "unknown") lines.push("Input status unavailable.");
    else if (requirement?.status !== "missing" && entry?.status === "empty") lines.push("Empty in this file.");
    else if (requirement?.status !== "missing" && entry?.status === "missing") lines.push("Not set in this file.");
  } else if (edge.relation === "trigger") {
    if (edge.sourceConstruct) lines.push(`Defined by ${edge.sourceConstruct}`);
  } else if (context?.kind === "subscription") {
    title = "Delivers messages";
  } else if (context?.kind === "trigger-dlq" || context?.kind === "failure") {
    title = "Sends failed events";
  } else if (context?.kind === "native") {
    const grant = nativeGrantPresentation(edge, index)!;
    title = `${grant.action}: ${titleOf(index, edge.to)}`;
    if (grant.objectScope !== undefined) lines.push(`Object scope: ${grant.objectScope}`);
  } else if (edge.relation === "runsTask") {
    title = "Can launch task";
  } else if (edge.relation === "startsWorkflow") {
    title = "Can start workflow";
  } else if (edge.relation === "invokesAgent") {
    title = "Can invoke agent";
  } else if (edge.relation === "manageConnections") {
    title = "Can send WebSocket replies";
  } else if (edge.relation === "authorizes") {
    title = "Authorizes WebSocket connections";
  }
  if (edge.inputRequirement?.status === "missing") lines.push("Required value missing.");
  return { title, lines, notes: edge.authorization ? authorizationSummary(edge.authorization) : [] };
}

// A homogeneous bundle names what it carries. Mixed bundles summarize each purpose once.
const FAMILIES: Readonly<Record<Relation, { readonly singular: string; readonly plural: string; readonly verb?: string }>> = {
  env: { singular: "environment value", plural: "environment values", verb: "Reads" },
  secret: { singular: "startup secret", plural: "startup secrets", verb: "Loads" },
  supplies: { singular: "input", plural: "inputs", verb: "Supplies" },
  maps: { singular: "client variable", plural: "client variables", verb: "Maps" },
  routes: { singular: "API route", plural: "API routes" },
  authorizes: { singular: "authorizer", plural: "authorizers" },
  grant: { singular: "resource grant", plural: "resource grants" },
  database: { singular: "database binding", plural: "database bindings" },
  localReplay: { singular: "replay binding", plural: "replay bindings" },
  trigger: { singular: "event trigger", plural: "event triggers" },
  runsTask: { singular: "task binding", plural: "task bindings" },
  startsWorkflow: { singular: "workflow binding", plural: "workflow bindings" },
  invokesAgent: { singular: "agent binding", plural: "agent bindings" },
  usesTool: { singular: "agent tool", plural: "agent tools" },
  step: { singular: "workflow step", plural: "workflow steps" },
  integration: { singular: "service call", plural: "service calls" },
  completesCallback: { singular: "callback", plural: "callbacks" },
  manageConnections: { singular: "WebSocket reply binding", plural: "WebSocket reply bindings" },
  contains: { singular: "owned resource", plural: "owned resources" },
  cdk: { singular: "resource reference", plural: "resource references" },
  deployWhen: { singular: "deployment condition", plural: "deployment conditions" },
};

function familyOf(edge: ModelEdge) {
  return edge.permissionContext?.kind === "subscription" ? { singular: "subscription", plural: "subscriptions" }
    : edge.permissionContext?.kind === "trigger-dlq" || edge.permissionContext?.kind === "failure" ? { singular: "failure destination", plural: "failure destinations" }
    : FAMILIES[edge.relation];
}

export function presentConnection(connection: ConnectionGroup, mode: Mode, index: ModelIndex) {
  const members = connection.members.map(member => ({ member, edge: member.models[mode] ?? member.edge }));
  if (members.length === 1) return { ...presentRelationship(members[0]!.edge, index), homogeneous: true };
  const counts = new Map<string, { family: ReturnType<typeof familyOf>; count: number }>();
  for (const { edge } of members) {
    const family = familyOf(edge), current = counts.get(family.singular);
    counts.set(family.singular, { family, count: (current?.count ?? 0) + 1 });
  }
  const groups = [...counts.values()];
  const homogeneous = groups.length === 1;
  const first = groups[0]!;
  const title = homogeneous
    ? `${"verb" in first.family && first.family.verb ? `${first.family.verb} ` : ""}${first.count} ${first.family.plural}`
    : [...groups.slice(0, 2).map(({ family, count }) => `${count} ${count === 1 ? family.singular : family.plural}`),
      ...(groups.length > 2 ? [`${groups.slice(2).reduce((total, group) => total + group.count, 0)} other connections`] : [])].join(" · ");
  const lines = members.slice(0, 4).map(({ edge, member }) => {
    const native = nativeGrantPresentation(edge, index);
    const label = native ? `${homogeneous ? native.action : presentRelationship(edge, index).title}${native.objectScope !== undefined ? ` · ${native.objectScope}` : ""}`
      : homogeneous ? edge.label : presentRelationship(edge, index).title;
    const otherMode = member.models[mode] ? "" : member.models.dev ? " (Dev)" : " (Prod)";
    return `${label}${otherMode}${edge.inputRequirement?.status === "missing" ? " — required value missing" : ""}`;
  });
  if (members.length > 4) lines.push(`+${members.length - 4} more`);
  const hiddenMissing = members.slice(4).filter(({ edge }) => edge.inputRequirement?.status === "missing").length;
  if (hiddenMissing) lines.push(`${hiddenMissing} more required ${hiddenMissing === 1 ? "value" : "values"} missing.`);
  return { title, lines, notes: [], homogeneous };
}
