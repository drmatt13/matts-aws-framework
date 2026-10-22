# The isometric view

`/isometric` draws the snapshot's selected-mode model as a landscape of floating islands
on a 2D canvas. This document covers how the scene is laid out, drawn and interacted with.

The code is in [framework-studio/src/scene/](../../framework-studio/src/scene) and
[src/views/Isometric.tsx](../../framework-studio/src/views/Isometric.tsx).

## Rules it keeps

- **A view, not a model.** Every building is an entity the model names, under the model's
  own id (`lambda:graphql-api`, `route:http:/graphql`, `resource:cognito.userPool`).
  Selecting one sets `?select=` like every other view, so the inspector and its edits are
  the existing ones.
- **Everything selectable is described.** Each building, island, gateway and endpoint has
  an authored **Description** in its inspector, saved as a literal string in
  [framework-config/descriptions.ts](../../framework-config/descriptions.ts) under the
  same entity id. Descriptions are shared by both graphs, edited through the usual
  review-and-apply draft, and a test requires one for every id the scene can draw.
- **Layout is computed.** Positions, islands and colours are a pure, deterministic
  function of the model. Nothing about them is written anywhere or read back as
  configuration.
- **The graph switch changes how things are drawn, never where they stand.** Dev and prod
  scenes place every entity identically, and a test holds that.
- **Truthful regions.** A region says only what the framework says. Outside the VPC means
  "in no subnet", not "public", and a blueprint VPC means "this deployment builds no
  network".

## Modules

| Module | Pure | Responsibility |
| --- | --- | --- |
| `iso.ts` | yes | Projection, its inverse at a height, painter's depth, tile corners |
| `build.ts` | yes | Model → `Scene`: islands, footprint tiles, buildings, gateways and endpoints, edges, bounds |
| `shapes.ts` | yes | Icon plinth and plaque geometry, with a picking silhouette |
| `slabs.ts` | yes | Each island as chamfered slabs per terrace, front walls with gradients, trim polylines, pads, cast shadows, island painter's order |
| `look.ts` | yes | Graphite colour tokens, trim colour per island, icon tint per icon |
| `focus.ts` | yes | Metadata search, selection precedence and shared focus/opacity state |
| `hover.ts` | yes | Hover-card facts read from both models: which environments deploy an item (with where, for assistive technology) and the framework-managed flag (tested in [test/hover.test.ts](../../framework-studio/test/hover.test.ts)) |
| `layout.ts` | yes | Measured island row packing, environment/input pairing and compact right-hand network grouping |
| `frame.ts` | yes | VPC foundation and frame colour |
| `camera.ts` | yes | World↔screen transforms, pan, pointer-anchored zoom, wheel normalization, fit, tween |
| `picking.ts` | yes | Point-in-polygon, entity picking, painted-slab picking, arc geometry, card placement |
| `render.ts` | no (canvas) | `SceneRenderer`: caches per scene, draws per frame |
| `grid.ts` | yes | Viewport-bounded, world-anchored ground grid with zoom-dependent spacing |
| `../icons.ts` | yes | Shared mapping from model entities to local AWS/Lucide SVG assets |
| `views/Isometric.tsx` | no (React) | Mounting, input, the render loop, toolbar, add menu, hover card, accessible list, debug hook |

Everything marked pure runs under Node and is unit-tested in
[test/landscape.test.ts](../../framework-studio/test/landscape.test.ts).

The circular plus button at the bottom right opens an **Add to application** menu.
Its function, stack, VPC, workflow, container service/task, API route, agent, input
parameter and secret options are placeholders until creation tools are implemented.
Close the menu with its close button, Escape, or by clicking outside it.

Stack plaques carry an unplug badge when the configured CDK app has no constructor
reference for their class in its local runtime import graph. These unattached stacks
have transparent plaques without solid plinths; their unplug badges and names stay
fully visible in both environments, including when another node is selected.
Search still fades nonmatching items. A lock badge marks the
framework's configured database, its stack and the selected root `.env` export stacks.
The export stacks are selected by the same public-output mapping used by the exporter;
they are not a complete framework stack inventory. Their inspector outputs use styled
`$` symbolic source values. The database member has its own RDS
plaque on the subnet selected by its literal constructor options, connected to its
owning stack by a derived containment relationship; other stack members
remain represented by their stack. Database edges reach the RDS plaque. Catalog absence
still ghosts RDS in Development, and both modes share identical geometry.

## Coordinates

Screen y grows downward everywhere: terrain, buildings, edges, camera and picking share one
frame.

```text
world.x = (gx - gy) * 32
world.y = (gx + gy) * 16 - h * 16
```

