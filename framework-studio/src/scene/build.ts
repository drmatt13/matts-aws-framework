import type { Lanes, Mode, ModeModel, ModelEdge, ModelResource, ModelRoute, ModelTarget, NetworkModel } from "../../shared/model";
import { RELATION_CATEGORY, ROLE_LABEL, type EdgeCategory } from "../lookup";
import { resourceIcon, routeIcon, targetIcon, type IconKey } from "../icons";
import { availabilityBadge, deploymentBadge, developmentLocation, environments, type Availability, type DeploymentBadgeKind } from "../deployment";
import { ELEVATION_STEP, TILE_HEIGHT, TILE_WIDTH, project } from "./iso";
import { buildIconShape, buildShape, lambdaGlyph, type Glyph, type Shape, type ShapeKind } from "./shapes";
import type { Bounds } from "./camera";

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
 * inside it, on AgentCore, or as a state machine); the catalog by the stack
 * that owns each entry. The VPC's terraces step down from public to isolated,
 * toward the catalog, and stand on their own: a subnet is a place, not a
 * permission.
 */

export type Material =
  | "limestone"
  | "basalt"
  | "quartz"
  | "circuit"
  | "moss"
  | "lichen"
  | "shale"
  | "copper"
  | "plum"
  | "granite"
  | "sand";

export const MATERIALS: readonly Material[] = [
  "limestone",
  "basalt",
  "quartz",
  "circuit",
  "moss",
  "lichen",
  "shale",
  "copper",
  "plum",
  "granite",
  "sand",
];

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
  readonly material: Material;
  readonly variant: number;
  readonly island: string;
  readonly band?: string;
  /** Where each front wall reaches down to, in elevation steps; absent when no wall shows. */
  readonly wallLeft?: number;
  readonly wallRight?: number;
  /** The tile sits on the island's rim, where its wall falls into the void. */
  readonly rimLeft: boolean;
  readonly rimRight: boolean;
}

export interface Band {
  readonly id: string;
  readonly title: string;
  readonly caption: readonly string[];
  readonly h: number;
  /** Where the band's name is painted: the middle of its front rim. */
  readonly gx: number;
  readonly gy: number;
}

export interface Island {
  readonly id: string;
  readonly title: string;
  readonly region: Region;
  readonly caption: readonly string[];
  /** Drawn faded: a catalog stack absent in this graph, or a network this graph does not build. */
  readonly ghost?: "absent" | "blueprint";
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
  readonly id: string;
  readonly entity: "route" | "target" | "resource";
  readonly shape: ShapeKind;
  readonly glyph?: Glyph;
  readonly gx: number;
  readonly gy: number;
  readonly h: number;
  readonly label: string;
  readonly kindLabel: string;
  readonly presence: Presence;
  readonly presenceText: string;
  readonly lanes?: Lanes;
  readonly auth?: boolean;
  readonly island: string;
  readonly geometry: Shape;
}

/** Network furniture: drawn and explained, never selected — the model has no entity for it. */
export interface Prop {
  readonly id: string;
  readonly shape: ShapeKind;
  readonly gx: number;
  readonly gy: number;
  readonly h: number;
  readonly label: string;
  readonly caption: readonly string[];
  readonly geometry: Shape;
}

/** Scenery: deterministic, meaningless, never picked. */
export interface Decoration {
  readonly gx: number;
  readonly gy: number;
  readonly h: number;
  readonly shape: ShapeKind;
  readonly geometry: Shape;
}

export interface SceneEdge {
  readonly edge: ModelEdge;
  readonly category: EdgeCategory;
}

export interface Scene {
  readonly mode: Mode;
  /** Every tile, in painter's order. */
  readonly tiles: readonly Tile[];
  readonly islands: readonly Island[];
  /** Every building, in painter's order. */
  readonly nodes: readonly SceneNode[];
  readonly props: readonly Prop[];
  readonly decorations: readonly Decoration[];
  readonly edges: readonly SceneEdge[];
  readonly bounds: Bounds;
}

