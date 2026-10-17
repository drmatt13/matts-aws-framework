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
| `build.ts` | yes | Model → `Scene`: islands, tiles with walls, buildings, gateways and endpoints, scenery, edges, bounds |
| `shapes.ts` | yes | Building geometry as lit polygons, with a convex silhouette |
| `slabs.ts` | yes | Graphite look: each island as chamfered slabs per terrace, front walls with gradients, trim polylines, pads, cast shadows, island painter's order |
| `look.ts` | yes | The two looks, graphite colour tokens, trim colour per island, icon tint per icon |
| `atlas.ts` | yes | Classic look: procedural 32 × 32 block sprites and the edge-extruded atlas, as RGBA pixels |
| `frame.ts` | yes | VPC foundation and frame colour |
| `camera.ts` | yes | World↔screen transforms, pan, pointer-anchored zoom, wheel normalization, fit, tween |
| `picking.ts` | yes | Point-in-polygon, entity picking, height-aware tile picking, arc geometry, card placement |
| `render.ts` | no (canvas) | `SceneRenderer`: caches per scene, draws per frame |
| `grid.ts` | yes | Viewport-bounded, world-anchored ground grid with zoom-dependent spacing |
| `../icons.ts` | yes | Shared mapping from model entities to local AWS/Lucide SVG assets |
| `views/Isometric.tsx` | no (React) | Mounting, input, the render loop, toolbar, legend, hover card, accessible list, debug hook |

Everything marked pure runs under Node and is unit-tested in
[test/landscape.test.ts](../../framework-studio/test/landscape.test.ts).

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

### Regions

| Placement | Island | Holds | Height |
| --- | --- | --- | --- |
| Upper left | APIs | HTTP routes, service mounts, WebSocket keys and agent browser paths on one layer | 2 |
| Lower left | Inputs and secrets | Root inputs, secrets, and groups on one shared lattice | 1 |
| Upper right | Serverless compute | HTTP, WebSocket, event and AgentCore tool Lambdas outside the VPC on one shared lattice | 3 |
| Lower right | VPC | Subnets `public`, `private` and `isolated`, side by side at one height. Every target with `placement.kind === "vpc"` stands on its subnet. Gateways and endpoints from `network` stand on the subnets as hover-only furniture | 4 |
| Shared lower row, first | Agents | AgentCore agents not placed in the VPC | 3 |
| Shared lower row, second | Workflows | Step Functions workflows | 4 |
| Shared lower row, third | Local development | The authored Compose PostgreSQL service; active in Development, ghosted in Production | 2 |
| Shared lower row, fourth | Stacks | All `resource.stack<T>()` entries together, one node per class; public fields expand in the inspector | 2 |

The subnets stand level, left to right from public to isolated. Exposure reads in colour
rather than height: in the graphite look, public is green, private blue and isolated
purple.

Each network island has a shallow isometric foundation beneath all its terraces, with
a perimeter and inset border: teal in the classic look, VPC violet in the graphite one. It groups the subnets as one VPC. Geometry comes
from each island's own footprint, ready for separate boundaries if multiple VPC islands
are introduced. The foundation is dashed and faded with a blueprint VPC. It participates
in camera bounds without adding an entity or moving workloads.

API and Lambda panels have no group perimeter. VPC-attached Lambdas remain on
subnet terraces inside the VPC foundation.

### Packing

- **The lattice.** Buildings stand every third cell (`STEP = 3`), so every label card has
  its own space at normal zoom. An island is its lattice plus a one-cell rim.
- **Near-square islands.** Each band packs about √n items per lattice column (2–6).
  Service groups keep their order but continue into the same columns, without reserving
  empty cells between groups. Bands with fewer nodes are centred in the available depth.
  Network fixtures reserve a separate front row on the same three-cell lattice. The VPC
  gives every terrace the same depth. Footprints are measured again on every model change;
  the existing row packer shifts neighbours and wraps growing islands automatically.
- **Columns are screen-aligned.** Islands are placed in a frame where `sx = gx - gy` runs
  across and `sy = gx + gy` runs down, then converted back to grid cells. Islands therefore
  stay grid rectangles. The two main columns plus a shared lower row give the current
  application a roughly 16:9 footprint for desktop monitors.
