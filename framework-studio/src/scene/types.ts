import type { Lanes, Mode, ModeModel, TargetKind } from "../../shared/model";
import type { ConnectionGroup } from "../connections";
import type { Availability, DeploymentBadgeKind } from "../deployment";
import type { IconKey } from "../icons";
import type { EdgeCategory } from "../lookup";
import type { Bounds } from "./camera";
import type { ConnectionStyle } from "./connections";
import type { SceneFrame } from "./frame";
import type { IslandFootprint } from "./layout";
import type { LayoutResult, LayoutSettings } from "./layout-optimize";
import type { ConnectionRoutes } from "./routing";
import type { Shape } from "./shapes";

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
  readonly frameworkManaged?: true;
  readonly sourceProblems?: readonly string[];
  /** View-only tag filtering, rendered with the existing disabled-resource style. */
  readonly tagFiltered?: true;
  readonly badge?: DeploymentBadgeKind;
  readonly icon: IconKey;
  readonly roleIcon?: IconKey;
  readonly id: string;
  readonly entity: "gateway" | "route" | "target" | "resource" | "local";
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
  readonly frameworkManaged?: true;
  readonly tagFiltered?: true;
  readonly id: string;
  readonly icon: IconKey;
  readonly roleIcon?: IconKey;
  /** Same versioned AWS service SVG used by the endpoint picker. */
  readonly serviceIcon?: string;
  readonly gx: number;
  readonly gy: number;
  readonly h: number;
  readonly label: string;
  /** What it is and which VPC holds it, in the same "Kind, qualifier" form as a node's `kindLabel`. */
  readonly kindLabel?: string;
  readonly caption: readonly string[];
  readonly geometry: Shape;
  /** Gateways and endpoints follow whether this graph builds their VPC. */
  readonly presence: "built" | "other";
  /** The subnet bands whose traffic it carries, so selecting a building there keeps it lit. */
  readonly serves: readonly string[];
}

export interface SceneEdge extends ConnectionGroup {
  /** Relationship category; each bundle contains one type of relationship. */
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
  readonly resourceAvailability?: Readonly<Record<string, Availability>>;
  /** Catalog facts from the source index: the condition an entry is declared under. */
  readonly conditions?: Readonly<Record<string, string | undefined>>;
}
