import { gatewayModels } from "../../shared/gateways";
import {
  isFrameworkDatabase, databaseSettings, deployKey, deployLanes, DEPLOY_SETTINGS, type DeployInputs,
  WORKFLOW_REFERENCE,
  assertCloudEdgesResolvable,
  createTargetAvailability,
  endpointServices,
  DEFAULT_DATABASE_POOL,
  INTERFACE_ENDPOINT_SERVICES,
  formatResourceReference,
  getAgentBrowserRoutes,
  getFrameworkTargets,
  integrationKey,
  interfaceEndpointsMonthlyCost,
  isCdkResource,
  isCdkResourceGroup,
  isResourceReference,
  isNodeLambdaRuntime,
  normalizeFrameworkConfig,
  triggerAdapters,
  resolveNetwork,
  resolveServiceTarget,
  subnetEgress,
  usesDualStackEndpoints,
  validateFrameworkConfig,
  walkWorkflow,
  NETWORK_PRICES,
  type FrameworkConfig,
  type FrameworkNetwork,
  type NormalizedTarget,
  type ResourceReference,
} from "@repo/framework/config";
import type {
  Compute,
  Diagnostic,
  Lanes,
  Mode,
  ModeModel,
  ModelEdge,
  ModelResource,
  ModelRoute,
  ModelTarget,
  ModelWorkflow,
  NetworkModel,
  Placement,
  Relation,
} from "../../shared/model";
import { DEFAULT_FIELDS, fieldFacts } from "../edits/fields";
import { projectDefaults } from "../edits/defaults";
import { lambdaSpec, withLambdaSpecs } from "./lambda-spec";
import { declarationOf, originInMessage, parseOrigin } from "./origin";
import { projectTagging } from "./tags";
import { withConnectionAuthorizations } from "../../shared/permissions";

/**
 * One mode's application model, projected from the framework's own answers.
 *
 * Every fact here is a call into `@repo/framework/config`: targets and bindings
 * from normalization, lanes from `isTargetEnabled`/`isTargetDeployed`,
 * placement from `resolveLambdaTarget` (asked once per Lambda) and the network
 * helpers. The projection only reshapes them into something a browser can
 * draw; it decides nothing the framework has not already decided, and where the
 * framework has no answer (a stack's members, which only its class knows) it
 * says so rather than guess.
 */

export interface ProjectionOptions {
  readonly mode: Mode;
  /** Conditions are resolved privately by the parent; evaluators receive outcomes only. */
  readonly inputs?: { readonly dev: DeployInputs; readonly prod: DeployInputs };
  readonly outcomes?: Readonly<Record<string, { readonly dev: "holds" | "fails" | "unset"; readonly prod: "holds" | "fails" | "unset" }>>;
}

const WEB_SOCKET_ROLES = new Set(["webSocket", "webSocketAuthorizer"]);

export function resourceId(path: readonly string[]): string {
  return `resource:${path.join(".")}`;
}

function title(target: NormalizedTarget): string {
  const origin = target.origins[0] ? parseOrigin(target.origins[0]) : undefined;
  if (!origin) return target.id;
  if (origin.section === "http" || origin.section === "services") return origin.key;
  if (origin.section === "webSocket") return origin.chain.length ? `${origin.key} authorizer` : origin.key;
  return target.id;
}

export function targetLanes(config: FrameworkConfig, target: NormalizedTarget, options: ProjectionOptions, availability?: ReturnType<typeof createTargetAvailability>): Lanes {
  const devInputs = options.inputs?.dev;
  const prodInputs = options.inputs?.prod;
  const declaration = target.origins[0] ? declarationOf(config, parseOrigin(target.origins[0])!) : undefined;
  const view = availability ?? createTargetAvailability(config);
  const condition = typeof target.deploy === "string" ? undefined : target.deploy.when;
  const base = {
    deploy: typeof target.deploy === "string" ? target.deploy : "both" as const,
    ...(condition ? { when: { resource: resourceId(condition.resource.path), equals: condition.equals, ...(options.outcomes?.[deployKey(target.deploy)] ?? { dev: "unset" as const, prod: "unset" as const }) } } : {}),
    local: view.enabled(target.kind, target.id, "local", devInputs),
    cloud: view.enabled(target.kind, target.id, "cloud", options.mode === "dev" ? devInputs : prodInputs),
    dev: view.deployed(target.kind, target.id, "dev", { inputs: devInputs }),
    prod: view.deployed(target.kind, target.id, "prod", { inputs: prodInputs }),
  };
  const webSocketNote = WEB_SOCKET_ROLES.has(target.role) ? "API Gateway is framework managed; this handler follows its own deployment setting." : undefined;
  if (target.role === "tool" && declaration?.deploy === undefined) {
    const agents = Object.entries(config.agents ?? {})
      .filter(([, agent]) => agent.tools?.includes(target.id))
      .map(([id]) => `agent:${id}`);
    return {
      ...base,
      origin: "derived",
      derivedFrom: agents,
      note: agents.length > 0 ? `Runs wherever ${agents.join(" or ")} runs.` : "No agent lists it, so it runs nowhere.",
    };
  }
  const devNote =
    base.cloud && !base.dev && !webSocketNote
      ? "A development deployment builds only what AWS invokes; this runs under Compose instead."
      : undefined;
  return {
    ...base,
    origin: declaration?.deploy !== undefined ? "declared" : "default",
    ...(webSocketNote ?? devNote ? { note: webSocketNote ?? devNote } : {}),
  };
}