- **Rows within a column.** A column is as wide as its widest island. Taking islands in
  order, each joins the row above while the row still fits that width; otherwise it starts
  a new row. An island after the first in a row first leaves room on its left for its
  flat title (`titleRoom`), so labels never land on a neighbour. Rows are centred in the
  column, and islands in a row are centred on the row's height. The same packing places
  Agents, Workflows, Local development and Stacks, in that order, across the full width
  below the main columns. A compact supporting row can widen the main gutter, up to 1.5×
  the natural column width; a supporting island that outgrows that row wraps to the next.
  - Gap between columns: 6 tile units.
  - Gap between rows: 5 tile units.
- **Alignment.** Compute is placed first. Items inside APIs and Inputs and secrets follow
  the barycentre (mean screen row) of what they connect to in compute. Island order stays
  fixed, so Local development does not move to the top based on its connections.
- **Chamfered corners.** Each corner is cut back by one straight chamfer (`CHAMFER = 2`
  cells along each edge, at most a third of the island's shorter side). A cell is removed
  exactly when its centre falls outside the cut (`chamfered`), so tiles, walls, picking
  and the graphite outline agree. The cut never reaches a building, a fixture or a terrace
  name. On screen the outline is an octagon: the front corner becomes a facet facing the
  viewer, and the side cuts are vertical.
- **Walls.** A tile's two front faces drop to a lower neighbour on the same island, or to
  the island's floor (lowest band height − 3) at the rim. Level neighbours get no internal
  wall.
- **Clear terrain.** No decorative rocks, lamps, shrubs or shards are placed on tiles.

### Presence

`presence` is computed per entity from the selected mode:

| Presence | Meaning | Drawn as |
| --- | --- | --- |
| `built` | Enabled in the selected environment: Development is `lanes.local || lanes.dev`; Production is `lanes.prod` | Solid |
| `other` | Enabled only in the other environment | Dashed outline (ghost) |
| `nowhere` | Enabled in no lane | Ghost |
| `absent` | A catalog entry this graph declares `undefined` | Ghost |
| `present` | A catalog entry this graph holds | Solid |

- A route follows its target.
- The local PostgreSQL service follows its execution environment. Locally executing
  database consumers connect to it; AWS database bindings keep their resource destination.
  It is a Compose service (`local:postgres`), not an AWS catalog resource or VPC member.
- Islands are ghosted the same way:
  - absent stacks have ghost nodes on the shared Stacks island;
  - an island with nodes but none enabled in the selected environment uses the same
    20 % opacity and grid outline; an island with any enabled node stays solid;
  - the VPC is a translucent blueprint unless the graph is production and
    `network.builtInProd` is true.
- Labels have no badge for entities available in both environments. A teal flask Dev
  badge marks Development only, a violet diamond Prod badge Production only, and Off
  marks disabled workloads. Execution location never gets a separate deployment badge.
  Badge paths, colors and semantics are shared by canvas and DOM views in `deployment.ts`.
  Catalog badges use absence in both snapshot models; they are never guessed from types.
  The drawing measures badge width only when one exists. Auth locks remain independent.

## Terrain: two looks

A toolbar toggle (the sparkle button) switches between **Graphite**, the default, and
**Classic**. The choice is remembered per browser in `localStorage`
(`framework-studio:isometric-look`) and falls back to Graphite when storage is unavailable.
A look changes how things are drawn, never where they stand, what they say, or what can be
picked.

### Graphite ([slabs.ts](../../framework-studio/src/scene/slabs.ts), [look.ts](../../framework-studio/src/scene/look.ts))

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
  | Local development | `#2fb3bc` |
  | Stacks | `#6f93c9` |
  | Inputs and secrets | `#DD344C` (Secrets Manager) |

  The tops take 7 % of the trim. Faint hairlines are etched along tile edges, and an
  inset pad with a trim-coloured outline sits under every building and fixture.
- **Atmosphere.** A navy void, the grid under a vignette so it fades outward, and two soft
  additive blooms (teal upper left, violet lower right). Each island casts a soft
  shadow, drawn as four inflated layers, onto a floor five steps below it.
- **Names on walls.** An island's title is written in perspective along its front-left
  wall, in uppercase with letter spacing and in its trim colour, sheared to the wall's
  slope. A terraced island names each terrace on its own stretch of wall instead. A name
  is written only when it would be at least 9 px tall and fits its wall; otherwise the
  flat title from the classic look stands in for it.
- **Ghosts.**
  - An unbuilt VPC is a blueprint, in each subnet's own colour: a translucent top with
    hairlines, dashed outlines and walls, no glow and no cast shadow.
  - Disabled islands draw at 30 % with a dashed trim.
- **Focus.** With a selection, islands holding nothing in the spotlight dim their trim to
  40 %. While motion is on, a bright dash runs along the selected building's island trim.
  This happens only while a selection exists, so a still picture still draws nothing, and
  reduced motion disables it.
- **Order.** Shadows, then the VPC foundation, then whole islands in `islandDrawOrder`.
  Of two islands that overlap on screen, the one wholly behind on the grid draws first.
  Within an island, each terrace's slab is drawn, then what stands on it.

### Classic ([atlas.ts](../../framework-studio/src/scene/atlas.ts))

- **Sprites** are 32 × 32 and generated in code:
  - the top diamond occupies rows 8–24 (corners (16, 8), (32, 16), (16, 24), (0, 16));
  - a one-step side skirt sits below it, the left face lighter than the right;
  - each is drawn at 2× into a 64 × 64 quad, so the top covers exactly one tile and the
    skirt one elevation step. A sprite is scaled whole, never squashed.
- **Materials.** There are 11:

  | Material | Island |
  | --- | --- |
  | limestone | HTTP API |
  | basalt | WebSocket API |
  | quartz | agent routes |
  | circuit | Lambda |
  | moss | public subnet |
  | lichen | private subnet |
  | shale | isolated subnet |
  | copper | Workflows |
  | plum | Agents |
  | granite | catalog stacks |
  | sand | inputs and secrets |

  Each has three variants, chosen by a hash of the cell, and eight elevation levels with
  brightness baked in, so higher ground is lighter. Surface grain, seams and speckles
  blend back toward the base material at 24% contrast so icons and arcs remain prominent.
- **The atlas** is 24 × 11 cells of 34 × 34 pixels (816 × 374). Each sprite sits inside
  its cell with its edge pixels extruded one pixel outward, so sampling the inner 32 × 32
  never bleeds a neighbour in. It is generated once per page load and drawn with
  `imageSmoothingEnabled = false`, with half a pixel of overdraw to close seams that
  scaling would open.
- **Walls** below the skirt are polygons. A rim wall fades into the void through a cached
  vertical gradient. A terrace step is solid.

## Buildings ([shapes.ts](../../framework-studio/src/scene/shapes.ts))

In the graphite look, each building also has:

- a soft contact shadow;
- an additive spill of its icon's colour on the ground (`ICON_TINT`);
- a raised graphite plinth with a lit front edge, on an etched pad;
- a plaque with a depth edge, a glass highlight and a hairline in the icon's colour. When
  selected, its hairline turns white and glows in the icon's colour.

A ghost (outside this environment) has no plinth, pad, shadow or spill: its translucent
plaque stands on bare ground.

All of it stays inside the existing plaque box, so `buildIconShape` and its picking hull
are shared by both looks.

Entities now use `buildIconShape`: a low isometric plinth and an upright 48-unit plaque
carrying a 40-unit SVG. Every plinth uses the same neutral gray palette, with face shading
for depth; service identity comes from the SVG. The plaque is part of the picking hull and arcs anchor at its
top. `icons.ts` maps target kinds, route surfaces and catalog member types to official AWS
Architecture Icons (July 2026) or generic Lucide outlines. Assets and attribution live
in `framework-studio/public/icons/`; all are served locally. SVGs are loaded once per
renderer; completion schedules a redraw even when motion is paused. Disposal clears
their callbacks. Presence controls active versus ghost opacity and dashed outlines.
Local execution is active in Development; local-only workloads are ghosted in Production.

WebSocket routes and functions carry a small connection badge; agent routes and tool
Lambdas carry an AgentCore badge; event Lambdas carry a lightning badge. These sit at
the main icon's lower-right corner, share its disabled/dimmed opacity and belong to its
clickable silhouette. HTTP nodes keep their plain API Gateway or Lambda icon.

Network gateways and endpoints use the same icon plaques: AWS VPC gateway icons,
and a VPC endpoint icon with a small service badge at its lower-right corner. The badge
reuses the Lambda role-badge renderer and picking silhouette, including ghost/dimmed
opacity in both looks. S3, DynamoDB and other locally mapped services use their service
artwork; unmapped services use a generic box and retain their service name in the hover
card. Every declared endpoint is shown, with no four-endpoint display limit.
They remain hover-only furniture. Each names the subnets whose traffic it
carries (`Prop.serves`): the internet gateway serves public, the egress-only and NAT
gateways serve private, and endpoints serve all three. With a selection, a fixture dims
with everything outside the spotlight unless it serves the selected building's subnet
(`SceneNode.band`). Furniture has its own lattice spacing so
plaques do not overlap. Gateways and endpoints use translucent icons and dashed plinths
whenever the selected graph does not build their VPC, including Development.

The procedural structures below remain available for scenery and shape primitives;
model entities and network furniture no longer use the old building glyphs.

- **Primitives.** Cuboids, cylinders, pyramids, an octahedron crystal, rings, a vertical
  hoop, masts, and glyphs painted flat on a roof. They are scaled by `TALL = 1.35` and
  `FOOT = 1.12`, so buildings read as structures. Each face carries a part (body, accent,
  dark, glow) and a shading (top, left, right, flat). The renderer lights each part from a
  per-kind palette.
- **Kinds:**

  | Entity | Kind |
  | --- | --- |
  | Routes | `gate`; `mount` for service mounts; `pylon` for WebSocket keys; `portal` for agent routes |
  | Workloads | `lambda` (roof glyph: λ HTTP, ⇄ WebSocket, check for an authorizer, bolt for events, plus for tools); `service` (tower); `task` (crate); `workflow` (ziggurat); `agent` (floating crystal) |
  | Catalog | `stack` (monument); `group`; `table`; `bucket`; `queue`; `topic`; `bus`; `userpool`; `database`; `value` (a stack's string field); `secret`; `input`; `construct` |
  | Scenery | `shrub`, `lamp`, `rock`, `shard` |

  A stack member's kind comes from its declared type text (`resourceShape`).
- **Anchors.** Every shape returns its faces in paint order, a convex silhouette (`hull`)
  for picking, and a `top` point where arcs attach.

## Rendering ([render.ts](../../framework-studio/src/scene/render.ts))

`SceneRenderer.setScene` runs once per scene:

- it merges tiles, buildings, furniture and scenery into one painter's-order list (tiles
  of a diagonal row before what stands on it);
- it caches every rim-wall gradient, each arc's sampled points and length, and each draw
  item's world bounding box.

`render` runs per frame:

1. **The void and grid.** A radial gradient in screen space, then hairlines on the ground
   plane in world space. Grid slopes match the terrain (±0.5). Every fifth line is
   slightly stronger; zooming out coarsens spacing to avoid moiré. Only lines crossing
   the viewport are generated. Pan and pointer-anchored zoom keep the lattice attached
   to the world.
2. **Underglow.** A soft light under each island: a circle under a 1 : 0.5 squash, so the
   fade reaches its edge.
3. **Terrain and buildings**, in the cached order. Items outside the viewport (plus a
   margin) are culled. Buildings are drawn by presence, and the selection gets a pulsing
   ring on its tile. When a selection exists, everything outside its neighbourhood is
   dimmed.
4. **Arcs.** Quadratic curves in the air, control point
   `(midpoint x, min(a.y, b.y) − 24 − 0.16 · length)`, coloured by the Board's five
   categories and filterable with the same chips. Derived edges and source-inferred
   CDK links are dashed. The sixth category, CDK resource links, is cyan; its hover card
   and Inspector expose source evidence and distinguish inference from evaluated facts.
   - **Lit arcs.** The selection's and the hovered arc's are bright, with an arrowhead.
   - **Packets.** With motion on, the selection's arcs carry one to three packets at
     60 world units a second.
5. **Label cards** in screen space, with leader lines to their roofs (see Labels).
6. **Titles.** Flat island titles sit 10 CSS pixels outside the projected left flank,
   measured against the visible tops and walls (including a VPC's foundation), without
   shadow or culling padding. Both looks use their own painted geometry and the text's ink
   bounds. Collisions with islands, buildings, cards or other titles move a title along
   the same flank; if no clear position exists, it is omitted like an entity card.
   Placement is recomputed with the camera, keeping the gap fixed through zoom and pan.
   Terrace names and perspective wall names keep their existing placement.

The loop draws on demand. A camera change, hover, selection or new data schedules one
frame. Frames continue only while the selection animates (motion on) or the camera is
tweening. A still picture draws nothing.

## Camera and input ([camera.ts](../../framework-studio/src/scene/camera.ts))

- **The camera** is the world point at the viewport's centre plus a zoom, in CSS pixels.
  The device pixel ratio enters only the canvas transform, so one transform serves drawing,
  picking and input. Pointer coordinates are taken relative to the canvas's bounding
  rectangle.
- **Zoom** runs from 0.18 to 2.5. Zooming about a point finds the world point before,
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
  | Click icon | Select that entity; click again to clear |
  | Click empty island terrain | Open island settings; click again to clear |
  | Click void | Clear the selection |
  | Double-click | Select and fly to the building (empty ground: zoom in) |
  | Arrow keys, `+` / `-`, `0`, `F`, Escape | Pan, zoom, fit, focus the selection, clear it |
| Sparkle button | Switch between the graphite and classic looks |

- **Resize** keeps the world's top-left corner fixed, so opening the inspector moves
  nothing. React layout effects resize and redraw the canvas before paint when the
  inspector opens or closes; browser resize observations also redraw synchronously,
  keeping CSS dimensions, bitmap dimensions and camera projection in step. If the
  selection ends up hidden, the camera flies to it once at its current zoom. A selection made
  elsewhere (the inspector, the Board) that is off screen also brings its building into
  view.
- **Memory.** The camera is kept in module memory across view switches, for the life of the
  page.

## Picking ([picking.ts](../../framework-studio/src/scene/picking.ts))

The order follows what is painted on top, front first:

1. **Label cards.** Screen rectangles from the last frame, last painted first.
2. **Buildings.** World silhouettes, frontmost first.
3. **Gateway and endpoint furniture.** Hover only.
4. **Terrain.** The painted slab tops and walls in Graphite, or tile tops and walls in
   Classic, plus the VPC foundation. Picking uses the camera inverse and each surface's
   actual height. Empty terrain takes precedence over arcs so it remains clickable.
5. **Arcs in the void.** Within 6 screen pixels of the sampled curve, hover only.

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

## Labels

- **Cards hang at a fixed height.** Each card sits 64 world units above its building's
  tile, so a row of cards reads as a row, and a leader line runs from the card to the roof.
- **Size.** Cards scale with zoom between 0.8 and 1.2. Below 0.55× only emphasised cards
  show: the selection, the hovered building, and what the selection touches. Emphasised
  cards stay at least 0.9 scale.
- **Placement.** `acceptCards` lets the selection, then the hover, then the spotlight,
  then the rest from the front claim space. A card that would land on one already placed
  is dropped (the inspector still names it). Cards are then drawn in painter's order.

## Performance

These were measured in headless Chrome at 1600 × 1100 on the repository's real graph: 53
entities, 897 tiles, 69 arcs. Each figure is a single frame-time reading.

| Case | Graphite | Classic |
| --- | --- | --- |
| Full overview | 67 slabs and buildings, about 1 ms | 954 items, about 1.4 ms |
| A selection animating at overview | about 2.4 ms | about 4.9 ms |
| Zoomed to 1× | about 0.8 ms | about 1.2 ms |
| No selection, or motion paused | 0 frames | 0 frames |

The readout in the bottom right shows a moving average.

## Debug hook

`window.__studioLandscape` is read-only, for Playwright and the console:

| Member | Returns |
| --- | --- |
| `camera()`, `viewport()` | The current camera and viewport |
| `screenOf(id)` | Screen positions of a building's roof and its card |
| `hullOf(id)` | Its silhouette in screen space |
| `cards()` | The cards as last drawn |
| `pickAt(x, y)` | What a point would pick |
| `stats()` | Tiles, nodes, edges, items drawn, last frame time, frame count, current look |

Browser checks combine it with real mouse and keyboard input: find where something is
drawn, then click there.

## Extending it

| To add | Change |
| --- | --- |
| A building kind | `ShapeKind` and a case in `buildShape` (`shapes.ts`); a palette entry in `BUILDINGS` (`render.ts`); the mapping in `resourceShape` or `targetItem` (`build.ts`); the kind list in the silhouette test |
| A material | `Material` and `MATERIALS`, `SCENERY` (`build.ts`); `PALETTES` (`atlas.ts`). The atlas grows by a row |
| A region | A spec in `islandSpecs` (`build.ts`): its column, title, caption, bands, material and height. Keep captions to what the framework states. Give its island a trim in `ISLAND_TRIM` (`look.ts`); a test holds that every island has one |
| An icon | `ICONS` (`icons.ts`) and its spill colour in `ICON_TINT` (`look.ts`), which the type requires |
| An edge category | `RELATION_CATEGORY` and `CATEGORY_LABEL` (`src/lookup.ts`), `CATEGORY_COLORS` (`render.ts`) |

Stack fields remain in the underlying model and Inspector. The scene maps their edge
endpoints and selection highlight to the owning stack through `Scene.representatives`;
the original edge remains attached as evidence. Connections internal to one stack are
omitted from the landscape. The input inspector loads selected `.env` values separately
from the scene and offers validated catalog edits.