export interface SceneOptions {
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
/** Between columns, and between islands in a column, in screen-aligned tile units. */
const COLUMN_GAP = 6;
const ISLAND_GAP = 5;
const THICKNESS = 3;

/** What grows on each ground, when anything does. */
const SCENERY: Readonly<Record<Material, ShapeKind>> = {
  limestone: "lamp",
  basalt: "lamp",
  quartz: "shard",
  circuit: "lamp",
  moss: "shrub",
  lichen: "shrub",
  shale: "rock",
  copper: "rock",
  plum: "shard",
  granite: "rock",
  sand: "rock",
};

function hash(...parts: readonly (string | number)[]): number {
  let value = 2166136261;
  for (const part of parts) {
    const text = String(part);
    for (let index = 0; index < text.length; index += 1) {
      value ^= text.charCodeAt(index);
      value = Math.imul(value, 16777619);
    }
    value ^= 0x9e3779b9;
  }
  return value >>> 0;
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
  readonly id: string;
  readonly entity: SceneNode["entity"];
  readonly shape: ShapeKind;
  readonly glyph?: Glyph;
  readonly label: string;
  readonly kindLabel: string;
  readonly presence: Presence;
  readonly presenceText: string;
  readonly lanes?: Lanes;
  readonly auth?: boolean;
}

interface BandSpec {
  readonly id: string;
  readonly title: string;
  readonly caption: readonly string[];
  readonly material: Material;
  readonly h: number;
  /** Each group starts a new column. */
  readonly groups: readonly (readonly Item[])[];
  /** Items per lattice column. Defaults to about the square root of the band's items, so islands come out near square. */
  readonly perColumn?: number;
  readonly props?: readonly Omit<Prop, "gx" | "gy" | "h" | "geometry">[];
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
  };
  switch (target.kind) {
    case "lambda":
      return { ...base, shape: "lambda", glyph: lambdaGlyph(target.role) };
    case "service":
      return { ...base, shape: "service" };
    case "task":
      return { ...base, shape: "task" };
    case "workflow":
      return { ...base, shape: "workflow" };
    case "agent":
      return { ...base, shape: "agent" };
  }
}

function routeItem(route: ModelRoute, target: ModelTarget | undefined, mode: Mode): Item {
  const presence = target ? targetPresence(target.lanes, mode) : { presence: "nowhere" as const, text: "Its target is not in this graph." };
  const shape: ShapeKind = route.kind === "service" ? "mount" : route.kind === "webSocket" ? "pylon" : route.kind === "agent" ? "portal" : "gate";
  const kindLabel =
    route.kind === "http" ? "HTTP route" : route.kind === "service" ? "Service mount" : route.kind === "webSocket" ? "WebSocket route key" : "Agent route";
  return {
    id: route.id,
    badge: target ? deploymentBadge(target.lanes) : undefined,
    icon: routeIcon(route),
    entity: "route",
    shape,
    label: route.kind === "webSocket" ? route.path : route.browserPath ?? route.path,
    kindLabel,
    presence: presence.presence,
    presenceText: `Follows ${target?.id ?? route.target}: ${presence.text.charAt(0).toLowerCase()}${presence.text.slice(1)}`,
    ...(route.auth ? { auth: true } : {}),
  };
}

/** The building a catalog entry is drawn as, from what its declaration says it holds. */
export function resourceShape(resource: ModelResource): ShapeKind {
  switch (resource.kind) {
    case "stack":
      return "stack";
    case "group":
      return "group";
    case "secret":
      return "secret";
    case "input":
      return "input";
    case "construct":
      return "construct";
    case "member": {
      const type = resource.typeText ?? "";
      if (/UserPool/.test(type)) return "userpool";
      if (/Table/.test(type)) return "table";
      if (/Bucket/.test(type)) return "bucket";
      if (/Queue/.test(type)) return "queue";
      if (/Topic/.test(type)) return "topic";
      if (/EventBus/.test(type)) return "bus";
      if (/Database|Cluster/.test(type)) return "database";
      if (/Secret/.test(type)) return "secret";
      if (type === "string") return "value";
      return "construct";
    }
  }
}