| Quantity | Value |
| --- | --- |
| Top diamond | 64 × 32 world units |
| Elevation step | 16 |
| One grid step along `gx` | (32, 16) on screen |
| One grid step along `gy` | (-32, 16) on screen |
| Painter's order | Ascending `gx + gy`, then height |
| Inverse at a known height `h` | `gx = (s + d) / 2`, `gy = (s - d) / 2`, where `d = x / 32` and `s = (y + 16h) / 16` (`unprojectAt`) |

## Layout ([build.ts](../../framework-studio/src/scene/build.ts))

The measured packer below supplies a semantic seed. The graph-aware optimizer can
move islands away from those starting rows to reduce projected crossings and wire
length, while retaining environment-left/input-next and right-hand network constraints.
See [graph-aware layout](graph-layout.md) for graph extraction, scoring, incremental
stability, shared routing, viewport adaptation and measured before/after results.

### Regions

| Placement | Island | Holds | Height |
| --- | --- | --- | --- |
| Upper left | APIs | HTTP routes, service mounts, WebSocket keys and agent browser paths on one layer | 2 |
| Lower left | Input parameters and secrets | Only catalog-declared inputs, secrets and groups on one shared lattice; other dotenv keys stay in the file inspectors | 1 |
| Upper right | Serverless compute | HTTP, WebSocket, event and AgentCore tool Lambdas outside the VPC on one shared lattice | 3 |
| Right-hand network cluster | VPC | Subnets `public`, `private` and `isolated`, side by side at one height. Every target with `placement.kind === "vpc"` stands on its subnet. Gateways and endpoints from `network` stand on the subnets as selectable furniture. The Compose PostgreSQL service stands in the isolated subnet right beside the managed RDS database, as its development counterpart: solid in Development and ghosted in Production, and not an AWS resource | 4 |
| Shared lower row, first | Agents | AgentCore agents not placed in the VPC | 3 |
| Shared lower row, second | Workflows | Step Functions workflows | 4 |
| Shared lower row, third | Stacks | All `resource.stack<T>()` entries together, one node per class; public fields expand in the inspector | 2 |
| Immediately left of input parameters and secrets | CDK environment files | `.env.dev` and `.env.prod`; file-to-parameter links use assignment names and source locations, with no values. A file that has not been generated wears a red cross, and the island inspector generates it from its `.template` | 1 |

The subnets stand level, left to right from public to isolated. Exposure reads in colour
rather than height: public is green, private blue and isolated
purple.

Each network island has a shallow isometric foundation beneath all its terraces, with
a perimeter and inset border in VPC violet. It groups the subnets as one VPC. Geometry comes
from each island's own footprint, ready for separate boundaries if multiple VPC islands
are introduced. The foundation is dashed and faded with a blueprint VPC. It participates
in camera bounds without adding an entity or moving workloads.

API and Lambda panels have no group perimeter. VPC-attached Lambdas remain on
subnet terraces inside the VPC foundation.

### Packing

- **The lattice.** Buildings stand every fourth cell (`NODE_SPACING = 4`), leaving room
  for each icon, its corner badges and a caption above its plaque. An island is its lattice plus a one-cell rim.
- **Near-square islands.** Each band packs about √n items per lattice column (2–6).
  Service groups keep their order but continue into the same columns, without reserving
  empty cells between groups. Bands with fewer nodes are centred in the available depth.
  Network fixtures reserve a separate front row on the same three-cell lattice. The VPC
  gives every terrace the same depth. Footprints are measured again on every model change;
  the existing row packer shifts neighbours and wraps growing islands automatically.
- **Columns are screen-aligned.** Islands are placed in a frame where `sx = gx - gy` runs
  across and `sy = gx + gy` runs down, then converted back to grid cells. Islands therefore
  stay grid rectangles. The left input/entry cluster, right compute/network cluster and shared lower row give the current
  application a roughly 16:9 footprint for desktop monitors.
- **Rows within a column.** A column is as wide as its widest island. Taking islands in
  order, each joins the row above while the row still fits that width; otherwise it starts
  a new row. An island after the first in a row first leaves room on its left for its
  flat title (`titleRoom`), so labels never land on a neighbour. Rows are centred in the
  column, and islands in a row are centred on the row's height. Environment files and
  input parameters form one measured row, with files on the left and a reserved gap
  for the input island's title. Their vertical centres stay aligned as either grows;
  if inputs are absent, files still belong to the left cluster. The same packing places
  Agents, Workflows and Stacks, in that order, across the full width
  below the main columns. A compact supporting row can widen the main gutter, up to 1.5×
  the natural column width; a supporting island that outgrows that row wraps to the next.
  - Minimum gap between columns: 6 tile units, widened for network/compute titles.
  - Gap between rows: 5 tile units.
  - Before the shared supporting row: 10 tile units.
