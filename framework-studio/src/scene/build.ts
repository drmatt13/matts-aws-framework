import { displayName } from "../naming";
import { gatewaysOf } from "../../shared/gateways";
import { drawnAs } from "../drawn-as";
import type { Lanes, Mode, ModeModel, ModelResource, ModelRoute, ModelTarget, NetworkModel, TargetKind } from "../../shared/model";
import { edgeCategory, ROLE_LABEL } from "../lookup";
import { endpointServiceIcon, resourceBadge, resourceIcon, routeIcon, targetIcon, type IconKey } from "../icons";
import { endpointServiceDetails } from "../endpoint-services";
import { availabilityBadge, deploymentBadge, developmentLocation, environments, type Availability, type DeploymentBadgeKind } from "../deployment";
import { ELEVATION_STEP, TILE_HEIGHT, TILE_WIDTH, project } from "./iso";
import { buildIconShape, NODE_SPACING } from "./shapes";
import { NODE_CAPTION } from "./labels";
import { islandFrame, type SceneFrame } from "./frame";
import { extractLayoutGraph, topologyEdges, type LayoutAnchor, type LayoutLink } from "./layout-graph";
import { optimizeLayout } from "./layout-optimize";
import { layoutLabels, layoutObstacles } from "./layout-quality";
import { connectionStyle } from "./connections";
import { routeConnections } from "./routing";
import { ENVIRONMENT_FILES_ISLAND } from "../../shared/client-environment";
import { aggregateConnections } from "../connections";
import { entryCount, groupEntries } from "../input-groups";
import { isFrameworkManagedResource } from "../../shared/framework-management";
import type { Band, Island, Presence, Prop, Region, Scene, SceneEdge, SceneNode, SceneOptions, Tile } from "./types";
export type { Band, Island, Presence, Prop, Region, Scene, SceneEdge, SceneNode, SceneOptions, Tile } from "./types";
export { titleRoom } from "./layout";

/**
 * The landscape: one mode's model laid out as islands of terrain with
 * buildings on them.
 *
 * A view of the model, never a second one. Every building is an entity the
 * model already names, under the id the model gives it; where it stands is
 * layout, computed here from the model alone, deterministically, so a refresh
 * that changes nothing moves nothing. Nothing about a building's position is
 * written anywhere or read back as configuration.
 *
 * The regions mean what they say. Entry points are grouped by the gateway that
 * serves them; compute by where it runs (outside the VPC, on a subnet terrace
 * inside it, on AgentCore, or as a state machine); catalog stacks share one
 * island, separate from authored inputs and secrets. The VPC's level terraces
 * stand on their own: a subnet is a place, not a permission.
 */

/** "Stack member, ITable" reads as "Stack member · ITable"; an empty qualifier, or one that repeats the name, is dropped. */
export function kindText(kindLabel: string, name?: string): string {
  const [kind, ...qualifier] = kindLabel.split(", ");
  const detail = qualifier.join(", ");
  return detail && detail !== name ? `${kind} · ${detail}` : kind!;
}

// ---------------------------------------------------------------------------
// Layout constants, in grid cells
// ---------------------------------------------------------------------------

/** The icon and caption share one predictable lattice slot. */
const STEP = NODE_SPACING;
const THICKNESS = 3;
/** The VPC's subnets stand level, side by side: public, private, isolated. */
const VPC_HEIGHT = 4;
/** How far each corner is cut back, measured along the island's edges, in cells. */
export const CHAMFER = 2;

/** The chamfer an island of this many cells takes: never so deep that two cuts meet along an edge. */
export function chamferSize(width: number, length: number): number {
  return Math.min(CHAMFER, Math.min(width, length) / 3);
}

/**
 * Whether a cell is cut away by the island's chamfered corners: its centre lies
 * outside the straight cut across a corner. A cell the cut passes through the
 * middle of stays, so tiles, walls and picking agree with the drawn outline.
 */
export function chamfered(lx: number, ly: number, width: number, length: number): boolean {
  const cut = chamferSize(width, length);
  const left = lx + 0.5;
  const right = width - 0.5 - lx;
  const back = ly + 0.5;
  const front = length - 0.5 - ly;
  return left + back < cut || right + back < cut || right + front < cut || left + front < cut;
}

// ---------------------------------------------------------------------------
// Presence: what the selected graph holds
// ---------------------------------------------------------------------------

function targetPresence(lanes: Lanes, mode: Mode): { presence: Presence; text: string } {
  const availability = environments(lanes);
  if (availability[mode]) return { presence: "built", text: mode === "dev" ? `Enabled in development · ${developmentLocation(lanes).toLowerCase()}.` : "Enabled in production · runs in AWS." };
  if (availability[mode === "dev" ? "prod" : "dev"]) return { presence: "other", text: `Not enabled in ${mode === "dev" ? "development" : "production"}.` };
  return { presence: "nowhere", text: "Not enabled in either environment." };
}