function compute(config: FrameworkConfig, target: NormalizedTarget): Compute {
  if (target.kind === "lambda") {
    const spec = lambdaSpec(config, target.id);
    return {
      kind: "lambda",
      implementation: spec.packaging === "container" ? "container" : isNodeLambdaRuntime(spec.runtime) ? "typescript" : "python",
      packaging: spec.packaging,
      ...(spec.packaging === "zip" ? { runtime: spec.runtime, handler: spec.handler,
        ...(isNodeLambdaRuntime(spec.runtime) ? { bundling: { ...spec.bundling } } : {}),
      } : {}),
      architecture: spec.architecture,
      memorySize: spec.memorySize,
      timeoutSeconds: spec.timeoutSeconds,
      logRetentionDays: spec.logRetentionDays,
      subnet: spec.subnet,
      ...(spec.localReplay ? { localReplay: true as const } : {}),
    };
  }
  if (target.kind === "service" || target.kind === "task") {
    const container = target.cloud.service ?? target.cloud.task!;
    const service = target.kind === "service" ? resolveServiceTarget(config, target.id) : undefined;
    return {
      kind: "container",
      cpu: container.cpu,
      memoryMiB: container.memoryMiB,
      subnet: container.subnet,
      architecture: container.architecture,
      ...(target.cloud.service
        ? { desiredCount: target.cloud.service.desiredCount, publicLoadBalancer: target.cloud.service.publicLoadBalancer }
        : {}),
      ...(service?.port !== undefined ? { port: service.port } : {}),
      ...(service?.healthCheckPath !== undefined ? { healthCheckPath: service.healthCheckPath } : {}),
    };
  }
  if (target.kind === "workflow") {
    let steps = 0;
    walkWorkflow(target.workflow.root, () => { steps += 1; });
    return { kind: "workflow", type: target.workflow.type, timeoutSeconds: target.workflow.timeoutSeconds, steps };
  }
  const agent = config.agents?.[target.id];
  return {
    kind: "agent",
    auth: agent?.auth === true,
    ...(agent?.route ? { route: agent.route } : {}),
    tools: [...(agent?.tools ?? [])],
  };
}

export function targetPlacement(config: FrameworkConfig, target: NormalizedTarget): Placement {
  if (target.kind === "workflow") {
    return { kind: "managed", reason: "Step Functions runs the state machine; it has no subnet." };
  }
  if (target.kind === "agent") {
    return { kind: "outside", reason: "AgentCore Runtime runs outside the VPC." };
  }
  if (target.kind === "service" || target.kind === "task") {
    const network = resolveNetwork(config, target.vpc);
    const container = target.cloud.service ?? target.cloud.task!;
    const declaration = target.origins[0] ? declarationOf(config, parseOrigin(target.origins[0])!) : undefined;
    const declared = (declaration?.cloud as Record<string, unknown> | undefined)?.subnet !== undefined;
    return {
      kind: "vpc",
      networkId: network.id,
      subnet: container.subnet,
      reason: `Fargate always runs in the VPC; ${declared ? "cloud.subnet" : config.defaults.container?.subnet !== undefined ? "defaults.container.subnet" : "the framework's default"} chooses the ${container.subnet} subnet.`,
      egress: subnetEgress(network, container.subnet),
    };
  }
  const spec = lambdaSpec(config, target.id);
  const declaration = target.origins[0] ? declarationOf(config, parseOrigin(target.origins[0])!) : undefined;
  if (spec.subnet === "none") {
    return { kind: "outside", reason: "Outside the VPC, with the whole internet." };
  }
  const network = resolveNetwork(config, target.vpc);
  const lifted = declaration?.subnet === undefined && declaration?.database !== undefined;
  return {
    kind: "vpc",
    networkId: network.id,
    subnet: spec.subnet,
    reason: lifted
      ? 'database: true places it in the private subnets.'
      : declaration?.subnet !== undefined
        ? `Declares subnet: "${spec.subnet}".`
        : `Inherits subnet "${spec.subnet}".`,
    egress: subnetEgress(network, spec.subnet),
    dualStack: usesDualStackEndpoints(network, spec.subnet),
  };
}

