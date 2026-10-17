import type { Lanes, Mode, ModeModel, ModelEdge, ModelResource, ModelRoute, ModelTarget, NetworkModel } from "../../shared/model";
import { RELATION_CATEGORY, ROLE_LABEL, type EdgeCategory } from "../lookup";
import { resourceIcon, routeIcon, targetIcon, type IconKey } from "../icons";
import { availabilityBadge, deploymentBadge, developmentLocation, environments, type Availability, type DeploymentBadgeKind } from "../deployment";
import { ELEVATION_STEP, TILE_HEIGHT, TILE_WIDTH, project } from "./iso";
import { buildIconShape, lambdaGlyph, type Glyph, type Shape, type ShapeKind } from "./shapes";
import type { Bounds } from "./camera";
import { islandFrame, type SceneFrame } from "./frame";

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
 * island, separate from authored inputs and secrets. The VPC's terraces step down from public to isolated,
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

export type Region = "entry" | "compute" | "network" | "agents" | "orchestration" | "catalog" | "local";

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
  readonly id: string;
  readonly entity: "route" | "target" | "resource" | "local";
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
  readonly icon: IconKey;
  readonly shape: ShapeKind;
  readonly gx: number;
  readonly gy: number;
  readonly h: number;
  readonly label: string;
  readonly caption: readonly string[];
  readonly geometry: Shape;
  /** Gateways and endpoints follow whether this graph builds their VPC. */
  readonly presence: "built" | "other";
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
  /** Visible endpoints; stack fields connect to their owning stack. Evidence keeps the original edge. */
  readonly from: string;
  readonly to: string;
  readonly category: EdgeCategory;
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
  // Entry points, by the gateway that serves them.
  const routes = (kinds: readonly ModelRoute["kind"][]) =>
    model.routes.filter((route) => kinds.includes(route.kind)).map((route) => routeItem(route, targets.get(route.target), mode));
  const apiGroups = [routes(["http", "service"]), routes(["webSocket"]), routes(["agent"])].filter((group) => group.length > 0);
  const entry: IslandSpec[] = apiGroups.length ? [{
    id: "island:apis", title: "APIs", region: "entry",
    caption: ["HTTP routes, WebSocket route keys and agent browser paths. Select a route to inspect its protocol and target."],
    bands: [{ id: "band:apis", title: "APIs", caption: [], material: "limestone", h: 2, groups: apiGroups }],
  }] : [];

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
    ...((model.localServices?.length ?? 0) > 0 ? [{
      id: "island:local", title: "Local development", region: "local" as const,
      caption: ["Support services declared in docker-compose.yml, running on your machine during development."],
      bands: [{ id: "band:local", title: "Local development", caption: [], material: "circuit" as const, h: 2,
        groups: [model.localServices!.map((service): Item => ({
          id: service.id, entity: "local", icon: "postgres", shape: "database", label: service.title,
          kindLabel: "Compose database", badge: "dev", presence: service.enabled ? "built" : "other",
          presenceText: service.enabled ? "Development database, declared in docker-compose.yml. Container status is not monitored." : "Used during development on your machine.",
        }))] }],
    }] : []),
    {
      id: "island:lambda", title: "Lambda functions", region: "compute",
      caption: ["HTTP, WebSocket and event functions. VPC-attached functions remain on their subnet terraces."],
      bands: [{ id: "band:lambda", title: "Lambda functions", caption: [], material: "circuit", h: 3, groups: lambdaGroups.filter((group) => group.length > 0) }],
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
          props: [{ id: "prop:internet-gateway", icon: "internetGateway", shape: "pylon", label: "Internet gateway", caption: ["IPv4 and IPv6 between the public subnets and the internet."] }],
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
              ? [{ id: "prop:egress-only-gateway", icon: "internetGateway" as const, shape: "pylon" as const, label: "Egress-only gateway", caption: ["IPv6 out of the private subnets, never in. Free."] }]
              : []),
            ...(network?.natGateway
              ? [{ id: "prop:nat-gateway", icon: "natGateway" as const, shape: "construct" as const, label: "NAT gateway", caption: [`IPv4 out of the private subnets, about $${network.monthlyCost.natGateway.toFixed(2)} a month.`] }]
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
            icon: endpoint === "s3" ? "bucket" : endpoint === "dynamodb" ? "table" : "endpoint",
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

  // Catalog stacks share an island; their public fields stay in the inspector.
  const children = new Map<string, ModelResource[]>();
  for (const resource of model.resources) {
    if (resource.parent) children.set(resource.parent, [...(children.get(resource.parent) ?? []), resource]);
  }
  const catalog: IslandSpec[] = [];
  const loose: Item[][] = [];
  const stacks: Item[] = [];
  for (const resource of model.resources) {
    if (resource.parent) continue;
    if (resource.kind === "stack") {
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
      bands: [{ id: "band:stacks", title: "Stacks", caption: [], material: "granite", h: 2, groups: [stacks] }],
    });
  }
  if (loose.length > 0) {
    // Single entries share a column; a group keeps its own.
    const singles = loose.filter((group) => group.length === 1).flat();
    const groups = loose.filter((group) => group.length > 1);
    catalog.push({
      id: "island:inputs",
      title: "Inputs and secrets",
      region: "catalog",
      caption: ["Inputs and secrets authored in cdk-app/.env. Select an input to inspect its value and declaration."],
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
    const width = Math.max(1, columns, band.props?.length ?? 0) * STEP;
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
        const gx = gx0 + 1 + bandStarts[index]! + position * STEP;
        const gy = gy0 + footprint.length;
        const anchor = project({ x: gx, y: gy, h: band.h });
        props.push({ ...prop, presence: ghost ? "other" : "built", gx, gy, h: band.h, geometry: buildIconShape(anchor.x, anchor.y) });
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
  const representatives = Object.fromEntries(model.resources.filter((resource) => resource.kind === "member" && resource.parent && ids.has(resource.parent)).map((resource) => [resource.id, resource.parent!]));
  const edges = model.edges
    .map((edge) => ({ edge, from: representatives[edge.from] ?? edge.from, to: representatives[edge.to] ?? edge.to, category: RELATION_CATEGORY[edge.relation] }))
    .filter((edge) => ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to);

  const frames: SceneFrame[] = islands.filter((island) => island.region === "network").map((island) => ({ id: `frame:${island.id}`, kind: "network", members: [island.id], ghost: !!island.ghost, geometry: islandFrame(island) }));


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

  return {
    mode: model.mode,
    representatives,
    frames,
    tiles: finished,
    islands,
    nodes,
    props,
    decorations,
    edges,
    bounds: Number.isFinite(minX) ? { minX, minY, maxX, maxY } : { minX: -100, minY: -100, maxX: 100, maxY: 100 },
  };
}