// ---------------------------------------------------------------------------
// Items, bands and islands before placement
// ---------------------------------------------------------------------------

interface Item {
  readonly frameworkManaged?: true;
  readonly sourceProblems?: readonly string[];
  readonly badge?: DeploymentBadgeKind;
  readonly icon: IconKey;
  readonly roleIcon?: IconKey;
  readonly id: string;
  readonly entity: SceneNode["entity"];
  readonly label: string;
  readonly kindLabel: string;
  readonly presence: Presence;
  readonly presenceText: string;
  readonly lanes?: Lanes;
  readonly auth?: boolean;
  readonly targetKind?: TargetKind;
}

interface BandSpec {
  readonly id: string;
  readonly title: string;
  readonly caption: readonly string[];
  readonly h: number;
  /** Each group starts a new column. */
  readonly groups: readonly (readonly Item[])[];
  /** Items per lattice column. Defaults to about the square root of the band's items, so islands come out near square. */
  readonly perColumn?: number;
  readonly props?: readonly Omit<Prop, "gx" | "gy" | "h" | "geometry" | "presence">[];
}

interface IslandSpec {
  readonly id: string;
  readonly title: string;
  readonly region: Region;
  readonly caption: readonly string[];
  readonly ghost?: Island["ghost"];
  readonly propPresence?: Prop["presence"];
  readonly bands: readonly BandSpec[];
}

function targetItem(target: ModelTarget, mode: Mode): Item {
  const { presence, text } = targetPresence(target.lanes, mode);
  const base = {
    sourceProblems: target.implementation?.ready === false ? target.implementation.problems : undefined,
    badge: deploymentBadge(target.lanes),
    icon: targetIcon(target),
    id: target.ref,
    entity: "target" as const,
    label: target.id,
    kindLabel: ROLE_LABEL[target.role],
    presence,
    presenceText: text,
    lanes: target.lanes,
    targetKind: target.kind,
  };
  if (target.kind !== "lambda") return base;
  return {
    ...base,
    roleIcon: target.role === "webSocket" || target.role === "webSocketAuthorizer" ? "webSocket"
      : target.role === "event" ? "event" : target.role === "tool" ? "agent" : undefined,
  };
}

function gatewayItem(gateway: import("../../shared/gateways").ModelGateway, mode: Mode): Item {
  const presence = targetPresence(gateway.lanes, mode);
  return { id: gateway.id, entity: "gateway", label: gateway.title, kindLabel: "Framework-managed API Gateway", icon: "gateway", roleIcon: "managed", badge: deploymentBadge(gateway.lanes), presence: presence.presence, presenceText: presence.text, lanes: gateway.lanes };
}

function resourceItem(resource: ModelResource, mode: Mode, availability?: Availability, resources?: ReadonlyMap<string, ModelResource>): Item {
  const name = resource.path[resource.path.length - 1]!;
  const kindLabel =
    resource.clientEnvironment ? "Client-app environment mappings" : resource.deploymentFile ? `CDK ${resource.deploymentFile.mode === "dev" ? "development" : "production"} environment file` : resource.kind === "stack"
      // A stack stands under its class name, so the qualifier names its catalog entry instead.
      ? resource.stackClass && !resource.frameworkStack ? `Stack, resources.${resource.path.join(".")}` : "Stack"
      : resource.kind === "member"
        ? `Stack member, ${resource.typeText ?? "unknown type"}`
        : resource.kind === "secret"
          ? `Secret, ${resource.fromEnv ?? ""}`
          : resource.kind === "input"
            ? `Input, ${resource.fromEnv ?? "Value in source"}`
            : resource.kind === "group"
              ? "Input group"
              : "Construct";
  const graph = mode === "dev" ? "development" : "production";
  const presenceText = resource.stackUsage?.status === "unreferenced" ? "Not added to CDK app: no constructor reference found in the app's runtime imports."
    : resource.frameworkManaged ? `Framework-managed ${resource.frameworkManaged === "database" ? "database" : "stack exporting root .env values"}${resource.absent ? `; absent in the ${graph} graph` : ""}.`
    : resource.absent
      ? `Absent in the ${graph} graph: declared undefined here, so nothing that reads it sees a value.`
      : resource.kind === "member" && resource.memberSource === "class"
        ? "Declared by its stack; no workload references it."
        : `Held by the ${graph} graph.`;
  return {
    id: resource.id,
    badge: availability ? availabilityBadge(availability) : undefined,
    icon: resourceIcon(resource),
    roleIcon: resourceBadge(resource, resources),
    ...(isFrameworkManagedResource(resource, resources) ? { frameworkManaged: true as const } : {}),
    entity: "resource",
    label: resource.kind === "stack" ? resource.path.join(".") : name,
    kindLabel,
    presence: resource.absent ? "absent" : "present",
    presenceText: resource.frameworkStack ? `${presenceText} Not defined in resources.` : presenceText,
  };
}

