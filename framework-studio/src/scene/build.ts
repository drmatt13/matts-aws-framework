import type { Lanes, Mode, ModeModel, ModelEdge, ModelResource, ModelRoute, ModelTarget, NetworkModel, TargetKind } from "../../shared/model";
import { RELATION_CATEGORY, ROLE_LABEL, type EdgeCategory } from "../lookup";
import { endpointServiceIcon, resourceBadge, resourceIcon, routeIcon, targetIcon, type IconKey } from "../icons";
import { availabilityBadge, deploymentBadge, developmentLocation, environments, type Availability, type DeploymentBadgeKind } from "../deployment";
import { ELEVATION_STEP, TILE_HEIGHT, TILE_WIDTH, project } from "./iso";
import { buildIconShape, type Shape } from "./shapes";
import type { Bounds } from "./camera";
import { islandFrame, type SceneFrame } from "./frame";
import { layoutIslands, type IslandFootprint } from "./layout";
import { extractLayoutGraph, topologyEdges, type LayoutAnchor, type LayoutLink } from "./layout-graph";
import { optimizeLayout, type LayoutSettings, type LayoutResult } from "./layout-optimize";
import { layoutLabels, layoutObstacles } from "./layout-quality";
import { connectionStyle, type ConnectionStyle } from "./connections";
import { routeConnections, legacyRoute, type ConnectionRoutes } from "./routing";
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

/**
 * What the selected graph holds of an entity.
 *
 * - built: enabled in the selected environment (development can execute locally).
 * - other: enabled only in the other environment.
 * - nowhere: it runs in no lane at all.
 * - absent: a catalog entry this graph declares `undefined`.
 * - present: a catalog entry this graph holds (inputs and constructs have no lane).
 */
export type Presence = "built" | "other" | "nowhere" | "absent" | "present";

export type Region = "entry" | "compute" | "network" | "agents" | "orchestration" | "catalog";

export interface Tile {
  readonly gx: number;
  readonly gy: number;
  readonly h: number;
  readonly island: string;
  readonly band?: string;
}

export interface Band {
  readonly id: string;
  readonly title: string;
  readonly caption: readonly string[];
  readonly h: number;
  /** The band's columns, inclusive grid cells; the island's rim belongs to the band beside it. */
  readonly gx0: number;
  readonly gx1: number;
  /** Where the band's name is painted: the middle of its front rim. */
  readonly gx: number;
  readonly gy: number;
}

export interface Island {
  readonly id: string;
  readonly title: string;
  readonly region: Region;
  readonly caption: readonly string[];
  /** Drawn faded: an unbuilt network, or an island with no enabled nodes. */
  readonly ghost?: "absent" | "blueprint" | "disabled";
  readonly gx0: number;
  readonly gy0: number;
  readonly gx1: number;
  readonly gy1: number;
  readonly base: number;
  readonly top: number;
  readonly bands: readonly Band[];
}

export interface SceneNode {
  readonly badge?: DeploymentBadgeKind;
  readonly icon: IconKey;
  readonly roleIcon?: IconKey;
  readonly id: string;
  readonly entity: "route" | "target" | "resource" | "local";
  readonly gx: number;
  readonly gy: number;
  readonly h: number;
  readonly label: string;
  readonly kindLabel: string;
  readonly presence: Presence;
  readonly presenceText: string;
  readonly lanes?: Lanes;
  readonly auth?: boolean;
  /** What a workload is (Lambda, container service or task, workflow, agent); absent on routes, resources and local services. */
  readonly targetKind?: TargetKind;
  readonly island: string;
  /** The band it stands on: on the VPC, its subnet. */
  readonly band: string;
  readonly geometry: Shape;
}

