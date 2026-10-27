import type { DraftEdit } from "../shared/api";
import { grantOptions } from "../shared/grants";
import type { ModelResource, ModelTarget, Snapshot } from "../shared/model";
import type { IconKey } from "./icons";
import type { ConfiguredResourceOption } from "./views/ConfiguredResourcePicker";

export type AccessConnectionEdit = Extract<DraftEdit, { kind: "connection" }>;
type AccessSnapshot = Pick<Snapshot, "models" | "source">;

export interface AccessAction {
  readonly id: string;
  readonly label: string;
  readonly edit: AccessConnectionEdit;
  readonly scope?: boolean;
  readonly variable?: boolean;
  readonly existing?: boolean;
  readonly reason?: string;
}

export interface ConfiguredAccessOption extends ConfiguredResourceOption {
  readonly actions: readonly AccessAction[];
}

const SERVICES: readonly { readonly type: RegExp; readonly subtitle: string; readonly icon: IconKey }[] = [
  { type: /^aws-s3:/, subtitle: "Amazon S3 · Bucket", icon: "bucket" },
  { type: /^aws-sqs:/, subtitle: "Amazon SQS · Queue", icon: "queue" },
  { type: /^aws-dynamodb:/, subtitle: "Amazon DynamoDB · Table", icon: "table" },
  { type: /^aws-sns:/, subtitle: "Amazon SNS · Topic", icon: "topic" },
  { type: /^aws-events:/, subtitle: "Amazon EventBridge · Event bus", icon: "bus" },
  { type: /^aws-cognito:/, subtitle: "Amazon Cognito", icon: "userpool" },
  { type: /^aws-secretsmanager:/, subtitle: "AWS Secrets Manager", icon: "secret" },
  { type: /^aws-rds:/, subtitle: "Amazon RDS", icon: "database" },
];

/** Match typed declaration facts across modes; presentation labels never establish a grant. */
export function accessConnectionExists(edit: AccessConnectionEdit, snapshot: AccessSnapshot): boolean {
  const models = Object.values(snapshot.models);
  const targets = models.flatMap(model => model.targets).filter(target => target.ref === edit.target);
  const edges = models.flatMap(model => model.edges).filter(edge => edge.from === edit.target);
  if (edit.connection === "database") return models.some(model => model.managedDatabase?.consumers?.some(consumer => consumer.target === edit.target)) || edges.some(edge => edge.relation === "database");
  if (edit.connection === "userPool") return targets.some(target => target.userPool);
  if (edit.connection === "resource") return !!edit.variable && targets.some(target =>
    target.environment.some(entry => entry.name === edit.variable && entry.value.kind === "reference" && entry.value.resource === edit.destination)
    || target.secrets.some(entry => entry.name === edit.variable && entry.resource === edit.destination));
  if (edit.connection === "grant") return edges.some(edge => edge.to === edit.destination && edge.relation === "grant"
    && edge.permissionContext?.kind === "native" && edge.permissionContext.method === edit.grant
    && (edit.scope ? edge.permissionContext.arguments.length === 1 && edge.permissionContext.arguments[0] === edit.scope : edge.permissionContext.arguments.length === 0));
  const relation = edit.connection === "tool" ? "usesTool" : edit.connection;
  return edges.some(edge => edge.to === edit.destination && edge.relation === relation);
}