function networkModel(config: FrameworkConfig, targets: readonly ModelTarget[], network: FrameworkNetwork): NetworkModel {
  const placed = targets.some(target => target.lanes.prod && target.placement.kind === "vpc" && target.placement.networkId === network.id);
  const gateways = endpointServices(network).filter((service) => service === "s3" || service === "dynamodb");
  return {
    id: network.id,
    name: network.name,
    constructId: network.cloud.constructId,
    cidr: network.cidr,
    zones: network.zones,
    egressOnlyInternetGateway: network.egressOnlyInternetGateway,
    natGateway: network.natGateway,
    gatewayEndpoints: gateways,
    interfaceEndpoints: [...network.interfaceEndpoints],
    builtInProd: placed || (config.database?.vpc.id === network.id && !config.database.resource.absent),
    monthlyCost: {
      natGateway: network.natGateway ? NETWORK_PRICES.natGatewayMonthly : 0,
      interfaceEndpoints: interfaceEndpointsMonthlyCost(network, network.interfaceEndpoints.length),
    },
    subnets: (["public", "private", "isolated"] as const).map((name) => ({
      name,
      egress: subnetEgress(network, name),
    })),
  };
}

/**
 * A workflow graph as plain data.
 *
 * The graph is plain data already, apart from symbolic values a payload may hold
 * and the catalog proxies an integration names. Those become their recorded
 * reference, so nothing here can call back into a proxy.
 */
export function serializeWorkflowValue(value: unknown, depth = 0): unknown {
  if (depth > 64) return "[depth limit]";
  if (value === null || typeof value !== "object") {
    return typeof value === "function" ? "[function]" : value;
  }
  const symbolic = (value as Record<symbol, unknown>)[WORKFLOW_REFERENCE];
  if (symbolic !== undefined) return { $ref: serializeWorkflowValue(symbolic, depth + 1) };
  if (isCdkResource(value)) return { $resource: value.path.join(".") };
  if (Array.isArray(value)) return value.map((item) => serializeWorkflowValue(item, depth + 1));
  return Object.fromEntries(
    Object.keys(value).map((key) => [key, serializeWorkflowValue((value as Record<string, unknown>)[key], depth + 1)]),
  );
}

function workflowModel(target: NormalizedTarget): ModelWorkflow | undefined {
  if (target.kind !== "workflow") return undefined;
  const workflow = target.workflow;
  return {
    ref: target.reference,
    id: target.id,
    type: workflow.type,
    timeoutSeconds: workflow.timeoutSeconds,
    names: Object.fromEntries(workflow.names),
    targets: [...workflow.targets],
    integrations: workflow.integrations.map((use) => ({
      key: integrationKey(use.reference),
      ...(use.reference.resource ? { resource: resourceId(use.reference.resource.path) } : {}),
      operations: [...use.operations],
      awaitsCallback: use.awaitsCallback,
    })),
    root: serializeWorkflowValue(workflow.root),
  };
}