function resourceItem(resource: ModelResource, mode: Mode, availability?: Availability): Item {
  const name = resource.path[resource.path.length - 1]!;
  const kindLabel =
    resource.kind === "stack"
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
  return {
    id: resource.id,
    badge: availability ? availabilityBadge(availability) : undefined,
    icon: resourceIcon(resource),
    entity: "resource",
    shape: resourceShape(resource),
    label: resource.kind === "stack" ? resource.path.join(".") : name,
    kindLabel,
    presence: resource.absent ? "absent" : "present",
    presenceText: resource.absent
      ? `Absent in the ${graph} graph: declared undefined here, so nothing that reads it sees a value.`
      : resource.kind === "member" && resource.memberSource === "class"
        ? "Declared by its stack; no workload references it."
        : `Held by the ${graph} graph.`,
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
  const graph = mode === "dev" ? "development" : "production";

  // Entry points, by the gateway that serves them.
  const routes = (kinds: readonly ModelRoute["kind"][]) =>
    model.routes.filter((route) => kinds.includes(route.kind)).map((route) => routeItem(route, targets.get(route.target), mode));
  const entryIslands: IslandSpec[] = [
    {
      id: "island:http-api",
      title: "HTTP API",
      region: "entry",
      caption: [
        "Routes and service mounts, served under /api.",
        mode === "prod"
          ? "A production deployment serves them through API Gateway's HTTP API, behind CloudFront."
          : "A development deployment builds no HTTP API; the local API dev server serves these paths.",
      ],
      bands: [{ id: "band:http-api", title: "HTTP API", caption: [], material: "limestone", h: 2, groups: [routes(["http", "service"])] }],
    },
    {
      id: "island:websocket-api",
      title: "WebSocket API",
      region: "entry",
      caption: [
        "API Gateway route keys.",
        options.webSocketApi
          ? "DEPLOY_PROD_WEBSOCKET_API is on: AWS builds this API, so both graphs hold its handlers."
          : "DEPLOY_PROD_WEBSOCKET_API is off: the local WebSocket dev server serves these keys.",
      ],
      bands: [{ id: "band:websocket-api", title: "WebSocket API", caption: [], material: "basalt", h: 2, groups: [routes(["webSocket"])] }],
    },
    {
      id: "island:agent-routes",
      title: "Agent routes",
      region: "entry",
      caption: ["Exact same-origin browser paths that reach an agent: CloudFront in a deployment, the development proxy locally."],
      bands: [{ id: "band:agent-routes", title: "Agent routes", caption: [], material: "quartz", h: 2, groups: [routes(["agent"])] }],
    },
  ];
  const entry = entryIslands.filter((island) => island.bands[0]!.groups[0]!.length > 0);

  // Compute, by where it runs.
  const lambdaGroups: Item[][] = [[], [], []];
  const vpc: Record<"public" | "private" | "isolated", Item[]> = { public: [], private: [], isolated: [] };
  const agents: Item[] = [];
  const workflows: Item[] = [];
  for (const target of model.targets) {
    const item = targetItem(target, mode);
    if (target.placement.kind === "vpc") vpc[target.placement.subnet].push(item);
    else if (target.kind === "workflow") workflows.push(item);
    else if (target.kind === "agent" || target.role === "tool") agents.push(item);
    else if (target.role === "event") lambdaGroups[2]!.push(item);
    else if (target.role === "webSocket" || target.role === "webSocketAuthorizer") lambdaGroups[1]!.push(item);
    else lambdaGroups[0]!.push(item);
  }
  const captions = networkCaptions(model.network);
  const vpcBuilt = mode === "prod" && model.network?.builtInProd === true;
  const network = model.network;
  const computeIslands: IslandSpec[] = [
    {
      id: "island:lambda",
      title: "Lambda, outside the VPC",
      region: "compute",
      caption: [
        "Serverless functions in no subnet: they reach the internet and AWS directly.",
        "Outside the VPC says nothing about who can call one; its routes and grants do.",
      ],
      bands: [{ id: "band:lambda", title: "Lambda", caption: [], material: "circuit", h: 3, groups: lambdaGroups.filter((group) => group.length > 0) }],
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
          material: "moss",
          h: 5,
          groups: [vpc.public],
          perColumn: Math.min(6, Math.max(2, vpc.public.length, vpc.private.length, vpc.isolated.length)),
          props: [{ id: "prop:internet-gateway", shape: "pylon", label: "Internet gateway", caption: ["IPv4 and IPv6 between the public subnets and the internet."] }],
        },
        {
          id: "band:private",
          title: "Private subnet",
          caption: captions.private,
          material: "lichen",
          h: 4,
          groups: [vpc.private],
          perColumn: Math.min(6, Math.max(2, vpc.public.length, vpc.private.length, vpc.isolated.length)),
          props: [
            ...(network?.egressOnlyInternetGateway
              ? [{ id: "prop:egress-only-gateway", shape: "pylon" as const, label: "Egress-only gateway", caption: ["IPv6 out of the private subnets, never in. Free."] }]
              : []),
            ...(network?.natGateway
              ? [{ id: "prop:nat-gateway", shape: "construct" as const, label: "NAT gateway", caption: [`IPv4 out of the private subnets, about $${network.monthlyCost.natGateway.toFixed(2)} a month.`] }]
              : []),
          ],
        },
        {
          id: "band:isolated",
          title: "Isolated subnet",
          caption: captions.isolated,
          material: "shale",
          h: 3,
          groups: [vpc.isolated],
          perColumn: Math.min(6, Math.max(2, vpc.public.length, vpc.private.length, vpc.isolated.length)),
          props: captions.endpoints.slice(0, 4).map((endpoint) => ({
            id: `prop:endpoint:${endpoint}`,
            shape: "input" as const,
            label: `${endpoint} endpoint`,
            caption: [
              network?.gatewayEndpoints.includes(endpoint)
                ? `Gateway endpoint for ${endpoint}, on every route table. Free.`
                : `Interface endpoint for ${endpoint}, reachable from every subnet over IPv4.`,
            ],
          })),
        },
      ],
    },
    {
      id: "island:agentcore",
      title: "AgentCore",
      region: "agents",
      caption: ["Agents on AgentCore Runtime, outside the VPC, and the tool Lambdas their Gateway calls.", "A tool runs wherever the agents that list it run."],
      bands: [{ id: "band:agentcore", title: "AgentCore", caption: [], material: "plum", h: 3, groups: [agents] }],
    },
    {
      id: "island:orchestration",
      title: "Step Functions",
      region: "orchestration",
      caption: ["Workflow graphs: state machines in a deployment, and the same graph run by the local interpreter under Compose."],
      bands: [{ id: "band:orchestration", title: "Step Functions", caption: [], material: "copper", h: 4, groups: [workflows] }],
    },
  ];
  const compute = computeIslands.filter((island) => island.id === "island:vpc" || island.bands.some((band) => band.groups.some((group) => group.length > 0)));

  // The catalog: a stack is an island, its members stand on it.
  const children = new Map<string, ModelResource[]>();
  for (const resource of model.resources) {
    if (resource.parent) children.set(resource.parent, [...(children.get(resource.parent) ?? []), resource]);
  }
  const catalog: IslandSpec[] = [];
  const loose: Item[][] = [];
  for (const resource of model.resources) {
    if (resource.parent) continue;
    if (resource.kind === "stack") {
      const condition = options.conditions?.[resource.id];
      catalog.push({
        id: `island:${resource.id}`,
        title: `resources.${resource.path.join(".")}`,
        region: "catalog",
        ...(resource.absent ? { ghost: "absent" as const } : {}),
        caption: [
          `${resource.stackClass ?? "A stack"}: each public field is a catalog entry, bound by linkResources beside the constructs.`,
          resource.absent
            ? `Absent in the ${graph} graph${condition ? `: declared under ${condition}` : ""}.`
            : `Held by the ${graph} graph.`,
        ],
        bands: [
          {
            id: `band:${resource.id}`,
            title: resource.path.join("."),
            caption: [],
            material: "granite",
            h: 2 + (hash(resource.id) % 2),
            groups: [[catalogItem(resource)], (children.get(resource.id) ?? []).map(catalogItem)],
          },
        ],
      });
    } else if (resource.kind === "group") {
      loose.push([catalogItem(resource), ...(children.get(resource.id) ?? []).map(catalogItem)]);
    } else {
      loose.push([catalogItem(resource)]);
    }
  }
  if (loose.length > 0) {
    // Single entries share a column; a group keeps its own.
    const singles = loose.filter((group) => group.length === 1).flat();
    const groups = loose.filter((group) => group.length > 1);
    catalog.push({
      id: "island:inputs",
      title: "Inputs and secrets",
      region: "catalog",
      caption: ["Values authored in cdk-app/.env. Names only: no value ever leaves the studio's server."],
      bands: [{ id: "band:inputs", title: "Inputs and secrets", caption: [], material: "sand", h: 1, groups: [singles, ...groups].filter((group) => group.length > 0) }],
    });
  }
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
  let x = 0;
  let rows = 1;
  spec.bands.forEach((band, bandIndex) => {
    let columns = 0;
    const total = band.groups.reduce((sum, group) => sum + group.length, 0);
    const perColumn = band.perColumn ?? Math.min(6, Math.max(2, Math.ceil(Math.sqrt(total))));
    for (const group of band.groups) {
      const items = order ? order(group) : group;
      for (let start = 0; start < items.length; start += perColumn) {
        items.slice(start, start + perColumn).forEach((item, row) => {
          placed.push({ item, lx: x + 1 + columns * STEP, ly: 1 + row * STEP, band: bandIndex });
          rows = Math.max(rows, row + 1);
        });
        columns += 1;
      }
    }
    const width = Math.max(1, columns) * STEP;
    bandWidths.push(width);
    x += width;
  });
  return { spec, width: x, length: rows * STEP, bandWidths, placed };
}