- **Networks stay together on the right.** Network islands are classified by region,
  not one VPC ID. The packer evaluates row widths derived from their measured footprints
  and favours a compact landscape-shaped group; growing groups wrap into nearby rows.
  Network footprints include measured foundation overhang, keeping adjacent frames clear.
  A stable ID order keeps input-array reordering from reshuffling them. The network
  group stays below outside compute in the right cluster and reserves a title gutter
  from inputs on the left. This supports future multiple network islands in the layout;
  the current declaration model still supplies the application's single VPC.
- **Graph-aware refinement.** Node slots remain on their measured lattice. Island
  dependencies guide layered/barycentric seeds and bounded moves and swaps. The lower
  islands need not share one row; Workflows stay left of Stacks. Benchmarks compare
  the current packer's unrefined seed with its refined layout; the previous
  one-sided node barycentre and legacy router have been removed.
- **Chamfered corners.** Each corner is cut back by one straight chamfer (`CHAMFER = 2`
  cells along each edge, at most a third of the island's shorter side). A cell is removed
  exactly when its centre falls outside the cut (`chamfered`), so tiles, walls, picking
  and the graphite outline agree. The cut never reaches a building, a fixture or a terrace
  name. On screen the outline is an octagon: the front corner becomes a facet facing the
  viewer, and the side cuts are vertical.
- **Walls.** Continuous slab walls drop to the island's floor (lowest band height − 3)
  at the rim. Level ground has no internal walls.
- **Clear terrain.** No decorative rocks, lamps, shrubs or shards are placed on tiles.

### Presence

`presence` is computed per entity from the selected mode:

| Presence | Meaning | Drawn as |
| --- | --- | --- |
| `built` | Enabled in the selected environment: Development is `lanes.local || lanes.dev`; Production is `lanes.prod` | Solid |
| `other` | Enabled only in the other environment | Dashed outline (ghost) |
| `nowhere` | Enabled in no lane | Ghost |
| `absent` | The graph does not hold it: a catalog entry it declares `undefined`, or the other environment's file | Ghost |
| `present` | A catalog entry or file this graph holds | Solid |

- A route follows its target.
- The local PostgreSQL service follows its execution environment. Locally executing
  database consumers connect to it; AWS database bindings keep their resource destination.
  It is a Compose service (`local:postgres`), not an AWS catalog resource or VPC member.
- Islands are ghosted the same way:
  - absent stacks have ghost nodes on the shared Stacks island;
  - an island with nodes but none enabled in the selected environment uses the same
    20 % opacity and grid outline; an island with any enabled node stays solid;
  - development VPCs are translucent blueprint decks; production uses subnet terraces,
    solid regardless of usage. `network.builtInProd` remains a deployment fact in captions and hover details.
- Labels have no badge for entities available in both environments. A teal flask Dev
  badge marks Development only, a violet diamond Prod badge Production only, and Off
  marks disabled workloads. Execution location never gets a separate deployment badge.
  Badge paths, colors and semantics are shared by canvas and DOM views in `deployment.ts`.
  Catalog badges use absence in both snapshot models; they are never guessed from types.
  Deployment tags sit on the plinth's front edge, separate from name pills, so they
  never consume title width. Auth locks remain independent.

## Terrain ([slabs.ts](../../framework-studio/src/scene/slabs.ts), [look.ts](../../framework-studio/src/scene/look.ts))

Each island is drawn as continuous slabs, one per band, rather than a field of tiles:

- **Geometry.** A band's top is its column strip (`Band.gx0`–`gx1`) of the island's
  chamfered outline. Only edges facing the viewer get walls:
  - the front-left edge, the front facet and the front-right edge fall to the island floor;
  - on a terraced island such as the VPC, each band is its own slab, apart from the next
    by a narrow seam (`terraceGap`, 0.3 cells). Its right edge along the seam falls to the
    floor too.

  Walls are built once per run, and each carries a linear gradient that stays constant
  along its top edge, so one gradient follows a whole sloped wall.
- **Light.** One key light from the upper left:
  - tops have a soft gradient from the back corner to the front;
  - left walls are brighter than front facets, which are brighter than right walls;
  - every wall's top edge has a 1px bright lip;
  - where a terrace stands higher than its neighbour, without a seam between them, it
    steps down to it, and a darkening strip sits at the foot of the step.
- **Identity through light.** Every island is graphite. Its region shows as an emissive
  trim along its front top edges, drawn in three additive passes, in the AWS icon category
  colour of what stands on it:

  | Island | Trim |
  | --- | --- |
  | APIs | `#8C4FFF` (API Gateway) |
  | Serverless compute (Lambda) | `#ED7100` |
  | Workflows | `#E7157B` (Step Functions) |
  | Agents | `#01A88D` (AgentCore) |
  | VPC | Public `#5fc75a` green, private `#3d8bfd` blue, isolated `#b07cff` purple (`BAND_TRIM`); the foundation, its edge and its label in a VPC violet `#9d6bff` |
  | Stacks | `#6f93c9` |
  | Inputs and secrets | `#DD344C` (Secrets Manager) |

  The tops take 7 % of the trim. Faint hairlines are etched along tile edges, and an
  inset pad with a trim-coloured outline sits under every building and fixture.
- **Atmosphere.** A navy void, the grid under a vignette so it fades outward, and two soft
  additive blooms (teal upper left, violet lower right). Each island casts a soft
  shadow, drawn as four inflated layers, onto a floor five steps below it.
- **Readable names.** Island titles stay horizontal outside the left flank at every zoom.
  Production subnet names use horizontal dark cards with 13 px detail text and a
  short subnet-coloured cue. Each heading sits just outside the top-right edge, with a
  small gap at detail size. The card's bottom-left corner aligns near the midpoint of its
  zone's rim, so names extend up and right without drifting away through zoom. There are
  no connector lines. The trailing name balances its midpoint anchor with the painted
  end cap, sliding halfway back along the rim when it overhangs. Content never lifts or
  scatters individual names away from the network. Names follow the camera exactly, including its existing
  easing and reduced-motion handling. They never become perspective wall text or choose
  a different slot at a viewport edge: canvas clipping carries them naturally offscreen.
  Overview zoom uses the node captions' smooth fade convention with stronger visibility:
  headings retain full contrast down to 0.5× and ease to a 50% text floor at 0.08×.
  Cards dissolve faster than text. Below 0.65× zoom, typography and card
  geometry also shrink gently with the node-caption scale to keep overviews compact.
  Resource captions yield to these section headings. No independent heading animation
  runs while the camera is still.
- **Ghosts.**
  - A development VPC is one
    raised deck of dark glass rather than a slice per subnet (the `DECK` values in
    `look.ts`). Its subnets are flush zones on that deck, each a faint wash of its own
    colour, without subnet names or lines between zones. Development hover titles also
    omit subnet names. A single
    dashed rim in the VPC violet says it is not built here, a light cast shadow stands the
    deck off the ground, and a pad under each solid building anchors it. Production VPCs
    keep solid separate terraces and gateways/endpoints even when unused. Captions and
    hover details explain that a network without consumers is not actually built.
  - Disabled islands draw at 30 % with a dashed trim.
- **Focus.** With a selection, islands holding nothing in the spotlight dim their trim to
  40 %. Island trim stays static when a building is selected.
  This happens only while a selection exists, so a still picture still draws nothing, and
  reduced motion disables it.
- **Order.** Shadows, then the VPC foundation, then whole islands in `islandDrawOrder`.
  Of two islands that overlap on screen, the one wholly behind on the grid draws first.
  Within an island, each terrace's slab is drawn, then what stands on it.

## Buildings ([shapes.ts](../../framework-studio/src/scene/shapes.ts))

Each building has:

- a soft contact shadow;
- an additive spill of its icon's colour on the ground (`ICON_TINT`);
- a raised graphite plinth with a lit front edge, on an etched pad;
- a plaque with a depth edge, a glass highlight and a hairline in the icon's colour. When
  selected, its hairline turns white and glows in the icon's colour.

A ghost (outside this environment) has no plinth, pad, shadow or spill: its translucent
plaque stands on bare ground.

All of it stays inside the plaque box, which `buildIconShape` includes in its picking hull.

Entities now use `buildIconShape`: a low isometric plinth and an upright 48-unit plaque
carrying a 40-unit SVG. Every plinth uses the same neutral gray palette, with face shading
for depth; service identity comes from the SVG. The plaque is part of the picking hull and arcs anchor at its
top. `icons.ts` maps target kinds, route surfaces and catalog member types to official AWS
Architecture Icons (July 2026) or generic Lucide outlines. Assets and attribution live
in `framework-studio/public/icons/`; all are served locally. SVGs are loaded once per
renderer; completion schedules a redraw even when motion is paused. Disposal clears
their callbacks. Presence controls active versus ghost opacity and dashed outlines.
Local execution is active in Development; local-only workloads are ghosted in Production.

WebSocket routes and functions carry a small connection badge with the same border
color, opacity and thickness as the managed lock badge; agent routes and tool
Lambdas carry an AgentCore badge; event Lambdas carry a black lightning bolt on yellow.
These sit at the main icon's lower-right corner, share its disabled/dimmed opacity and
belong to its clickable silhouette. HTTP nodes keep their plain API Gateway or Lambda icon.
A badge is a dark plate round a glyph, except where the glyph is AWS service artwork:
that is a full-bleed coloured tile already (`carriesOwnTile` in `icons.ts`, any `aws/`
icon), so it fills the badge, clipped to the corners, rather than sitting inside a
plate that would read as a thick border. A badge with a backdrop of its own, such as the
event bolt's yellow, is one entry in `ROLE_BADGE` (`look.ts`).

Network gateways and endpoints use the same icon plaques: AWS VPC gateway icons,
and a VPC endpoint icon with a small service badge at its lower-right corner. The badge
reuses the Lambda role-badge renderer and picking silhouette, including ghost/dimmed
opacity. S3, DynamoDB and other locally mapped services use their service
artwork from the endpoint picker's shared service/family catalog, including variant endpoints.
Unknown services retain their ID and use the generic endpoint artwork. Selected SVGs are
cached by the renderer and painted full-bleed in the mini badge. Every declared endpoint
is shown, with no four-endpoint display limit.
They are furniture, not model entities: clicking one selects its stable `prop:` id so
the inspector can show its description. Each names the subnets whose traffic it
carries (`Prop.serves`): the internet gateway serves public, the egress-only and NAT
gateways serve private, and endpoints serve all three. With a selection, a fixture dims
with everything outside the spotlight unless it serves the selected building's subnet
(`SceneNode.band`). Fixtures wrap into compact grids after a separate compute area on
each subnet. Width and depth come from the same measured cells used for placement, so
adding endpoints grows both dimensions without pushing compute into the fixture rows.
Gateways anchor to the left-facing subnet edges rather than the terrace centre.
Every fixture retains its own cell and selectable silhouette. Production fixtures stay
solid even when the VPC is unused; Development uses translucent icons and dashed plinths.

Every icon shape returns its faces in paint order, a silhouette (`hull`) for picking,
and a `top` point where arcs attach. Unused procedural buildings and sprite terrain have
been removed; the renderer has one visual style.

## Rendering ([render.ts](../../framework-studio/src/scene/render.ts))

`SceneRenderer.setScene` runs once per scene:

- it builds the standing-item list, continuous slabs and their painter's order;
- it caches slab paths and wall gradients, each arc's sampled points and length, and
  each draw item's world bounding box.

`render` runs per frame:

1. **The void and grid.** A radial gradient in screen space, then hairlines on the ground
   plane in world space. Grid slopes match the terrain (±0.5). Every fifth line is
   slightly stronger; zooming out coarsens spacing to avoid moiré. Only lines crossing
   the viewport are generated. Pan and pointer-anchored zoom keep the lattice attached
   to the world.
2. **Atmosphere.** Soft screen-space blooms and a vignette, with cast shadows under
   solid islands.
3. **Terrain and buildings**, in the cached order. Items outside the viewport (plus a
   margin) are culled. Buildings are drawn by presence, and the selection gets a pulsing
   ring on its tile. When a selection exists, everything outside its neighbourhood is
   dimmed. Search applies the shared focus opacity to all paint layers (see Search).
4. **Arcs.** Quadratic curves lifted along world Z, which projects straight up the page.
   Relationships with the same visible source and destination share one arc, including
   references to different fields of the same stack. Opposite directions stay separate.
   The hover popup shows the relationship count when grouped and the same Dev and Prod
   pills as node popups. Both pills keep their names; unavailable environments are dimmed.
   Connection inspectors and their individual relationship rows use the same two pills,
   including when both environments are enabled. Shared endpoints appear once above a
   compact list of relationship names and types; expanding a row reveals its original
   field endpoints and evidence. Availability requires a
   relationship and both enabled endpoints in that graph. Selecting a grouped arc opens
   a connection map with every original source, destination, label, environment and
   expandable evidence or input-resolution action. Mixed permission/read groups retain
   the guarded style, and any missing required input retains the red X marker.
   Ground-plane travel stays linear, so connections toward or away from the viewer
   rise and fall without swinging sideways. Attachment elevations include each plaque's
   height. Lift accounts for the ground plane's 2:1 foreshortening, with a physical crest
   at least `28 + 0.08 · ground span` world units above the higher attachment. An additional
   24-unit minimum clearance above the higher projected endpoint keeps depth-aligned
   connections legible. Lane offsets and obstacle avoidance can increase the lift;
   nearby connections retain compact detours. Drawing, picking and packets share the
   same cached path, and Fit includes its crest.
   They are coloured by the Board's six
   categories, with every category visible by default and no visibility toggles. Dashed is
   the default; solid lines are the named exceptions (below), so a connection's line tells
   you what kind it is as well as its colour. Every connection points the way the model
   records it (a workload to what it references), and `connections.ts` decides colour and
   dash for each edge:
   - **What a workload references decides its colour.** Reading a stack field or an input
     parameter takes exactly the look of an environment file supplying an input (the
     Environment and secrets colour); referencing a secret and a native grant are red, so
     a parameter being read never looks like a permission being given. What is referenced
     decides this, even when the map shows a stack field as its owning stack.
   - **Everything else.** Solid: an API route (purple, out of the APIs island), a Lambda
     or container leaving for another workload (orange), a WebSocket authorizer's link to
     the route it guards (red), an agent calling a tool (teal) and a workflow step (pink).
     Dashed: an environment file supplying a secret (red), and every remaining connection
     in its category colour.

   A missing required input is still red, with its X marker. Derived edges are fainter,
   and a derived or source-inferred connection says so in its hover card.

   Hover eases a connection's brightness, width, glow, arrow and packets over 50 ms
   in either direction, using `cubic-bezier(0.16, 1, 0.3, 1)` for a fast response and
   soft finish. Selection and search highlighting remain immediate. Switching
   Development/Production applies the new connection strengths instantly and clears
   any hover fade from the previous graph. Paused or reduced motion skips the fade.

   Native event triggers point from the public resource to the event Lambda, in solid
   warm yellow (`#ead46c`). They share the invocation category but have their own colour,
   distinct from reads, grants, routes, compute, tools, steps and CDK references. The
   hook/adapter label and wiring location appear in hover and connection details. Both
   lenses retain the same triggers, including cycles back through a Lambda's reads.

   **The lens.** An idle connection rests at 0.30 opacity (0.18 when derived), so what is
   part of the environment being viewed reads clearly. A connection outside it rests at
   a quarter of that (0.075, or 0.045 when derived): either end is enabled only in the
   other environment, enabled in neither, or
   a catalog entry the viewed graph declares undefined, or the other environment alone
   holds the connection (`offLens` in `connections.ts`, `EDGE_ALPHA.outOfLens`). Every
   connection keeps the same four-to-one ratio between its enabled and disabled views, so
   switching Development and Production dims what the new view leaves out and brightens
   what it brings in.

   Selecting a dimmed connection shows **Disabled in Development** or **Disabled in
   Production** in its Inspector, with links to the endpoints that are not enabled.
   A connection held only by the other graph names that environment instead. The notice
   follows the current mode and disappears when the connection becomes enabled.

   **The standard for new resources.** A resource scoped to one environment says so
   once, at the producer that builds the model: it sets `ModelResource.absent` per graph.
   Nothing downstream names a kind. The node's presence, its Dev/Prod badge
   (`catalogAvailability`), its hover pills (`resourceWhere`) and the strength of every
   connection touching it (`offLens`) all follow that flag, so a new resource type gets
   the same lens behaviour with no view change. The two environment files are the worked
   example: `.env.dev` is absent from the Production graph and `.env.prod` from
   Development, so each file's connections read clearly in its own view and recede in
   the other. `test/landscape.test.ts` and `test/hover.test.ts` sweep every resource of
   every kind against this rule.

   Both views draw the same set of connections: one only the other
   environment holds (a Lambda's database binding to Local PostgreSQL in Development, to
   RDS in Production) is drawn dimmed rather than left out, says so in its hover card and
   Inspector, and lights up only when hovered or selected itself, never because a node it
   touches is selected. Selection, hover and search keep their own strengths. The sixth
   category, CDK resource links, is cyan; its hover card
   and Inspector expose source evidence and distinguish inference from evaluated facts.
   - **Lit arcs.** The selection's and the hovered arc's are bright, with an arrowhead.
   - **Packets.** With motion on, the selection's arcs carry one to three packets at
     60 world units a second.
5. **Node captions** in screen space, centred above their plaques (see Labels).
6. **Titles.** Flat island titles sit 10 CSS pixels outside the projected left flank,
   measured against the visible tops and walls (including a VPC's foundation), without
   shadow or culling padding. Placement uses the painted geometry and the text's ink
   bounds. Collisions with islands, buildings, cards or other titles move a title along
   the same flank; if no clear position exists, it is omitted like an entity card.
   Placement is recomputed with the camera, keeping the gap fixed through zoom and pan.
   Production subnet heading cards use horizontal screen-space typography and zoom opacity,
   with camera-, scene- and font-dependent placement cached between settled frames. Development
   omits subnet headings entirely; these remain production networking concepts.

The loop draws on demand. A camera change, hover, selection, search or new data schedules one
frame. Frames continue only while the selection animates (motion on) or the camera is
tweening. A still picture draws nothing.

## Camera and input ([camera.ts](../../framework-studio/src/scene/camera.ts))

- **The camera** is the world point at the viewport's centre plus a zoom, in CSS pixels.
  The device pixel ratio enters only the canvas transform, so one transform serves drawing,
  picking and input. Pointer coordinates are taken relative to the canvas's bounding
  rectangle.
- **Zoom** runs from 0.05 to 2.5, allowing larger topologies to fit narrow views. Zooming about a point finds the world point before,
  zooms, finds it after, and moves the camera by the difference.
  - Wheel deltas in lines and pages are normalized to pixels.
  - Each event's delta is clamped to ±240 px, and the factor is `exp(−px · 0.0015)`.
  - Pinch uses two pointers.
- **Fit** shows the bounds with 40 px of padding, capped at 1.2×.
- **Tweens** take 450 ms, ease in and out, and interpolate zoom in log space. With reduced
  motion they are instant.
- **Inputs:**

  | Input | Action |
  | --- | --- |
  | Drag | Pan. A press that moves less than 6 px is a click |
  | Click icon, gateway or endpoint | Select that entity or fixture; click again to clear |
  | Click empty island terrain | Open island settings; click again to clear |
  | Click void | Clear the selection |
  | Double-click | Select and fly to the building (empty ground: zoom in) |
  | Arrow keys, `+` / `-`, `0`, `F`, Escape | Pan, zoom, fit, focus the selection, clear it |
  | Search field | Highlight matches and fade everything else; a selection temporarily overrides search |
  | Search field Escape | Clear the selection first, or clear the query if nothing is selected |
  | Clear search button | Restore the unfiltered view (or the current selection) |

- **Resize** keeps the world's top-left corner fixed, so opening the inspector moves
  nothing. React layout effects resize and redraw the canvas before paint when the
  inspector opens or closes; browser resize observations also redraw synchronously,
  keeping CSS dimensions, bitmap dimensions and camera projection in step. If the
  selection ends up hidden, the camera flies to it once at its current zoom. A selection made
  elsewhere (the inspector, the Board) that is off screen also brings its building into
  view.
- **Memory.** The camera is kept in module memory across view switches, for the life of the
  page.

### Rendering and input performance

The renderer retains vector paths for connections, the ground grid, plinths,
plaque faces and shared shadow circles. Scene preparation retains endpoint indexes,
wire lengths, bounds and required-input marker midpoints. Label cards and island
title placement are cached for a stationary camera; selection, hover, focus,
viewport, pixel ratio, scene and font changes invalidate the relevant caches.
Connection packets repaint at the native pixel ratio and original quality. Island
trim stays static; no bitmap scaling or reduced detail is used.

Connections outside the viewport are culled with room for arrows, packets, glows
and error markers. A frame requests another frame only when it paints moving
content; selecting a static network fixture or panning all motion off screen can
settle. Pointer hover events are coalesced to one hit test per animation frame,
while clicks remain synchronous. Connection bounds reject distant hit candidates
before exact polyline picking. The accessible entity controls are memoized so
tooltip movement and timing updates do not reconstruct their React tree.

See [performance findings and measurements](performance.md) for bottlenecks,
validation scope and further options.

## Picking ([picking.ts](../../framework-studio/src/scene/picking.ts))

The order follows what is painted on top, front first:

1. **Label cards.** Screen rectangles from the last frame, last painted first.
2. **Buildings.** World silhouettes, frontmost first.
3. **Gateway and endpoint furniture.** Hover and click (selects the `prop:` fixture).
4. **Arcs.** Within 6 screen pixels of the sampled curve, hover and click, including over terrain.
   Missing-input markers are also clickable, including over terrain. Connection labels
   appear only in the hover popup and inspector, never on the canvas lines.
5. **Terrain.** The painted slab tops and walls, plus the VPC foundation.
   Picking uses the camera inverse and each surface's actual height.
   Terrain away from connections remains clickable.

A ground-plane inverse is never used for picking, because it would return the tile behind
a raised one. Hover highlights the island and explains its terrace. Clicking empty
terrain opens its settings; clicking the void clears selection. Icons retain their
individual inspectors. The accessible entity list includes island settings buttons.

Island settings offer native shared defaults by service type: all Lambdas, HTTP,
WebSocket, events, tools, containers and database pools, as relevant to the island.
Boolean defaults use switches. Every field shows counts of current inheritors and
overrides; defaults apply across islands and to future declarations. Existing overrides
win. All service groups share the inspector's draft and pending-change count. Review
validates the combined configuration, and Apply All creates one undoable edit. Selecting
another icon or terrain island while dirty uses the shared unsaved-changes warning.
Islands without shared framework defaults show links to their individual entries.
Selecting an island lights its member nodes without forcing every label card to appear.

## Search ([focus.ts](../../framework-studio/src/scene/focus.ts))

The search field at the top of the map matches names, service kinds, route paths,
source directories, construct ids, input/environment key names, stack fields and network
fixtures. It is case-insensitive; every whitespace-separated term must occur in the
entity's metadata. Searching an island or subnet name includes its members. A matching
stack field highlights the owning stack. Resolved input and secret values are never
searched.

Matches receive the highlighted icon treatment and prioritised label cards, even at
overview zoom. Their containing islands remain visible. Nonmatching nodes, fixtures,
terrain and titles draw at 8 % of their usual opacity; unrelated arcs become faint.
No matches fades the entire map. Empty or whitespace-only input restores the overview.

Faded entities remain pickable. Clicking a node or island opens the usual inspector and
temporarily restores its normal selection spotlight, while preserving the query. Clearing
selection by clicking the void, closing the inspector or pressing Escape restores the
search. Existing unsaved-change guards still apply. Search changes only presentation;
the query lives in the mounted isometric view and never writes configuration or layout.

## Labels

- **Anchored captions.** Names end 64 world units above their tiles, centred on their
  plaques, with no leader lines. Hover and selection change styling and show full details;
  they never change caption position, size or truncation. Zoom preserves the same world anchor.
- **Measured truncation.** A caption uses at most 160 world units of width. Its text
  budget subtracts the authentication lock and padding before
  adding an ellipsis. Names shrink gently with the map instead of retaining a fixed
  screen size, with a 1.2 font-scale cap for close views. There is no overview cutoff:
  contrast eases from full at 0.85× to a 25% floor at 0.18×. Plates and borders fade
  faster than text, leaving a quiet layer of names over distant islands. Hovered,
  selected and search-matching captions keep full contrast without changing geometry.
  Hover fades the caption text, plate and border to full contrast over 120 ms and
  fades them back on exit. Reversing hover continues from the current opacity;
  paused or reduced motion applies the change immediately. Frames stop when the fade settles.
- **Environment tags.** DEV/PROD (or OFF) appears as a separate, fixed tag centred
  on the plinth's front edge. Tags share the name's zoom scaling, contrast and hover
  fade, with no zoom cutoff. Both-environment nodes have no tag. The same symbols,
  colors and presence rules apply, and clicking the tag selects its node.
- **Clearance.** The four-cell lattice gives captions their own space. The shared wire
  router reserves their world envelopes. Captions that collide with icons, corner badges,
  subnet headings, missing-input markers or canvas controls, or cross a viewport edge, are omitted
  until there is space. They never jump to another slot. Painting and picking use the same rectangles.

## Performance

Continuous slabs and cached icon geometry avoid drawing one sprite per terrain tile.
Slabs and standing items outside the viewport are culled. Search matches are computed
when the scene, model or query changes, independently of camera motion. Static search
does not run animation frames; selected-node motion and camera tweens do.
The readout in the bottom right shows a moving average of frame time.

## Debug hook

`window.__studioLandscape` is read-only, for Playwright and the console:

| Member | Returns |
| --- | --- |
| `camera()`, `viewport()` | The current camera and viewport |
| `screenOf(id)` | Screen positions of a building's roof and its card |
| `hullOf(id)` | Its silhouette in screen space |
| `cards()` | The cards as last drawn |
| `badges()` | Separate deployment-tag hit rectangles as last drawn |
| `connections()` | Group ids, visible endpoints, original relationship ids, availability, labels and projected paths |
| `pickAt(x, y)` | What a point would pick |
| `stats()` | Tiles, nodes, edges, items drawn, last frame time, frame count, current focus kind |
| `search()` | Whether search is currently active, focused node/fixture ids, and `opacityOf(id)` |

Browser checks combine it with real mouse and keyboard input: find where something is
drawn, then click there.

## Extending it

| To add | Change |
| --- | --- |
| A building kind | Its model-to-icon mapping in `icons.ts` and scene placement in `build.ts`; all kinds share `buildIconShape` and its picking silhouette |
| A region | A spec in `islandSpecs` (`build.ts`): its column, title, caption, bands and height. Keep captions to what the framework states. Give its island a trim in `ISLAND_TRIM` (`look.ts`); a test holds that every island has one |
| An icon | `ICONS` (`icons.ts`) and its spill colour in `ICON_TINT` (`look.ts`), which the type requires |
| An edge category | `RELATION_CATEGORY` and `CATEGORY_LABEL` (`src/lookup.ts`), `CATEGORY_COLORS` (`render.ts`) |

Stack fields remain in the underlying model and Inspector. The scene maps their edge
endpoints and selection highlight to the owning stack through `Scene.representatives`;
every original edge remains attached in the connection's members as evidence. Connections internal to one stack are
omitted from the landscape. The input inspector loads selected `.env` values separately
from the scene and offers validated catalog edits.