/** The catalog as declared, one entry per declaration and one per stack member anything reads. */
function catalogModel(config: FrameworkConfig, readPaths: readonly (readonly string[])[]): ModelResource[] {
  const resources: ModelResource[] = [];
  const stacks = new Map<string, boolean>();
  const visit = (group: Record<string, unknown>, prefix: readonly string[]): void => {
    for (const [name, entry] of Object.entries(group)) {
      const path = [...prefix, name];
      const parent = prefix.length ? { parent: resourceId(prefix) } : {};
      if (isCdkResourceGroup(entry)) {
        stacks.set(name, entry.absent === true);
        resources.push({ id: resourceId(path), path, kind: "stack", absent: entry.absent === true, ...parent });
      } else if (isCdkResource(entry)) {
        resources.push({ id: resourceId(path), path, kind: "construct", absent: entry.absent === true, ...parent });
      } else if (isResourceReference(entry)) {
        resources.push({
          id: resourceId(path),
          path,
          kind: entry.kind === "secret" ? "secret" : "input",
          absent: entry.absent === true,
          ...parent,
          ...(entry.fromEnv ? { fromEnv: entry.fromEnv } : {}),
          ...(entry.kind === "secret" && entry.fromEnv ? { bindingPath: entry.bindingPath ?? entry.path } : entry.bindingPath ? { bindingPath: entry.bindingPath } : {}),
          ...(entry.authoredValue !== undefined ? { authoredValue: entry.authoredValue } : {}),
          ...(entry.default !== undefined ? { default: entry.default } : {}),
          ...(entry.required ? { required: true } : {}),
          ...(entry.modes ? { modes: entry.modes } : {}),
          ...(entry.values ? { values: [...entry.values] } : {}),
          ...(entry.note ? { note: entry.note } : {}),
        });
      } else if (entry && typeof entry === "object") {
        const at = resources.length, id = resourceId(path);
        resources.push({ id, path, kind: "group", absent: false, ...parent });
        visit(entry as Record<string, unknown>, path);
        // A group holds nothing in a graph that declares every entry undefined, such as
        // development-only client URLs in production. Nested groups are settled first.
        const entries = resources.slice(at + 1).filter((resource) => resource.parent === id);
        if (entries.length > 0 && entries.every((resource) => resource.absent)) resources[at] = { ...resources[at]!, absent: true };
      }
    }
  };
  visit((config.resources ?? {}) as Record<string, unknown>, []);

  // A stack's members exist only in its class, so the members listed here are
  // the ones something reads. The server adds the rest from the class source.
  const known = new Set(resources.map((resource) => resource.id));
  for (const path of [...readPaths, ...(config.database ? [config.database.resource.path] : [])]) {
    const [stack, member] = path;
    if (stack === undefined || member === undefined || !stacks.has(stack)) continue;
    const id = resourceId([stack, member]);
    if (known.has(id)) continue;
    known.add(id);
    resources.push({
      id,
      path: [stack, member],
      kind: "member",
      parent: resourceId([stack]),
      absent: stacks.get(stack) === true,
      memberSource: "usage",
    });
  }
  if (config.database) {
    const database = resourceId(config.database.resource.path);
    const owner = resourceId(config.database.resource.path.slice(0, -1));
    for (let index = 0; index < resources.length; index++) {
      if (resources[index]!.id === database || resources[index]!.id === owner) resources[index] = { ...resources[index]!, frameworkManaged: "database", networkId: config.database.vpc.id };
    }
  }
  return resources;
}