/** The mean grid y of what an item is connected to, among items already placed. */
function barycentre(id: string, edges: readonly ModelEdge[], placedY: ReadonlyMap<string, number>): number {
  const ys: number[] = [];
  for (const edge of edges) {
    const other = edge.from === id ? edge.to : edge.to === id ? edge.from : undefined;
    const y = other ? placedY.get(other) : undefined;
    if (y !== undefined) ys.push(y);
  }
  return ys.length ? ys.reduce((sum, y) => sum + y, 0) / ys.length : Number.POSITIVE_INFINITY;
}

export function buildScene(model: ModeModel, options: SceneOptions = {}): Scene {
  const specs = islandSpecs(model, options);
  const nodes: SceneNode[] = [];
  const props: Prop[] = [];
  const decorations: Decoration[] = [];
  const islands: Island[] = [];
  const tiles = new Map<string, Tile>();
  const placedY = new Map<string, number>();

  // The columns read left to right on screen — entry, compute, catalog — and
  // each column's islands stack straight down it. Placement happens in a
  // screen-aligned frame (sx = gx - gy across, sy = gx + gy down) and is then
  // turned back into grid cells, so islands stay grid rectangles. Compute is
  // placed first, so the columns either side can line up with what they serve.
  const extent = (footprint: Footprint) => footprint.width + 2 + footprint.length + 2;
  const columnWidth = (list: readonly IslandSpec[]) => Math.max(0, ...list.map((spec) => extent(measure(spec))));
  const entryWidth = columnWidth(specs.entry);
  const computeWidth = columnWidth(specs.compute);
  const catalogWidth = columnWidth(specs.catalog);
  const columns = [
    { specs: specs.compute, centre: entryWidth + COLUMN_GAP + computeWidth / 2, align: false },
    { specs: specs.entry, centre: entryWidth / 2, align: true },
    { specs: specs.catalog, centre: entryWidth + COLUMN_GAP + computeWidth + COLUMN_GAP + catalogWidth / 2, align: true },
  ];

  let computeHeight = 0;
  for (const column of columns) {
    const byConnection = (items: readonly Item[]) =>
      [...items]
        .map((item, position) => ({ item, position, y: barycentre(item.id, model.edges, placedY) }))
        .sort((a, b) => a.y - b.y || a.position - b.position)
        .map(({ item }) => item);
    const ordered = column.align
      ? [...column.specs]
          .map((spec, position) => {
            const ys = spec.bands
              .flatMap((band) => band.groups.flat())
              .map((item) => barycentre(item.id, model.edges, placedY))
              .filter(Number.isFinite);
            return { spec, position, y: ys.length ? ys.reduce((sum, y) => sum + y, 0) / ys.length : Number.POSITIVE_INFINITY };
          })
          .sort((a, b) => a.y - b.y || a.position - b.position)
          .map(({ spec }) => spec)
      : column.specs;
    const measured = ordered.map((spec) => measure(spec, column.align ? byConnection : undefined));
    const height = measured.reduce((sum, footprint) => sum + extent(footprint), 0) + ISLAND_GAP * Math.max(0, measured.length - 1);
    let sy = column.align ? Math.round(Math.max(0, (computeHeight - height) / 2)) : 0;
    for (const footprint of measured) {
      const width = footprint.width + 2;
      const length = footprint.length + 2;
      // Centre the island's diamond on the column: its sx runs from -length to +width about its origin.
      let difference = Math.round(column.centre - (width - length) / 2);
      if ((sy + difference) % 2 !== 0) difference += 1;
      placeIsland(footprint, (sy + difference) / 2, (sy - difference) / 2);
      sy += extent(footprint) + ISLAND_GAP;
    }
    if (!column.align) computeHeight = sy - ISLAND_GAP;
  }

  function placeIsland(footprint: Footprint, gx0: number, gy0: number): void {
    const spec = footprint.spec;
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
    // Corners worn away, deterministically, so islands read as land rather than boards.
    const corners = [
      [0, 0],
      [islandWidth - 1, 0],
      [0, islandLength - 1],
      [islandWidth - 1, islandLength - 1],
    ].map(([x, y]) => ({ x: x!, y: y!, depth: hash(spec.id, x!, y!) % 3 }));
    const bitten = (lx: number, ly: number) => corners.some((corner) => Math.abs(lx - corner.x) + Math.abs(ly - corner.y) < corner.depth);
    for (let lx = 0; lx < islandWidth; lx += 1) {
      for (let ly = 0; ly < islandLength; ly += 1) {
        if (bitten(lx, ly)) continue;
        const band = spec.bands[bandAt(lx)]!;
        const gx = gx0 + lx;
        const gy = gy0 + ly;
        tiles.set(`${gx},${gy}`, {
          gx,
          gy,
          h: band.h,
          material: band.material,
          variant: hash(gx, gy) % 3,
          island: spec.id,
          band: band.id,
          rimLeft: false,
          rimRight: false,
        });
      }
    }
    for (const { item, lx, ly, band } of footprint.placed) {
      const gx = gx0 + 1 + lx;
      const gy = gy0 + 1 + ly;
      const h = spec.bands[band]!.h;
      const anchor = project({ x: gx, y: gy, h });
      nodes.push({ ...item, gx, gy, h, island: spec.id, geometry: buildIconShape(anchor.x, anchor.y) });
      // Barycentres are taken down the screen, which is what lines columns up.
      placedY.set(item.id, gx + gy);
    }
    // Furniture stands on the last lattice row, clear of the buildings and the worn corners.
    spec.bands.forEach((band, index) => {
      (band.props ?? []).forEach((prop, position) => {
        const gx = gx0 + 1 + bandStarts[index]! + Math.min(position, footprint.bandWidths[index]! - 1);
        const gy = gy0 + footprint.length;
        const anchor = project({ x: gx, y: gy, h: band.h });
        props.push({ ...prop, gx, gy, h: band.h, geometry: buildShape(prop.shape, anchor.x, anchor.y) });
      });
    });
    // Scenery on a few empty interior cells, away from every building and prop.
    if (!spec.ghost) {
      const taken = new Set<string>();
      for (const { lx, ly } of footprint.placed) {
        for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) taken.add(`${gx0 + 1 + lx + dx},${gy0 + 1 + ly + dy}`);
      }
      for (const prop of props) taken.add(`${prop.gx},${prop.gy}`);
      for (let lx = 1; lx < islandWidth - 1; lx += 1) {
        for (let ly = 1; ly < islandLength - 1; ly += 1) {
          const gx = gx0 + lx;
          const gy = gy0 + ly;
          const tile = tiles.get(`${gx},${gy}`);
          if (!tile || taken.has(`${gx},${gy}`) || hash("scenery", gx, gy) % 100 >= 6) continue;
          const anchor = project({ x: gx, y: gy, h: tile.h });
          const shape = SCENERY[tile.material];
          // Off-centre, so the scenery does not line up like the buildings do.
          const nudge = (hash("nudge", gx, gy) % 13) - 6;
          decorations.push({ gx, gy, h: tile.h, shape, geometry: buildShape(shape, anchor.x + nudge, anchor.y + nudge / 3) });
        }
      }
    }
    const heights = spec.bands.map((band) => band.h);
    islands.push({
      id: spec.id,
      title: spec.title,
      region: spec.region,
      caption: spec.caption,
      ...(spec.ghost ? { ghost: spec.ghost } : {}),
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
        gx: gx0 + 1 + bandStarts[index]! + Math.floor(footprint.bandWidths[index]! / 2),
        gy: gy0 + islandLength - 1,
      })),
    });
  }

  // Walls: down to a lower neighbour, or to the island's floor at its rim.
  const islandBase = new Map(islands.map((island) => [island.id, island.base]));
  const finished: Tile[] = [];
  for (const tile of tiles.values()) {
    const left = tiles.get(`${tile.gx},${tile.gy + 1}`);
    const right = tiles.get(`${tile.gx + 1},${tile.gy}`);
    const floor = islandBase.get(tile.island)!;
    const leftOwn = left && left.island === tile.island ? left : undefined;
    const rightOwn = right && right.island === tile.island ? right : undefined;
    const wallLeft = leftOwn ? (leftOwn.h < tile.h ? leftOwn.h : undefined) : floor;
    const wallRight = rightOwn ? (rightOwn.h < tile.h ? rightOwn.h : undefined) : floor;
    finished.push({
      ...tile,
      ...(wallLeft === undefined ? {} : { wallLeft }),
      ...(wallRight === undefined ? {} : { wallRight }),
      rimLeft: !leftOwn,
      rimRight: !rightOwn,
    });
  }
  finished.sort((a, b) => a.gx + a.gy - (b.gx + b.gy) || a.h - b.h || a.gx - b.gx);
  nodes.sort((a, b) => a.gx + a.gy - (b.gx + b.gy) || a.h - b.h || a.gx - b.gx);

  const ids = new Set(nodes.map((node) => node.id));
  const edges = model.edges
    .filter((edge) => ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to)
    .map((edge) => ({ edge, category: RELATION_CATEGORY[edge.relation] }));

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
  // Island titles hang off each island's left flank.
  for (const island of islands) {
    const flank = project({ x: island.gx0, y: island.gy1 + 0.5, h: island.top });
    minX = Math.min(minX, flank.x - 32 - 260);
  }

  return {
    mode: model.mode,
    tiles: finished,
    islands,
    nodes,
    props,
    decorations,
    edges,
    bounds: Number.isFinite(minX) ? { minX, minY, maxX, maxY } : { minX: -100, minY: -100, maxX: 100, maxY: 100 },
  };
}