function networkCaptions(network: NetworkModel | undefined) {
  const egress = (name: "public" | "private" | "isolated") => network?.subnets.find((subnet) => subnet.name === name)?.egress;
  const out = (value: { ipv4: boolean; ipv6: boolean } | undefined) =>
    value ? ([value.ipv4 ? "IPv4" : null, value.ipv6 ? "IPv6" : null].filter(Boolean).join(" and ") || "nothing") : "unknown";
  const endpoints = [...(network?.gatewayEndpoints ?? []), ...(network?.interfaceEndpoints ?? [])];
  return {
    public: [`IPv4 and IPv6 out through the internet gateway.`, "A container here gets a public IPv4 address; a Lambda never stands here."],
    private: [
      `${out(egress("private"))} leaves this subnet.`,
      network?.natGateway ? "NAT gateway: on." : "No NAT gateway, so no IPv4 way out.",
      network?.egressOnlyInternetGateway ? "Egress-only internet gateway: on (IPv6 out)." : "No egress-only gateway.",
    ],
    isolated: [
      "Nothing leaves this subnet except through endpoints.",
      endpoints.length ? `Endpoints: ${endpoints.join(", ")}.` : "No endpoints are declared.",
    ],
    endpoints,
  };
}

function islandSpecs(model: ModeModel, options: SceneOptions): { entry: IslandSpec[]; compute: IslandSpec[]; catalog: IslandSpec[] } {
  const mode = model.mode;
  const standIns = drawnAs(model);
  const resourceIndex = new Map(model.resources.map(resource => [resource.id, resource]));
  const catalogItem = (resource: ModelResource) => resourceItem(resource, mode, options.resourceAvailability?.[resource.id], resourceIndex);
  const targets = new Map(model.targets.map((target) => [target.ref, target]));
  const apiGroups = [gatewaysOf(model).map(gateway => gatewayItem(gateway, mode))];
  const entry: IslandSpec[] = [{
    id: "island:apis", title: "APIs", region: "entry",
    caption: ["Framework-managed HTTP and WebSocket API Gateways. Select a gateway to inspect its routes and deployment."],
    bands: [{ id: "band:apis", title: "APIs", caption: [], h: 2, groups: apiGroups }],
  }];

  // Compute, by where it runs.
  // HTTP, WebSocket, event and AgentCore tool functions, a column group each.
  const lambdaGroups: Item[][] = [[], [], [], []];
  const byVpc = new Map((model.networks ?? []).map(network => [network.id, { public: [] as Item[], private: [] as Item[], isolated: [] as Item[] }]));
  const agents: Item[] = [];
  const workflows: Item[] = [];
  for (const resource of model.resources) {
    if (resource.kind === "member" && resource.networkId && resource.networkPlacement) {
      byVpc.get(resource.networkId!)?.[resource.networkPlacement].push({ ...catalogItem(resource), ...(resource.frameworkManaged === "database" ? { label: "RDS database", kindLabel: `Framework-managed Amazon RDS, resources.${resource.path.join(".")}` } : {}) });
    }
  }
  // The local database stands beside RDS, as its development counterpart: workloads bind to one or the other.
  const localServices = model.localServices ?? [];
  byVpc.get(model.databaseNetworkId ?? "")?.isolated.push(...localServices.map((service): Item => ({
    id: service.id, entity: "local", icon: "postgres", label: service.title,
    kindLabel: "Framework-managed Compose database", roleIcon: "managed", badge: "dev", presence: service.enabled ? "built" : "other",
    presenceText: service.enabled ? "Development database, declared in docker-compose.yml. Container status is not monitored." : "Used during development on your machine.",
  })));
  for (const target of model.targets) {
    const item = targetItem(target, mode);
    if (target.placement.kind === "vpc") byVpc.get(target.placement.networkId)?.[target.placement.subnet].push(item);
    else if (target.kind === "workflow") workflows.push(item);
    else if (target.kind === "agent") agents.push(item);
    else if (target.role === "tool") lambdaGroups[3]!.push(item);
    else if (target.role === "event") lambdaGroups[2]!.push(item);
    else if (target.role === "webSocket" || target.role === "webSocketAuthorizer") lambdaGroups[1]!.push(item);
    else lambdaGroups[0]!.push(item);
  }
  const computeIslands: IslandSpec[] = [
    {
      id: "island:lambda", title: "Serverless compute", region: "compute",
      caption: ["HTTP, WebSocket, event and AgentCore tool functions. VPC-attached functions remain on their subnet terraces.", "A tool runs wherever the agents that list it run."],
      bands: [{ id: "band:lambda", title: "Serverless compute", caption: [], h: 3, groups: lambdaGroups.filter((group) => group.length > 0) }],
    },
    ...(model.networks ?? []).map((network): IslandSpec => {
      const vpc = byVpc.get(network.id)!;
      const captions = networkCaptions(network);
      // Every VPC has the same fixtures under the same names; the qualifier tells them apart.
      const inVpc = `${network.name ?? network.id} VPC`;
      const vpcBuilt = mode === "prod" && network.builtInProd;
      return {
      id: `island:vpc:${network.id}`,
      title: `${network.name ?? network.id} · ${network.cidr}`,
      region: "network",
      ghost: mode === "dev" ? "blueprint" : undefined,
      propPresence: vpcBuilt ? "built" : "other",
      caption: [
        network ? `${network.zones} availability zones; a public, a private and an isolated subnet in each.` : "The application's network.",
        vpcBuilt
          ? "A production deployment builds it, because something is placed in it."
          : mode === "dev"
            ? "A development deployment builds no network. Locally, the egress guard holds each workload to its subnet's rules."
            : "Nothing is placed in it, so a production deployment does not build it.",
      ],
      bands: [
        {
          id: `band:vpc:${network.id}:public`,
          title: "Public subnet",
          caption: captions.public,
          h: VPC_HEIGHT,
          groups: [vpc.public],
          perColumn: Math.min(6, Math.max(2, vpc.public.length, vpc.private.length, vpc.isolated.length)),
          props: [{ id: `prop:vpc:${network.id}:internet-gateway`, icon: "internetGateway", label: "Internet gateway", kindLabel: inVpc, caption: ["IPv4 and IPv6 between the public subnets and the internet."], serves: [`band:vpc:${network.id}:public`] }],
        },
        {
          id: `band:vpc:${network.id}:private`,
          title: "Private subnet",
          caption: captions.private,
          h: VPC_HEIGHT,
          groups: [vpc.private],
          perColumn: Math.min(6, Math.max(2, vpc.public.length, vpc.private.length, vpc.isolated.length)),
          props: [
            ...(network?.egressOnlyInternetGateway
              ? [{ id: `prop:vpc:${network.id}:egress-only-gateway`, icon: "internetGateway" as const, label: "Egress-only gateway", kindLabel: inVpc, caption: ["IPv6 out of the private subnets, never in. Free."], serves: [`band:vpc:${network.id}:private`] }]
              : []),
            ...(network?.natGateway
              ? [{ id: `prop:vpc:${network.id}:nat-gateway`, icon: "natGateway" as const, label: "NAT gateway", kindLabel: inVpc, caption: [`IPv4 out of the private subnets, about $${network.monthlyCost.natGateway.toFixed(2)} a month.`], serves: [`band:vpc:${network.id}:private`] }]
              : []),
          ],
        },
        {
          id: `band:vpc:${network.id}:isolated`,
          title: "Isolated subnet",
          caption: [...captions.isolated, ...(network.id === model.databaseNetworkId && localServices.length ? ["Local PostgreSQL stands beside RDS as its development counterpart. It runs in Compose on your machine, not in AWS."] : [])],
          h: VPC_HEIGHT,
          groups: [vpc.isolated],
          perColumn: Math.min(6, Math.max(2, vpc.public.length, vpc.private.length, vpc.isolated.length)),
          props: captions.endpoints.map((endpoint) => ({
            id: `prop:vpc:${network.id}:endpoint:${endpoint}`,
            icon: "endpoint" as const,
            roleIcon: endpointServiceIcon(endpoint),
            serviceIcon: endpointServiceDetails(endpoint).icon,
            label: `${endpoint} endpoint`,
            kindLabel: `${network?.gatewayEndpoints.includes(endpoint) ? "Gateway" : "Interface"} endpoint, ${inVpc}`,
            caption: [
              network?.gatewayEndpoints.includes(endpoint)
                ? `Gateway endpoint for ${endpoint}, on every route table. Free.`
                : `Interface endpoint for ${endpoint}, reachable from every subnet over IPv4.`,
            ],
            serves: [`band:vpc:${network.id}:public`, `band:vpc:${network.id}:private`, `band:vpc:${network.id}:isolated`],
          })),
        },
      ],
    };
    }),
    {
      id: "island:agentcore",
      title: "Agents",
      region: "agents",
      caption: ["Agents on AgentCore Runtime, outside the VPC. The tool Lambdas their Gateway calls stand on Serverless compute."],
      bands: [{ id: "band:agentcore", title: "Agents", caption: [], h: 3, groups: [agents] }],
    },
    {
      id: "island:orchestration",
      title: "Workflows",
      region: "orchestration",
      caption: ["Workflow graphs: state machines in a deployment, and the same graph run by the local interpreter under Compose."],
      bands: [{ id: "band:orchestration", title: "Workflows", caption: [], h: 4, groups: [workflows] }],
    },
  ];
  const compute = computeIslands.filter((island) => island.region === "network" || island.bands.some((band) => band.groups.some((group) => group.length > 0)));

  // Catalog stacks share an island; their public fields stay in the inspector.
  // An input group is one building too: its entries fold into it, and its connections leave from it.
  const groupItem = (group: ModelResource): Item => {
    const entries = groupEntries(group, model.resources);
    const graph = mode === "dev" ? "development" : "production";
    const absent = entries.filter((entry) => entry.absent).length;
    return { ...catalogItem(group), kindLabel: `Input group, ${entryCount(entries)}`,
      presenceText: group.absent ? `Absent in the ${graph} graph: every entry is declared undefined here.`
        : absent ? `Holds ${entryCount(entries)}; ${absent} absent in the ${graph} graph.` : `Holds ${entryCount(entries)}, all held by the ${graph} graph.` };
  };
  const catalog: IslandSpec[] = [];
  const loose: Item[] = [];
  const stacks: Item[] = [];
  const environmentFiles: Item[] = [];
  for (const resource of model.resources) {
    if (resource.parent || standIns[resource.id]?.startsWith("gateway:")) continue;
    if (resource.clientEnvironment) {
      environmentFiles.push({ ...catalogItem(resource), presenceText: "Application environment file. Variables mapped from input parameters and stack outputs. Select to inspect the mappings." });
    } else if (resource.deploymentFile) {
      environmentFiles.push({ ...catalogItem(resource), badge: resource.deploymentFile.mode,
        presenceText: `${resource.deploymentFile.path}: framework inputs; ${resource.deploymentFile.exists ? "local file" : "not generated; open the file to generate it"}. Values stay outside the graph.` });
    } else if (resource.kind === "stack") {
      stacks.push({ ...catalogItem(resource), label: resource.stackClass ?? resource.path.join(".") });
    } else {
      loose.push(resource.kind === "group" ? groupItem(resource) : catalogItem(resource));
    }
  }
  if (stacks.length > 0) {
    catalog.push({
      id: "island:stacks",
      title: "Stacks",
      region: "catalog",
      caption: ["Application resource stacks. Select a stack to inspect its public fields and relationships."],
      bands: [{ id: "band:stacks", title: "Stacks", caption: [], h: 2, groups: [stacks] }],
    });
  }
  if (loose.length > 0) {
    catalog.push({
      id: "island:inputs",
      title: "Input parameters and secrets",
      region: "catalog",
      caption: ["Input parameters and secrets declared in framework-config/resources.ts. An input group stands as one building for its entries. Environment file links carry names and presence, never secret values."],
      bands: [{ id: "band:inputs", title: "Input parameters and secrets", caption: [], h: 1, groups: [loose] }],
    });
  }
  if (environmentFiles.length) catalog.push({ id: ENVIRONMENT_FILES_ISLAND, title: "Environment files", region: "catalog",
    caption: ["Framework input files and application environment mappings. Select an island entry to inspect its variables, sources and delivery. Values stay outside the graph."],
    bands: [{ id: "band:environment", title: "Environment files", caption: [], h: 1, groups: [environmentFiles] }] });
  return { entry, compute, catalog };
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

interface PlacedItem {
  readonly item: Item;
  /** Island-local lattice cell. */
  readonly lx: number;
  readonly ly: number;
  readonly band: number;
}

interface Footprint {
  readonly spec: IslandSpec;
  readonly width: number;
  readonly length: number;
  readonly bandWidths: readonly number[];
  readonly placed: readonly PlacedItem[];
  readonly furniture: readonly { readonly prop: NonNullable<BandSpec["props"]>[number]; readonly lx: number; readonly ly: number; readonly band: number }[];
}

function measure(spec: IslandSpec): Footprint {
  const placed: PlacedItem[] = [];
  const furniture: Footprint["furniture"][number][] = [];
  const bandWidths: number[] = [];
  const bands = spec.bands.map((band) => {
    // Roles retain their order, but share the lattice: a small service group
    // must not strand the rest of its column when declarations change.
    const items = band.groups.flat();
    const perColumn = band.perColumn ?? Math.min(6, Math.max(2, Math.ceil(Math.sqrt(items.length))));
    // Both compute and network fixtures wrap. Reserve distinct rows for each,
    // rather than letting endpoint count turn a subnet into a single long strip.
    const columns = Math.max(1, Math.ceil(items.length / perColumn), Math.ceil(Math.sqrt(band.props?.length ?? 0)));
    const rows = Math.ceil(items.length / columns);
    return { items, columns, rows, props: band.props ?? [], furnitureRows: Math.ceil((band.props?.length ?? 0) / columns) };
  });
  let x = 0;
  const computeRows = Math.max(0, ...bands.map(band => band.rows));
  const furnitureRows = Math.max(0, ...bands.map(band => band.furnitureRows));
  const rows = Math.max(1, computeRows + furnitureRows);
  bands.forEach((band, bandIndex) => {
    const itemColumns = Math.ceil(band.items.length / Math.max(1, band.rows));
    const insetX = Math.floor((band.columns - itemColumns) * STEP / 2);
    const insetY = Math.floor((computeRows - band.rows) * STEP / 2);
    band.items.forEach((item, index) => {
      placed.push({ item, lx: x + 1 + insetX + Math.floor(index / band.rows) * STEP, ly: 1 + insetY + index % band.rows * STEP, band: bandIndex });
    });
    band.props.forEach((prop, index) => {
      const row = Math.floor(index / band.columns), column = index % band.columns;
      const rowItems = Math.min(band.columns, band.props.length - row * band.columns);
      const gateway = prop.icon === "internetGateway" || prop.icon === "natGateway";
      furniture.push({ prop, band: bandIndex,
        lx: x + 1 + (gateway ? 0 : Math.floor((band.columns - rowItems) * STEP / 2)) + column * STEP,
        ly: gateway ? rows * STEP - 2 : computeRows * STEP + 2 + Math.floor((furnitureRows - band.furnitureRows) * STEP / 2) + row * STEP });
    });
    const width = band.columns * STEP;
    bandWidths.push(width);
    x += width;
  });
  return { spec, width: x, length: rows * STEP, bandWidths, placed, furniture };
}

export function buildScene(model: ModeModel, options: SceneOptions = {}): Scene {
  const specs = islandSpecs(model, options);
  // A badge describes both environments, independently of the graph being viewed.
  const badgeById = new Map<string, DeploymentBadgeKind | undefined>();
  const devModel = options.layoutModels?.find((item) => item.mode === "dev");
  const prodModel = options.layoutModels?.find((item) => item.mode === "prod");
  if (devModel && prodModel) {
    const devTargets = new Map(devModel.targets.map((target) => [target.ref, target]));
    const prodTargets = new Map(prodModel.targets.map((target) => [target.ref, target]));
    for (const id of new Set([...devTargets.keys(), ...prodTargets.keys()])) {
      const dev = devTargets.get(id), prod = prodTargets.get(id);
      badgeById.set(id, availabilityBadge({ dev: !!dev && (dev.lanes.local || dev.lanes.dev), prod: !!prod?.lanes.prod }));
    }
    for (const route of [...devModel.routes, ...prodModel.routes]) badgeById.set(route.id, badgeById.get(route.target));
  }
  const nodes: SceneNode[] = [];
  const props: Prop[] = [];
  const islands: Island[] = [];
  const tiles = new Map<string, Tile>();

  // The row packer places measured islands in the screen-aligned frame
  // (sx = gx - gy, sy = gx + gy); only this final step maps them to grid cells.
  const all = [...specs.entry, ...specs.compute, ...specs.catalog];
  const specsById = new Map(all.map((spec) => [spec.id, spec]));
  const measuredSpecs = new Map(all.map((spec) => [spec.id, measure(spec)]));
  const footprints = all.map((spec) => {
    const measured = measuredSpecs.get(spec.id)!;
    const width = measured.width + 2, length = measured.length + 2;
    let inset = 0;
    if (spec.region === "network") {
      const base = Math.min(...spec.bands.map((band) => band.h)) - THICKNESS;
      const top = Math.max(...spec.bands.map((band) => band.h));
      const frame = islandFrame({ ...spec, gx0: 0, gy0: 0, gx1: width, gy1: length, base, top, bands: [] }).bounds;
      // Reserve the visible foundation as well as terrain. Its measured overhang
      // becomes padding around the grid footprint; the island geometry stays intact.
      inset = Math.ceil(Math.max(0,
        (-length * TILE_WIDTH / 2 - frame.minX) / (TILE_WIDTH / 2),
        (frame.maxX - width * TILE_WIDTH / 2) / (TILE_WIDTH / 2),
        (-top * ELEVATION_STEP - frame.minY) / (TILE_HEIGHT / 2),
        (frame.maxY - ((width + length) * TILE_HEIGHT / 2 - base * ELEVATION_STEP)) / (TILE_HEIGHT / 2)));
    }
    const size = width + length + inset * 2;
    return { id: spec.id, title: spec.title, region: spec.region, size, inset,
      bounds: { minX: 0, maxX: size * TILE_WIDTH / 2, minY: -Math.max(...spec.bands.map((band) => band.h)) * ELEVATION_STEP - 54, maxY: size * TILE_HEIGHT / 2 + 16 } };
  });
  const insets = new Map(footprints.map((footprint) => [footprint.id, footprint.inset]));
  const anchors: LayoutAnchor[] = all.flatMap((spec) => {
    const footprint = measuredSpecs.get(spec.id)!, length = footprint.length + 2, inset = insets.get(spec.id)!;
    return footprint.placed.map(({ item, lx, ly, band }) => {
      const p = project({ x: length / 2 + inset + 1 + lx, y: -length / 2 + 1 + ly, h: spec.bands[band]!.h });
      const geometry = buildIconShape(p.x, p.y);
      return { id: item.id, island: spec.id, h: spec.bands[band]!.h + geometry.height / ELEVATION_STEP, ...geometry.top };
    });
  });
  const visibleMembers = new Set(anchors.map((anchor) => anchor.id));
  const members = drawnAs(model);
  const graph = extractLayoutGraph(anchors, topologyEdges(options.layoutModels ?? [model]), members);
  const layout = optimizeLayout(footprints, graph, options.layoutSettings);
  const { positions } = layout;
  for (const position of positions) {
    const spec = specsById.get(position.id)!;
    // Node slots and measured anchors must agree with the optimizer's input.
    const footprint = measuredSpecs.get(spec.id)!;
    const length = footprint.length + 2;
    const inset = insets.get(position.id)!;
    const top = Math.round(position.top + inset);
    let difference = Math.round(position.left + inset + length);
    if ((top + difference) % 2 !== 0) difference += 1;
    placeIsland(footprint, (top + difference) / 2, (top - difference) / 2);
  }

  function placeIsland(footprint: Footprint, gx0: number, gy0: number): void {
    const spec = footprint.spec;
    const allDisabled = footprint.placed.length > 0 && footprint.placed.every(({ item }) => item.presence !== "built" && item.presence !== "present");
    const ghost = spec.region === "network" ? spec.ghost : spec.ghost ?? (allDisabled ? "disabled" : undefined);
    // The lattice, with a one-cell rim around it.
    const islandWidth = footprint.width + 2;
    const islandLength = footprint.length + 2;
    const bandStarts: number[] = [];
    let bandX = 0;
    for (const bandWidth of footprint.bandWidths) {
      bandStarts.push(bandX);
      bandX += bandWidth;
    }
    const bandAt = (localX: number) => {
      // The rim belongs to the band beside it.
      const x = Math.min(Math.max(localX - 1, 0), footprint.width - 1);
      let index = 0;
      bandStarts.forEach((start, candidate) => {
        if (x >= start) index = candidate;
      });
      return index;
    };
    // Corners cut back by one straight chamfer each, so islands read as built decks.
    for (let lx = 0; lx < islandWidth; lx += 1) {
      for (let ly = 0; ly < islandLength; ly += 1) {
        if (chamfered(lx, ly, islandWidth, islandLength)) continue;
        const band = spec.bands[bandAt(lx)]!;
        const gx = gx0 + lx;
        const gy = gy0 + ly;
        tiles.set(`${gx},${gy}`, {
          gx,
          gy,
          h: band.h,
          island: spec.id,
          band: band.id,
        });
      }
    }
    for (const { item, lx, ly, band } of footprint.placed) {
      const gx = gx0 + 1 + lx;
      const gy = gy0 + 1 + ly;
      const h = spec.bands[band]!.h;
      const anchor = project({ x: gx, y: gy, h });
      nodes.push({ ...item, ...(badgeById.has(item.id) ? { badge: badgeById.get(item.id) } : {}), gx, gy, h, island: spec.id, band: spec.bands[band]!.id, geometry: buildIconShape(anchor.x, anchor.y, !!item.roleIcon, !!item.frameworkManaged && item.roleIcon !== "managed") });
    }
    // The measured fixture grid shares the same coordinates as terrain sizing.
    for (const { prop, lx, ly, band } of footprint.furniture) {
      const gx = gx0 + 1 + lx, gy = gy0 + 1 + ly, h = spec.bands[band]!.h;
      const anchor = project({ x: gx, y: gy, h });
      const roleIcon = prop.roleIcon ?? "managed";
      props.push({ ...prop, roleIcon, frameworkManaged: true, presence: spec.propPresence ?? (ghost ? "other" : "built"), gx, gy, h, geometry: buildIconShape(anchor.x, anchor.y, true, roleIcon !== "managed") });
    }
    const heights = spec.bands.map((band) => band.h);
    islands.push({
      id: spec.id,
      title: spec.title,
      region: spec.region,
      caption: spec.caption,
      ...(ghost ? { ghost } : {}),
      gx0,
      gy0,
      gx1: gx0 + islandWidth - 1,
      gy1: gy0 + islandLength - 1,
      base: Math.min(...heights) - THICKNESS,
      top: Math.max(...heights),
      bands: spec.bands.map((band, index) => ({
        id: band.id,
        title: band.title,
        caption: band.caption,
        h: band.h,
        gx0: gx0 + (index === 0 ? 0 : 1 + bandStarts[index]!),
        gx1: gx0 + (index === spec.bands.length - 1 ? islandWidth - 1 : bandStarts[index + 1]!),
        gx: gx0 + 1 + bandStarts[index]! + Math.floor(footprint.bandWidths[index]! / 2),
        gy: gy0 + islandLength - 1,
      })),
    });
  }

  // Retain the footprint lattice for bounds, counts and layout inspection.
  const finished = [...tiles.values()].sort((a, b) => a.gx + a.gy - (b.gx + b.gy) || a.h - b.h || a.gx - b.gx);
  nodes.sort((a, b) => a.gx + a.gy - (b.gx + b.gy) || a.h - b.h || a.gx - b.gx);

  const ids = new Set(nodes.map((node) => node.id));
  const representatives = drawnAs(model);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const resourceById = new Map(model.resources.map((resource) => [resource.id, resource]));
  const edges = aggregateConnections(model, options.layoutModels)
    .filter((edge) => ids.has(edge.from) && ids.has(edge.to))
    .map((edge) => ({ ...edge, category: edgeCategory(edge.edge) }))
    .map((edge): SceneEdge => ({ ...edge, style: connectionStyle(edge.edge, edge.category, nodeById.get(edge.from), resourceById.get(edge.edge.to)) }));

  const frames: SceneFrame[] = islands.filter((island) => island.region === "network").map((island) => ({ id: `frame:${island.id}`, kind: "network", members: [island.id], ghost: !!island.ghost, geometry: islandFrame(island) }));

  const islandBase = new Map(islands.map((island) => [island.id, island.base]));
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const tile of finished) {
    const centre = project({ x: tile.gx, y: tile.gy, h: tile.h });
    const floor = islandBase.get(tile.island)!;
    minX = Math.min(minX, centre.x - TILE_WIDTH / 2);
    maxX = Math.max(maxX, centre.x + TILE_WIDTH / 2);
    minY = Math.min(minY, centre.y - TILE_HEIGHT / 2);
    maxY = Math.max(maxY, centre.y + TILE_HEIGHT / 2 + (tile.h - floor) * ELEVATION_STEP);
  }
  for (const node of nodes) minY = Math.min(minY, node.geometry.top.y - 40);
  // The VPC foundation participates in Fit.
  for (const { geometry: { bounds } } of frames) {
    minX = Math.min(minX, bounds.minX);
    minY = Math.min(minY, bounds.minY);
    maxX = Math.max(maxX, bounds.maxX);
    maxY = Math.max(maxY, bounds.maxY);
  }
  // Island titles hang off each island's left flank.
  for (const island of islands) {
    const flank = project({ x: island.gx0, y: island.gy1 + 0.5, h: island.top });
    minX = Math.min(minX, flank.x - 32 - 260);
  }

  const byNode = new Map(nodes.map((node) => [node.id, node]));
  const routingAnchor = (id: string): LayoutAnchor => {
    const node = byNode.get(id)!;
    return { id, island: node.island, h: node.h + node.geometry.height / ELEVATION_STEP, ...node.geometry.top };
  };
  const routingLinks: LayoutLink[] = edges.map((edge) => ({ id: edge.id, category: edge.category, weight: edge.edge.provenance === "source" ? 1 : 2,
    from: routingAnchor(edge.from), to: routingAnchor(edge.to) }));
  const obstacles = [...layoutObstacles(footprints, positions), ...layoutLabels(footprints, positions, options.layoutSettings?.aspect), ...nodes.flatMap((node) => {
    const tile = project({ x: node.gx, y: node.gy, h: node.h });
    return [{ id: node.id, bounds: {
      minX: Math.min(...node.geometry.hull.filter((_, at) => at % 2 === 0)), maxX: Math.max(...node.geometry.hull.filter((_, at) => at % 2 === 0)),
      minY: Math.min(...node.geometry.hull.filter((_, at) => at % 2 !== 0)), maxY: Math.max(...node.geometry.hull.filter((_, at) => at % 2 !== 0)),
    } }, { id: node.id, bounds: {
      minX: tile.x - NODE_CAPTION.width / 2, maxX: tile.x + NODE_CAPTION.width / 2,
      minY: tile.y + NODE_CAPTION.offset - NODE_CAPTION.height, maxY: tile.y + NODE_CAPTION.offset,
    } }];
  })];
  const routes = routeConnections(routingLinks, obstacles);
  for (const route of Object.values(routes)) for (const point of route.points) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
  }

  return {
    mode: model.mode,
    representatives,
    frames,
    tiles: finished,
    islands: islands.map(island => ({ ...island, title: displayName(model, island.id, island.title) })),
    nodes: nodes.map(node => ({ ...node, label: displayName(model, node.id, node.label) })),
    props: props.map(prop => ({ ...prop, label: displayName(model, prop.id, prop.label) })),
    edges,
    bounds: Number.isFinite(minX) ? { minX, minY, maxX, maxY } : { minX: -100, minY: -100, maxX: 100, maxY: 100 },
    routes,
    layout: { ...layout, positions, footprints },
  };
}