/** Every edge the targets declare or the framework derives from them. */
function edgesOf(
  config: FrameworkConfig,
  targets: readonly NormalizedTarget[],
  routes: readonly ModelRoute[],
): { edges: ModelEdge[]; readPaths: (readonly string[])[] } {
  const edges: ModelEdge[] = [];
  const readPaths: (readonly string[])[] = [];
  const counts = new Map<string, number>();
  const add = (relation: Relation, from: string, to: string, edge: Omit<ModelEdge, "id" | "relation" | "from" | "to">) => {
    const base = `${relation}:${from}->${to}`;
    const index = counts.get(base) ?? 0;
    counts.set(base, index + 1);
    edges.push({ id: `${base}#${index}`, relation, from, to, ...edge });
  };
  const memberPath = (reference: { readonly path: readonly string[] }) => reference.path;
  for (const binding of normalizeFrameworkConfig(config).triggers) {
    // A resourceless trigger (a schedule) has no catalog node to draw from.
    if (!binding.resource) continue;
    readPaths.push(binding.resource.path);
    add("trigger", resourceId(binding.resource.path), `lambda:${binding.event}`, {
      provenance: "declared", label: String(binding.options.operation ?? binding.adapter), detail: `${binding.adapter} · ${binding.id}`, attachment: binding.key,
      permissionContext: { kind: "trigger", adapter: binding.adapter, ...(typeof binding.options.delivery === "string" ? { delivery: binding.options.delivery } : {}) },
    });
  }
  // The destination's send permission is granted to the function, so it reads as a grant.
  for (const failure of normalizeFrameworkConfig(config).failureDestinations) {
    readPaths.push(failure.destination.path);
    add("grant", `lambda:${failure.event}`, resourceId(failure.destination.path), { provenance: "declared", label: "onFailure", detail: "Receives runs Lambda stopped retrying.", permissionContext: { kind: "failure" } });
  }

  for (const route of routes) {
    add("routes", route.id, route.target, { provenance: "declared", label: route.kind === "webSocket" ? route.path : route.browserPath ?? route.path });
    if (route.authorizer) add("authorizes", route.authorizer, route.id, { provenance: "declared", label: "authorizer" });
  }

  const integrationPaths = new Map<string, readonly string[]>();
  for (const target of targets) {
    if (target.kind !== "workflow") continue;
    for (const use of target.workflow.integrations) {
      if (use.reference.resource) integrationPaths.set(integrationKey(use.reference), use.reference.resource.path);
    }
  }

  for (const target of targets) {
    const origin = target.origins[0] ? parseOrigin(target.origins[0]) : undefined;
    const declaration = origin ? declarationOf(config, origin) : undefined;
    const authoredEnvironment = (declaration?.environment ?? {}) as Record<string, unknown>;

    for (const [name, value] of Object.entries(target.environment)) {
      if (!isResourceReference(value)) continue;
      readPaths.push(memberPath(value));
      const viaUserPool = !(name in authoredEnvironment) && (name === "USER_POOL_ID" || name === "USER_POOL_CLIENT_ID");
      add("env", target.reference, resourceId(memberPath(value)), {
        provenance: viaUserPool ? "derived" : "declared",
        label: name,
        ...(value.secretArn ? { permissionContext: { kind: "secret" as const, delivery: "arn" as const } } : {}),
        detail: `${formatResourceReference(value)}${value.secretArn ? " — delivering the ARN also grants the read" : ""}${viaUserPool ? " — handed by userPool" : ""}`,
      });
    }
    for (const [name, value] of Object.entries(target.secrets)) {
      readPaths.push(memberPath(value));
      add("secret", target.reference, resourceId(memberPath(value)), {
        provenance: "declared",
        label: name,
        detail: `${formatResourceReference(value)}, injected at container startup`,
        permissionContext: { kind: "secret", delivery: "startup" },
      });
    }
    for (const binding of target.cloud.bindings) {
      switch (binding.capability) {
        case "nativeGrant":
          readPaths.push(binding.resource.path);
          add("grant", target.reference, resourceId(binding.resource.path), {
            provenance: "declared",
            label: `${binding.method}(${binding.arguments.map((argument) => JSON.stringify(argument)).join(", ")})`.slice(0, 48),
            permissionContext: { kind: "native", method: binding.method, arguments: binding.arguments },
            detail: `resources.${binding.resource.path.join(".")}.${binding.method}(${binding.arguments.map((argument) => JSON.stringify(argument)).join(", ")})`,
          });
          break;
        case "connectsTo":
          readPaths.push(binding.resource.path);
          add("database", target.reference, resourceId(binding.resource.path), {
            provenance: "declared",
            label: binding.connection === "direct" ? "database (direct)" : binding.readers ? "database + readers" : "database",
            permissionContext: { kind: "database", connection: binding.connection ?? "application", readers: !!binding.readers },
            detail: "IAM login, private placement and PRIMARY_DATABASE_URL, from database: true",
          });
          break;
        case "runsTask":
          add("runsTask", target.reference, `task:${binding.task}`, {
            provenance: "declared", label: "Launch ECS task",
            detail: `runsTask(${JSON.stringify(binding.task)})`,
          });
          break;
        case "startsWorkflow":
          add("startsWorkflow", target.reference, `workflow:${binding.workflow}`, { provenance: "declared", label: "startsWorkflow", detail: `startsWorkflow(${JSON.stringify(binding.workflow)})` });
          break;
        case "invokesAgent":
          add("invokesAgent", target.reference, `agent:${binding.agent}`, { provenance: "declared", label: "invokesAgent", detail: `invokesAgent(${JSON.stringify(binding.agent)})` });
          break;
        case "completesCallback": {
          const path = integrationPaths.get(binding.integration);
          if (path) add("completesCallback", target.reference, resourceId(path), { provenance: "declared", label: "completesCallback", detail: binding.integration });
          break;
        }
        // readSecret is derived from an `.arn` environment entry, drawn above.
        default:
          break;
      }
    }
    if (target.kind === "agent") {
      for (const tool of config.agents?.[target.id]?.tools ?? []) {
        add("usesTool", target.reference, `lambda:${tool}`, { provenance: "declared", label: "tool" });
      }
    }
    if (target.cloud.manageConnections) add("manageConnections", target.reference, "gateway:websocket", {
      provenance: "derived", label: "Manage WebSocket connections",
      detail: "cloud.manageConnections grants access to the declared API and stage.",
    });
    if (target.kind === "workflow") {
      const verbs = new Map<string, Set<string>>();
      const steps = new Map<string, Extract<ModelEdge["permissionContext"], { kind: "step" }>>();
      walkWorkflow(target.workflow.root, (node) => {
        if (node.kind !== "invocation") return;
        const reference = `${node.invokes}:${node.target}`;
        const verb = node.invokes === "lambda" ? "invokeLambda" : node.invokes === "task" ? "runTask" : node.invokes === "agent" ? "invokeAgent" : "runWorkflow";
        if (!verbs.has(reference)) verbs.set(reference, new Set());
        verbs.get(reference)!.add(node.completion === "callback" ? `${verb} (callback)` : verb);
        steps.set(reference, { kind: "step", target: node.invokes, callback: node.completion === "callback" || !!steps.get(reference)?.callback });
      });
      for (const [reference, kinds] of verbs) {
        add("step", target.reference, reference, { provenance: "declared", label: [...kinds].join(", "), permissionContext: steps.get(reference) });
      }
      for (const use of target.workflow.integrations) {
        if (!use.reference.resource) continue;
        readPaths.push(use.reference.resource.path);
        add("integration", target.reference, resourceId(use.reference.resource.path), {
          provenance: "declared",
          label: use.operations.join(", "),
          permissionContext: { kind: "integration", service: use.reference.kind, operations: use.operations },
          detail: `${integrationKey(use.reference)}${use.awaitsCallback ? " — suspends for a callback" : ""}`,
        });
      }
    }
  }
  // Append new derived links after existing declarations to preserve their stable ids.
  for (const binding of normalizeFrameworkConfig(config).triggers) for (const key of ["deadLetterQueue", "onFailureQueue"]) {
    const queue = binding.options[key] as unknown as { path?: readonly string[] } | undefined;
    if (!Array.isArray(queue?.path)) continue;
    readPaths.push(queue.path);
    add("grant", `lambda:${binding.event}`, resourceId(queue.path), {
      provenance: "derived", label: "Trigger dead-letter delivery", attachment: binding.key,
      permissionContext: { kind: "trigger-dlq", adapter: binding.adapter },
    });
  }
  return { edges, readPaths };
}