/** Network fixtures use stable prop IDs for selection and authored descriptions. */
export interface Prop {
  readonly id: string;
  readonly icon: IconKey;
  readonly roleIcon?: IconKey;
  readonly gx: number;
  readonly gy: number;
  readonly h: number;
  readonly label: string;
  readonly caption: readonly string[];
  readonly geometry: Shape;
  /** Gateways and endpoints follow whether this graph builds their VPC. */
  readonly presence: "built" | "other";
  /** The subnet bands whose traffic it carries, so selecting a building there keeps it lit. */
  readonly serves: readonly string[];
}

export interface SceneEdge {
  readonly edge: ModelEdge;
  /** Visible endpoints; stack fields connect to their owning stack. Evidence keeps the original edge. */
  readonly from: string;
  readonly to: string;
  readonly category: EdgeCategory;
  /** Colour and dash; presentation only, decided in `connections.ts`. */
  readonly style: ConnectionStyle;
}

export interface Scene {
  readonly mode: Mode;
  readonly representatives: Readonly<Record<string, string>>;
  readonly frames: readonly SceneFrame[];
  /** Every tile, in painter's order. */
  readonly tiles: readonly Tile[];
  readonly islands: readonly Island[];
  /** Every building, in painter's order. */
  readonly nodes: readonly SceneNode[];
  readonly props: readonly Prop[];
  readonly edges: readonly SceneEdge[];
  readonly bounds: Bounds;
  readonly routes: ConnectionRoutes;
  readonly layout: LayoutResult & { readonly footprints: readonly IslandFootprint[] };
}

export interface SceneOptions {
  readonly layoutSettings?: LayoutSettings;
  readonly layoutModels?: readonly ModeModel[];
  /** Baseline retained for measured comparisons and deterministic fallback. */
  readonly semanticLayout?: boolean;
  readonly resourceAvailability?: Readonly<Record<string, Availability>>;
  /** Whether this deployment builds the AWS WebSocket API (DEPLOY_PROD_WEBSOCKET_API). */
  readonly webSocketApi?: boolean;
  /** Catalog facts from the source index: the condition an entry is declared under. */
  readonly conditions?: Readonly<Record<string, string | undefined>>;
}

// ---------------------------------------------------------------------------
// Layout constants, in grid cells
// ---------------------------------------------------------------------------

/** Buildings stand every third cell, so every label card has its own space. */
const STEP = 3;
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
  readonly bands: readonly BandSpec[];
}