/** A destination-first catalog. The source writer remains authoritative at review time. */
export function configuredAccessOptions(target: ModelTarget, snapshot: AccessSnapshot, destinationId?: string): ConfiguredAccessOption[] {
  if (target.kind === "workflow") return [];
  const models = Object.values(snapshot.models);
  const targets = new Map(models.flatMap(model => model.targets).map(item => [item.ref, item]));
  const resources = new Map<string, ModelResource>();
  for (const model of models) for (const resource of model.resources) {
    if (!resources.has(resource.id) || resources.get(resource.id)!.absent && !resource.absent) resources.set(resource.id, resource);
  }
  const capabilities = new Map((snapshot.source.triggerCapabilities ?? []).map(item => [item.resource, item]));
  const action = (connection: AccessConnectionEdit["connection"], label: string, extra: Partial<AccessConnectionEdit> = {}, settings: Partial<AccessAction> = {}): AccessAction => {
    const edit: AccessConnectionEdit = { kind: "connection", target: target.ref, connection, enabled: true, ...extra };
    // Scoped grants and variable mappings can legitimately repeat with another scope/name.
    const existing = !settings.scope && !settings.variable && accessConnectionExists(edit, snapshot);
    return { id: extra.grant ?? connection, label, edit, ...settings, ...(existing ? { existing: true, reason: "Already configured." } : {}) };
  };
  const result: ConfiguredAccessOption[] = [];
  const add = (option: ConfiguredAccessOption) => {
    const unavailable = option.actions.length > 0 && option.actions.every(action => action.reason);
    result.push({ ...option, ...(unavailable && !option.reason ? { reason: option.actions.every(action => action.existing) ? "Already configured." : option.actions[0]!.reason } : {}) });
  };
  const owningStack = (resource: ModelResource): ModelResource | undefined => {
    const stackId = capabilities.get(resource.id)?.stack;
    if (stackId) return resources.get(stackId);
    const visited = new Set<string>();
    let current: ModelResource | undefined = resource;
    while (current && !visited.has(current.id)) {
      if (current.kind === "stack") return current;
      visited.add(current.id);
      current = current.parent ? resources.get(current.parent) : undefined;
    }
    return resources.get(`resource:${resource.path[0]}`);
  };

  const selectedResource = destinationId ? resources.get(destinationId) : undefined;
  for (const resource of destinationId ? selectedResource ? [selectedResource] : [] : resources.values()) {
    if (!/^resource:(?:[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*$/.test(resource.id)) continue;
    const title = resource.path.join(".");
    if (resource.kind === "input" || resource.kind === "secret") {
      const secret = resource.kind === "secret", startup = target.kind === "service" || target.kind === "task";
      add({ id: resource.id, title, subtitle: secret ? "AWS Secrets Manager · Secret" : "Input parameter", icon: secret ? "secret" : "input",
        searchTerms: `${resource.fromEnv ?? ""} environment configuration ${secret ? "secrets" : "inputs"}`,
        actions: [action("resource", secret ? startup ? "Load secret at startup" : "Read secret" : "Use as environment variable", { destination: resource.id }, { variable: true })] });
      continue;
    }
    if (resource.kind !== "member" && resource.kind !== "construct") continue;
    if (resource.frameworkManaged === "database") continue;
    const types = capabilities.get(resource.id)?.canonicalTypes ?? [];
    const service = SERVICES.find(service => types.some(type => service.type.test(type)));
    if (!service) continue;
    // The managed user-pool binding is offered once below, independent of its native fields.
    if (types.some(type => /^aws-cognito:I?UserPool(?:Client)?$/.test(type))) continue;
    const grants = grantOptions(types);
    const reason = owningStack(resource)?.stackUsage?.status === "unreferenced" ? "Add this stack to the CDK app before granting access."
      : !grants.length ? "Configure access to this resource in source." : undefined;
    add({ id: resource.id, title, subtitle: grants.length ? service.subtitle : service.subtitle.split(" · ")[0]!, icon: service.icon, searchTerms: types.join(" "), reason,
      actions: grants.map(grant => action("grant", grant.label, { destination: resource.id, grant: grant.method }, { scope: grant.scope })) });
  }

  const selectedTarget = destinationId ? targets.get(destinationId) : undefined;
  for (const destination of destinationId ? selectedTarget ? [selectedTarget] : [] : targets.values()) {
    if (destination.ref === target.ref) continue;
    const connection = destination.kind === "task" ? "runsTask" : destination.kind === "workflow" ? "startsWorkflow"
      : destination.kind === "agent" ? "invokesAgent" : target.kind === "agent" && destination.role === "tool" ? "tool" : undefined;
    if (!connection) continue;
    const label = connection === "runsTask" ? "Run task" : connection === "startsWorkflow" ? "Start workflow" : connection === "invokesAgent" ? "Invoke agent" : "Use agent tool";
    const subtitle = connection === "runsTask" ? "AWS Fargate · Container task" : connection === "startsWorkflow" ? "AWS Step Functions · Workflow"
      : connection === "invokesAgent" ? "Amazon Bedrock AgentCore · Agent" : "AWS Lambda · Agent tool";
    add({ id: destination.ref, title: destination.title, subtitle, icon: destination.kind,
      searchTerms: `${destination.id} ${destination.ref} ${label}`, actions: [action(connection, label, { destination: destination.ref })] });
  }

  const database = snapshot.models.prod.managedDatabase;
  if (database && target.kind !== "agent" && (!destinationId || destinationId === database.resource)) {
    const resource = resources.get(database.resource);
    const reason = target.role === "event" && target.compute.kind === "lambda" && !target.compute.localReplay
      ? "Enable local replay before connecting this event to the application database." : undefined;
    add({ id: database.resource, title: resource?.path.join(".") ?? database.id, subtitle: "PostgreSQL · Application database", icon: "database",
      searchTerms: `${database.id} RDS database`, actions: [action("database", "Connect to database", {}, { reason })] });
  }
  if (!destinationId || destinationId === "framework:userPool") {
    const userPool = [...resources.values()].find(resource => (capabilities.get(resource.id)?.canonicalTypes ?? []).some(type => /^aws-cognito:I?UserPool$/.test(type)));
    const declaredPool = models.some(model => model.targets.some(item => item.userPool || item.environment.some(entry => entry.via === "userPool")));
    if ((userPool || declaredPool) && target.role !== "agent" && target.role !== "tool") {
      add({ id: "framework:userPool", title: "Application user pool", subtitle: "Amazon Cognito · User pool", icon: "userpool", searchTerms: "userPool identity user pool identifiers",
        actions: [action("userPool", "Use user-pool identifiers")] });
    }
  }
  const priority = (option: ConfiguredAccessOption) => resources.get(option.id)?.kind === "input" ? 2 : resources.get(option.id)?.kind === "secret" ? 1 : 0;
  return result.sort((a, b) => Number(!!a.reason) - Number(!!b.reason) || priority(a) - priority(b) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}