function routesOf(config: FrameworkConfig): ModelRoute[] {
  const normalized = normalizeFrameworkConfig(config);
  const routes: ModelRoute[] = [];
  for (const route of normalized.http) {
    const kind = route.type === "lambda" ? "http" : "service";
    routes.push({
      id: `route:${kind}:${route.path}`,
      kind,
      path: route.path,
      browserPath: route.path === "/" ? "/api" : `/api${route.path.endsWith("/*") ? route.path.slice(0, -2) : route.path}`,
      methods: route.methods === "*" ? "*" : [...route.methods],
      auth: route.auth === true,
      target: `${route.type}:${route.target}`,
      origin: route.origin,
    });
  }
  for (const route of normalized.webSocket) {
    routes.push({
      id: `route:ws:${route.routeKey}`,
      kind: "webSocket",
      path: route.routeKey,
      auth: route.authorizer !== undefined,
      target: route.target,
      ...(route.authorizer ? { authorizer: route.authorizer } : {}),
      origin: route.origin,
    });
  }
  for (const route of getAgentBrowserRoutes(config)) {
    routes.push({
      id: `route:agent:${route.path}`,
      kind: "agent",
      path: route.path,
      browserPath: route.path,
      auth: true,
      target: `agent:${route.id}`,
      origin: `agents["${route.id}"].route`,
    });
  }
  return routes;
}