function targetItem(target: ModelTarget, mode: Mode): Item {
  const { presence, text } = targetPresence(target.lanes, mode);
  const base = {
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

function routeItem(route: ModelRoute, target: ModelTarget | undefined, mode: Mode): Item {
  const presence = target ? targetPresence(target.lanes, mode) : { presence: "nowhere" as const, text: "Its target is not in this graph." };
  const kindLabel =
    route.kind === "http" ? "HTTP route" : route.kind === "service" ? "Service mount" : route.kind === "webSocket" ? "WebSocket route key" : "Agent route";
  return {
    id: route.id,
    badge: target ? deploymentBadge(target.lanes) : undefined,
    icon: routeIcon(route),
    roleIcon: route.kind === "webSocket" ? "webSocket" : route.kind === "agent" ? "agent" : undefined,
    entity: "route",
    label: route.kind === "webSocket" ? route.path : route.browserPath ?? route.path,
    kindLabel,
    presence: presence.presence,
    presenceText: `Follows ${target?.id ?? route.target}: ${presence.text.charAt(0).toLowerCase()}${presence.text.slice(1)}`,
    ...(route.auth ? { auth: true } : {}),
  };
}

function resourceItem(resource: ModelResource, mode: Mode, availability?: Availability): Item {
  const name = resource.path[resource.path.length - 1]!;
  const kindLabel =
    resource.deploymentFile ? `CDK ${resource.deploymentFile.mode === "dev" ? "development" : "production"} environment file` : resource.kind === "stack"
      ? `Stack, ${resource.stackClass ?? "stack"}`
      : resource.kind === "member"
        ? `Stack member, ${resource.typeText ?? "unknown type"}`
        : resource.kind === "secret"
          ? `Secret, ${resource.fromEnv ?? ""}`
          : resource.kind === "input"
            ? `Input, ${resource.fromEnv ?? ""}`
            : resource.kind === "group"
              ? "Group of inputs"
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
    roleIcon: resourceBadge(resource),
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
  const catalogItem = (resource: ModelResource) => resourceItem(resource, mode, options.resourceAvailability?.[resource.id]);
  const targets = new Map(model.targets.map((target) => [target.ref, target]));
  // Entry points, by the gateway that serves them.
  const routes = (kinds: readonly ModelRoute["kind"][]) =>
    model.routes.filter((route) => kinds.includes(route.kind)).map((route) => routeItem(route, targets.get(route.target), mode));
  const apiGroups = [routes(["http", "service"]), routes(["webSocket"]), routes(["agent"])].filter((group) => group.length > 0);
  const entry: IslandSpec[] = apiGroups.length ? [{
    id: "island:apis", title: "APIs", region: "entry",
    caption: ["HTTP routes, WebSocket route keys and agent browser paths. Select a route to inspect its protocol and target."],
    bands: [{ id: "band:apis", title: "APIs", caption: [], h: 2, groups: apiGroups }],
  }] : [];

  // Compute, by where it runs.
  // HTTP, WebSocket, event and AgentCore tool functions, a column group each.
  const lambdaGroups: Item[][] = [[], [], [], []];
  const vpc: Record<"public" | "private" | "isolated", Item[]> = { public: [], private: [], isolated: [] };
  const agents: Item[] = [];
  const workflows: Item[] = [];
  for (const resource of model.resources) {
    if (resource.kind === "member" && resource.frameworkManaged === "database" && resource.networkPlacement) {
      vpc[resource.networkPlacement].push({ ...catalogItem(resource), label: "RDS database", kindLabel: "Framework-managed Amazon RDS" });
    }
  }
  // The local database stands beside RDS, as its development counterpart: workloads bind to one or the other.
  const localServices = model.localServices ?? [];
  vpc.isolated.push(...localServices.map((service): Item => ({
    id: service.id, entity: "local", icon: "postgres", label: service.title,
    kindLabel: "Compose database", badge: "dev", presence: service.enabled ? "built" : "other",
    presenceText: service.enabled ? "Development database, declared in docker-compose.yml. Container status is not monitored." : "Used during development on your machine.",
  })));
  for (const target of model.targets) {
    const item = targetItem(target, mode);
    if (target.placement.kind === "vpc") vpc[target.placement.subnet].push(item);
    else if (target.kind === "workflow") workflows.push(item);
    else if (target.kind === "agent") agents.push(item);
    else if (target.role === "tool") lambdaGroups[3]!.push(item);
    else if (target.role === "event") lambdaGroups[2]!.push(item);
    else if (target.role === "webSocket" || target.role === "webSocketAuthorizer") lambdaGroups[1]!.push(item);
    else lambdaGroups[0]!.push(item);
  }
  const captions = networkCaptions(model.network);
  const vpcBuilt = mode === "prod" && model.network?.builtInProd === true;
  const network = model.network;
  const computeIslands: IslandSpec[] = [
    {
      id: "island:lambda", title: "Serverless compute", region: "compute",
      caption: ["HTTP, WebSocket, event and AgentCore tool functions. VPC-attached functions remain on their subnet terraces.", "A tool runs wherever the agents that list it run."],
      bands: [{ id: "band:lambda", title: "Serverless compute", caption: [], h: 3, groups: lambdaGroups.filter((group) => group.length > 0) }],
    },
    {
      id: "island:vpc",
      title: network ? `VPC ${network.cidr}` : "VPC",
      region: "network",
      ghost: vpcBuilt ? undefined : "blueprint",
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
          id: "band:public",
          title: "Public subnet",
          caption: captions.public,
          h: VPC_HEIGHT,
          groups: [vpc.public],
          perColumn: Math.min(6, Math.max(2, vpc.public.length, vpc.private.length, vpc.isolated.length)),
          props: [{ id: "prop:internet-gateway", icon: "internetGateway", label: "Internet gateway", caption: ["IPv4 and IPv6 between the public subnets and the internet."], serves: ["band:public"] }],
        },
        {
          id: "band:private",
          title: "Private subnet",
          caption: captions.private,
          h: VPC_HEIGHT,
          groups: [vpc.private],
          perColumn: Math.min(6, Math.max(2, vpc.public.length, vpc.private.length, vpc.isolated.length)),
          props: [
            ...(network?.egressOnlyInternetGateway
              ? [{ id: "prop:egress-only-gateway", icon: "internetGateway" as const, label: "Egress-only gateway", caption: ["IPv6 out of the private subnets, never in. Free."], serves: ["band:private"] }]
              : []),
            ...(network?.natGateway
              ? [{ id: "prop:nat-gateway", icon: "natGateway" as const, label: "NAT gateway", caption: [`IPv4 out of the private subnets, about $${network.monthlyCost.natGateway.toFixed(2)} a month.`], serves: ["band:private"] }]
              : []),
          ],
        },
        {
          id: "band:isolated",
          title: "Isolated subnet",
          caption: [...captions.isolated, ...(localServices.length ? ["Local PostgreSQL stands beside RDS as its development counterpart. It runs in Compose on your machine, not in AWS."] : [])],
          h: VPC_HEIGHT,
          groups: [vpc.isolated],
          perColumn: Math.min(6, Math.max(2, vpc.public.length, vpc.private.length, vpc.isolated.length)),
          props: captions.endpoints.map((endpoint) => ({
            id: `prop:endpoint:${endpoint}`,
            icon: "endpoint" as const,
            roleIcon: endpointServiceIcon(endpoint),
            label: `${endpoint} endpoint`,
            caption: [
              network?.gatewayEndpoints.includes(endpoint)
                ? `Gateway endpoint for ${endpoint}, on every route table. Free.`
                : `Interface endpoint for ${endpoint}, reachable from every subnet over IPv4.`,
            ],
            serves: ["band:public", "band:private", "band:isolated"],
          })),
        },
      ],
    },
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
  const children = new Map<string, ModelResource[]>();
  for (const resource of model.resources) {
    if (resource.parent) children.set(resource.parent, [...(children.get(resource.parent) ?? []), resource]);
  }
  const catalog: IslandSpec[] = [];
  const loose: Item[][] = [];
  const stacks: Item[] = [];
  const environmentFiles: Item[] = [];
  for (const resource of model.resources) {
    if (resource.parent) continue;
    if (resource.deploymentFile) {
      environmentFiles.push({ ...catalogItem(resource), badge: resource.deploymentFile.mode,
        presenceText: `${resource.deploymentFile.path}: ${resource.deploymentFile.exists ? "local file" : "not created"}. Values stay outside the graph.` });
    } else if (resource.kind === "stack") {
      stacks.push({ ...catalogItem(resource), label: resource.stackClass ?? resource.path.join(".") });
    } else if (resource.kind === "group") {
      loose.push([catalogItem(resource), ...(children.get(resource.id) ?? []).map(catalogItem)]);
    } else {
      loose.push([catalogItem(resource)]);
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
    // Single entries share a column; a group keeps its own.
    const singles = loose.filter((group) => group.length === 1).flat();
    const groups = loose.filter((group) => group.length > 1);
    catalog.push({
      id: "island:inputs",
      title: "Input parameters and secrets",
      region: "catalog",
      caption: ["Input parameters and secrets declared in framework-config/resources.ts. Environment file links carry names and presence, never secret values."],
      bands: [{ id: "band:inputs", title: "Input parameters and secrets", caption: [], h: 1, groups: [singles, ...groups].filter((group) => group.length > 0) }],
    });
  }
  if (environmentFiles.length) catalog.push({ id: "island:environment", title: "CDK environment files", region: "catalog",
    caption: ["Separate development and production inputs. Select a file to edit or add environment variables in a draft. Values stay outside the graph."],
    bands: [{ id: "band:environment", title: "CDK environment files", caption: [], h: 1, groups: [environmentFiles] }] });
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
}

function measure(spec: IslandSpec, order?: (items: readonly Item[]) => readonly Item[]): Footprint {
  const placed: PlacedItem[] = [];
  const bandWidths: number[] = [];
  const bands = spec.bands.map((band) => {
    // Roles retain their order, but share the lattice: a small service group
    // must not strand the rest of its column when declarations change.
    const items = band.groups.flatMap((group) => order ? [...order(group)] : [...group]);
    const perColumn = band.perColumn ?? Math.min(6, Math.max(2, Math.ceil(Math.sqrt(items.length))));
    const columns = Math.max(1, Math.ceil(items.length / perColumn), band.props?.length ?? 0);
    const rows = Math.ceil(items.length / columns);
    return { items, columns, rows, furniture: !!band.props?.length };
  });
  let x = 0;
  const rows = Math.max(1, ...bands.map((band) => band.rows + Number(band.furniture)));
  bands.forEach((band, bandIndex) => {
    const itemColumns = Math.ceil(band.items.length / Math.max(1, band.rows));
    const insetX = Math.floor((band.columns - itemColumns) * STEP / 2);
    const insetY = Math.floor((rows - Number(band.furniture) - band.rows) * STEP / 2);
    band.items.forEach((item, index) => {
      placed.push({ item, lx: x + 1 + insetX + Math.floor(index / band.rows) * STEP, ly: 1 + insetY + index % band.rows * STEP, band: bandIndex });
    });
    const width = band.columns * STEP;
    bandWidths.push(width);
    x += width;
  });
  return { spec, width: x, length: rows * STEP, bandWidths, placed };
}

export function buildScene(model: ModeModel, options: SceneOptions = {}): Scene {
  const specs = islandSpecs(model, options);
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
  const baselineRows = new Map<string, number>();
  const baselineOrder = (items: readonly Item[]) => {
    const mean = (id: string) => {
      const rows = model.edges.flatMap((edge) => { const other = edge.from === id ? edge.to : edge.to === id ? edge.from : undefined; const y = other ? baselineRows.get(other) : undefined; return y === undefined ? [] : [y]; });
      return rows.length ? rows.reduce((sum, y) => sum + y, 0) / rows.length : Infinity;
    };
    return items.map((item, at) => ({ item, at, y: mean(item.id) })).sort((a, b) => a.y - b.y || a.at - b.at).map(({ item }) => item);
  };
  const anchors: LayoutAnchor[] = all.flatMap((spec) => {
    const footprint = measuredSpecs.get(spec.id)!, length = footprint.length + 2, inset = insets.get(spec.id)!;
    return footprint.placed.map(({ item, lx, ly, band }) => {
      const p = project({ x: length / 2 + inset + 1 + lx, y: -length / 2 + 1 + ly, h: spec.bands[band]!.h });
      return { id: item.id, island: spec.id, ...buildIconShape(p.x, p.y).top };
    });
  });
  const visibleMembers = new Set(anchors.map((anchor) => anchor.id));
  const members = Object.fromEntries(model.resources.filter((resource) => resource.kind === "member" && resource.parent && !visibleMembers.has(resource.id)).map((resource) => [resource.id, resource.parent!]));
  const graph = extractLayoutGraph(anchors, topologyEdges(options.layoutModels ?? [model]), members);
  const layout = optimizeLayout(footprints, graph, { ...options.layoutSettings, ...(options.semanticLayout ? { budget: 1 } : {}) });
  const positions = options.semanticLayout ? layoutIslands(footprints) : layout.positions;
  for (const position of positions) {
    const spec = specsById.get(position.id)!;
    // Node slots and measured anchors must agree with the optimizer's input.
    const footprint = options.semanticLayout && (spec.region === "entry" || spec.region === "catalog") ? measure(spec, baselineOrder) : measuredSpecs.get(spec.id)!;
    const width = footprint.width + 2, length = footprint.length + 2;
    const inset = insets.get(position.id)!;
    const top = Math.round(position.top + inset);
    let difference = Math.round(position.left + inset + length);
    if ((top + difference) % 2 !== 0) difference += 1;
    placeIsland(footprint, (top + difference) / 2, (top - difference) / 2);
  }

  function placeIsland(footprint: Footprint, gx0: number, gy0: number): void {
    const spec = footprint.spec;
    const allDisabled = footprint.placed.length > 0 && footprint.placed.every(({ item }) => item.presence !== "built" && item.presence !== "present");
    const ghost = spec.ghost ?? (allDisabled ? "disabled" : undefined);
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
      nodes.push({ ...item, gx, gy, h, island: spec.id, band: spec.bands[band]!.id, geometry: buildIconShape(anchor.x, anchor.y, !!item.roleIcon) });
      if (options.semanticLayout) baselineRows.set(item.id, gx + gy);
    }
    // Furniture stands on the last lattice row, clear of the buildings and the chamfers.
    spec.bands.forEach((band, index) => {
      (band.props ?? []).forEach((prop, position) => {
        const gx = gx0 + 2 + bandStarts[index]! + position * STEP;
        const gy = gy0 + footprint.length - 1;
        const anchor = project({ x: gx, y: gy, h: band.h });
        props.push({ ...prop, presence: ghost ? "other" : "built", gx, gy, h: band.h, geometry: buildIconShape(anchor.x, anchor.y, !!prop.roleIcon) });
      });
    });
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
  const representatives = Object.fromEntries(model.resources.filter((resource) => resource.kind === "member" && resource.parent && !ids.has(resource.id) && ids.has(resource.parent)).map((resource) => [resource.id, resource.parent!]));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const resourceById = new Map(model.resources.map((resource) => [resource.id, resource]));
  const edges = model.edges
    .map((edge) => ({ edge, from: representatives[edge.from] ?? edge.from, to: representatives[edge.to] ?? edge.to, category: RELATION_CATEGORY[edge.relation] }))
    .filter((edge) => ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to)
    // What an edge references decides its style, even when the map draws a stack field as its owning stack.
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
  const routingLinks: LayoutLink[] = edges.map((edge) => ({ id: edge.edge.id, category: edge.category, weight: edge.edge.provenance === "source" ? 1 : 2,
    from: { id: edge.from, island: byNode.get(edge.from)!.island, ...byNode.get(edge.from)!.geometry.top },
    to: { id: edge.to, island: byNode.get(edge.to)!.island, ...byNode.get(edge.to)!.geometry.top } }));
  const obstacles = [...layoutObstacles(footprints, positions), ...layoutLabels(footprints, positions, options.layoutSettings?.aspect), ...nodes.map((node) => ({ id: node.id, bounds: {
    minX: Math.min(...node.geometry.hull.filter((_, at) => at % 2 === 0)), maxX: Math.max(...node.geometry.hull.filter((_, at) => at % 2 === 0)),
    minY: Math.min(...node.geometry.hull.filter((_, at) => at % 2 !== 0)), maxY: Math.max(...node.geometry.hull.filter((_, at) => at % 2 !== 0)),
  } }))];
  const routes = options.semanticLayout ? Object.fromEntries(routingLinks.map((link) => [link.id, legacyRoute(link.from, link.to)])) : routeConnections(routingLinks, obstacles);
  for (const route of Object.values(routes)) for (const point of route.points) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
  }

  return {
    mode: model.mode,
    representatives,
    frames,
    tiles: finished,
    islands,
    nodes,
    props,
    edges,
    bounds: Number.isFinite(minX) ? { minX, minY, maxX, maxY } : { minX: -100, minY: -100, maxX: 100, maxY: 100 },
    routes,
    layout: { ...layout, positions, footprints },
  };
}