function targetModel(config: FrameworkConfig, target: NormalizedTarget, options: ProjectionOptions, availability: ReturnType<typeof createTargetAvailability>, triggers: ReturnType<typeof normalizeFrameworkConfig>["triggers"], linkedCallbacks: ReadonlySet<string>): ModelTarget {
  const origin = target.origins[0] ? parseOrigin(target.origins[0]) : undefined;
  const declaration = origin ? declarationOf(config, origin) : undefined;
  const cloud = declaration?.cloud as Record<string, unknown> | undefined;
  return {
    ref: target.reference,
    kind: target.kind,
    id: target.id,
    role: target.role,
    ...(target.section ? { section: target.section } : {}),
    title: title(target),
    ...(target.directory ? { directory: target.directory } : {}),
    origins: [...target.origins],
    constructId: target.cloud.constructId,
    constructIdPinned: typeof cloud?.constructId === "string",
    lanes: targetLanes(config, target, options, availability),
    compute: compute(config, target),
    placement: targetPlacement(config, target),
    ...(declaration?.auth === true ? { auth: true } : {}),
    ...(declaration?.userPool === true ? { userPool: true } : {}),
    environment: Object.entries(target.environment).map(([name, value]) => ({
      name,
      value: isResourceReference(value)
        ? { kind: "reference" as const, resource: resourceId(value.path), display: formatResourceReference(value) }
        : { kind: "literal" as const, value },
      ...(!(name in ((declaration?.environment ?? {}) as Record<string, unknown>)) &&
      (name === "USER_POOL_ID" || name === "USER_POOL_CLIENT_ID")
        ? { via: "userPool" as const }
        : {}),
    })),
    secrets: Object.entries(target.secrets).map(([name, value]) => ({
      name,
      resource: resourceId(value.path),
      display: formatResourceReference(value as ResourceReference),
    })),
    access: target.cloud.access.map((statement) => ({ actions: [...statement.actions], resources: [...statement.resources] })),
    permissionSources: [
      ...triggers.filter(binding => !binding.resource && `lambda:${binding.event}` === target.reference)
        .map(binding => ({ relation: "trigger" as const, peer: `schedule:${binding.id}`, label: `Schedule · ${binding.id}`, incoming: true, context: { kind: "trigger" as const, adapter: binding.adapter } })),
      ...target.cloud.bindings.filter(binding => binding.capability === "completesCallback" && !linkedCallbacks.has(binding.integration))
        .map(binding => ({ relation: "completesCallback" as const, peer: binding.capability === "completesCallback" ? binding.integration : "", label: "Complete workflow callback" })),
      ...(target.kind === "workflow" ? target.workflow.integrations.filter(use => !use.reference.resource).map(use => ({ relation: "integration" as const, peer: integrationKey(use.reference), label: use.operations.join(", "), context: { kind: "integration" as const, service: use.reference.kind, operations: use.operations } })) : []),
    ],
    requirements: target.cloud.requirements.length,
    requirementRules: target.cloud.requirements.map((rule) => ({
      require: rule.require.map((reference) => resourceId(reference.path)),
      ...(rule.when ? { when: { resource: resourceId(rule.when.resource.path), equals: rule.when.equals } } : {}),
      ...(rule.message ? { message: rule.message } : {}),
    })),
    outputs: Object.values(target.cloud.outputs).map((output) => output.id),
  };
}

/** Runs `run`, collecting what it would have printed with console.warn. */
export function collectWarnings<T>(run: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    return { result: run(), warnings };
  } finally {
    console.warn = original;
  }
}

/** The framework's checks for one graph, as diagnostics rather than a thrown error. */
export function validateForMode(
  config: FrameworkConfig,
  options: ProjectionOptions,
  targets?: readonly NormalizedTarget[],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const entityFor = (message: string): string | undefined => {
    const origin = originInMessage(message);
    if (!origin || !targets) return undefined;
    return targets.find((target) => target.origins.includes(origin))?.reference;
  };
  const record = (stage: Diagnostic["stage"], severity: Diagnostic["severity"], message: string) => {
    const entity = entityFor(message);
    diagnostics.push({ severity, stage, message, ...(entity ? { entity } : {}) });
  };
  try {
    const { warnings } = collectWarnings(() => validateFrameworkConfig(config));
    for (const warning of warnings) record("validate", "warning", warning);
  } catch (error) {
    record("validate", "error", error instanceof Error ? error.message : String(error));
    return diagnostics;
  }
  try {
    assertCloudEdgesResolvable(config, options.mode, { inputs: options.inputs?.[options.mode] });
  } catch (error) {
    record("cloud-edges", "error", error instanceof Error ? error.message : String(error));
  }
  return diagnostics;
}

/** One mode's model of an evaluated config. */
export function projectModel(
  config: FrameworkConfig,
  options: ProjectionOptions,
  evaluatedInMs = 0,
): ModeModel {
  return withLambdaSpecs(config, () => withConnectionAuthorizations(projectModelSnapshot(config, options, evaluatedInMs)));
}

function projectModelSnapshot(config: FrameworkConfig, options: ProjectionOptions, evaluatedInMs: number): ModeModel {
  const availability = createTargetAvailability(config);
  const targets = getFrameworkTargets(config);
  const routes = routesOf(config);
  const { edges, readPaths } = edgesOf(config, targets, routes);
  for (const target of targets) if (typeof target.deploy !== "string") {
    const input = resourceId(target.deploy.when.resource.path);
    // The input controls deployment. Retain the historical relationship ID for selection stability.
    edges.push({ id: `deployWhen:${target.reference}:${input}`, from: input, to: target.reference, relation: "deployWhen", label: "deploys when input matches", provenance: "declared" });
    readPaths.push(target.deploy.when.resource.path);
  }
  const diagnostics = validateForMode(config, options, targets);
  const defaults = projectDefaults(config, targets, DEFAULT_FIELDS);
  const normalized = normalizeFrameworkConfig(config);
  const linkedCallbacks = new Set(targets.flatMap(target => target.kind === "workflow" ? target.workflow.integrations.filter(use => use.reference.resource).map(use => integrationKey(use.reference)) : []));
  const projectedTargets = targets.map(target => targetModel(config, target, options, availability, normalized.triggers, linkedCallbacks));
  return {
    mode: options.mode,
    tagging: projectTagging(config, targets, routes),
    deployChoices: Object.fromEntries([...new Set(targets.map(target => target.role))].map(role => [role, Object.fromEntries(DEPLOY_SETTINGS.map(setting => [setting, deployLanes(role, setting)]))])) as ModeModel["deployChoices"],
    gateways: gatewayModels(routes, projectedTargets),
    triggerAdapters: triggerAdapters(),
    interfaceEndpointServices: [...INTERFACE_ENDPOINT_SERVICES],
    triggers: normalizeFrameworkConfig(config).triggers.map((binding) => ({ ...binding, resource: binding.resource ? resourceId(binding.resource.path) : "" })),
    failureDestinations: normalizeFrameworkConfig(config).failureDestinations.map(({ event, destination, retryAttempts, maxEventAgeSeconds }) => ({ event, destination: resourceId(destination.path), ...(retryAttempts !== undefined ? { retryAttempts } : {}), ...(maxEventAgeSeconds !== undefined ? { maxEventAgeSeconds } : {}) })),
    status: diagnostics.some((diagnostic) => diagnostic.severity === "error") ? "error" : "ok",
    targets: projectedTargets,
    routes,
    resources: catalogModel(config, readPaths),
    edges,
    workflows: targets.map(workflowModel).filter((workflow): workflow is ModelWorkflow => workflow !== undefined),
    defaults: defaults.groups,
    networks: (config.networks ?? []).map(network => networkModel(config, projectedTargets, network)),
    databaseNetworkId: config.database?.vpc.id,
    ...(isFrameworkDatabase(config.database) ? { managedDatabase: {
      id: config.database.id, resource: resourceId(config.database.resource.path), networkId: config.database.vpc.id,
      subnet: config.database.subnet, engine: config.database.engine, databaseName: config.database.databaseName,
      settings: databaseSettings(config.database), authored: config.database.settings,
      consumers: targets.flatMap(target => target.cloud.bindings.flatMap(binding => binding.capability === "connectsTo" && resourceId(binding.resource.path) === resourceId(config.database!.resource.path) ? [{ target: target.reference, title: title(target), connection: binding.connection ?? "application", readers: !!binding.readers, maxConnections: binding.pool?.maxConnections ?? DEFAULT_DATABASE_POOL.maxConnections }] : [])),
    } } : {}),
    fields: { ...Object.fromEntries(targets.map((target) => [target.reference, fieldFacts(config, target)])), ...defaults.fields },
    diagnostics,
    evaluatedInMs,
  };
}

/** A model for a config that could not be loaded at all. */
export function failedModel(mode: Mode, error: unknown, evaluatedInMs = 0): ModeModel {
  return {
    mode,
    status: "error",
    targets: [],
    routes: [],
    resources: [],
    edges: [],
    workflows: [],
    fields: {},
    diagnostics: [{ severity: "error", stage: "load", message: error instanceof Error ? error.message : String(error) }],
    evaluatedInMs,
  };
}
