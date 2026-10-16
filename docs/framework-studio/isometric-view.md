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
| `atlas.ts` | yes | Procedural 32 × 32 block sprites and the edge-extruded atlas, as RGBA pixels |
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

| Column (left to right) | Island | Holds | Height |
| --- | --- | --- | --- |
| Entry | HTTP API | `http` routes and service mounts | 2 |
| | WebSocket API | WebSocket route keys | 2 |
| | Agent routes | Agent browser paths | 2 |
| Compute | Lambda, outside the VPC | Lambdas with `placement.kind === "outside"`, columns grouped by HTTP, WebSocket and events | 3 |
| | VPC | Terraces `public` (5), `private` (4), `isolated` (3). Every target with `placement.kind === "vpc"` stands on its subnet's terrace. Gateways and endpoints from `network` stand on the terraces as hover-only furniture | 5 / 4 / 3 |
| | AgentCore | Agents and tools not placed in the VPC | 3 |
| | Step Functions | Workflows | 4 |
| Catalog | One per `resource.stack<T>()` | The stack's monument, then its members | 2–3 |
| | Inputs and secrets | Root inputs, secrets, and groups (a group keeps its own column) | 1 |

The terraces step down toward the catalog, so each step's wall faces the viewer. Height
means exposure: public is high ground, isolated is a sunken yard.

### Packing

- **The lattice.** Buildings stand every third cell (`STEP = 3`), so every label card has
  its own space at normal zoom. An island is its lattice plus a one-cell rim.
- **Near-square islands.** Each band packs about √n items per lattice column (2–6). A
  group (for example HTTP Lambdas) always starts a new column. The VPC gives every terrace
  the same depth.
- **Columns are screen-aligned.** Islands are placed in a frame where `sx = gx - gy` runs
  across and `sy = gx + gy` runs down, then converted back to grid cells. Islands therefore
  stay grid rectangles, columns read left to right, and islands stack straight down.
  - Gap between columns: 6 tile units.
  - Gap between islands: 5 tile units.
- **Alignment.** Compute is placed first. Entry and catalog islands, and the items inside
  them, are ordered by the barycentre (mean screen row) of what they connect to in
  compute, which keeps arcs short.
- **Worn corners.** Each island loses up to two cells at each corner, chosen by a
  deterministic hash, so it reads as land rather than a board.
- **Walls.** A tile's two front faces drop to a lower neighbour on the same island, or to
  the island's floor (lowest band height − 3) at the rim. Level neighbours get no internal
  wall.
- **Scenery.** About 6 % of empty interior cells get a lamp, shrub, rock or shard matched
  to the ground. It is deterministic, never on a ghost island, and never picked.

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
- Islands are ghosted the same way:
  - a stack absent from this graph is drawn at 20 % opacity;
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

## Terrain ([atlas.ts](../../framework-studio/src/scene/atlas.ts))

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
  | copper | Step Functions |
  | plum | AgentCore |
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

Entities now use `buildIconShape`: a low isometric plinth and an upright 48-unit plaque
carrying a 40-unit SVG. The plaque is part of the picking hull and arcs anchor at its
top. `icons.ts` maps target kinds, route surfaces and catalog member types to official AWS
Architecture Icons (July 2026) or generic Lucide outlines. Assets and attribution live
in `framework-studio/public/icons/`; all are served locally. SVGs are loaded once per
renderer; completion schedules a redraw even when motion is paused. Disposal clears
their callbacks. Presence controls active versus ghost opacity and dashed outlines.
Local execution is active in Development; local-only workloads are ghosted in Production.

Network gateways and endpoints use the same icon plaques: AWS VPC gateway icons,
S3 and DynamoDB service icons for their endpoints, and the VPC endpoint icon for other
services. They remain hover-only furniture. Furniture has its own lattice spacing so
plaques do not overlap.

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
6. **Titles.** Island titles sit on each island's left flank. Terrace names are painted on
   the VPC's front rim.

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
  | Click | Select; click again or click the ground to clear |
  | Double-click | Select and fly to the building (empty ground: zoom in) |
  | Arrow keys, `+` / `-`, `0`, `F`, Escape | Pan, zoom, fit, focus the selection, clear it |

- **Resize** keeps the world's top-left corner fixed, so opening the inspector moves
  nothing. If the selection ends up hidden, the camera flies to it. A selection made
  elsewhere (the inspector, the Board) that is off screen also brings its building into
  view.
- **Memory.** The camera is kept in module memory across view switches, for the life of the
  page.

## Picking ([picking.ts](../../framework-studio/src/scene/picking.ts))

The order follows what is painted on top, front first:

1. **Label cards.** Screen rectangles from the last frame, last painted first.
2. **Buildings.** World silhouettes, frontmost first.
3. **Gateway and endpoint furniture.** Hover only.
4. **Arcs.** Within 6 screen pixels of the sampled curve, hover only.
5. **Terrain.** Each tile's top diamond and visible walls at its own height, frontmost
   first.

A ground-plane inverse is never used for picking, because it would return the tile behind
a raised one. Clicking terrain or the void clears the selection. The hover card explains
whichever of the five is under the pointer.

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

These are measured in headless Chromium on the repository's real graph: 74 entities,
1,222 tiles, 79 arcs.

| Case | Cost |
| --- | --- |
| Full overview, about 1,300 items drawn | 3.5–3.8 ms a frame |
| Busiest selection (`cognito.userPool`) animating at overview | 2.9 ms median, 5.7 ms p95 |
| Zoomed in | About 500–800 items after culling, 2–5 ms |
| No selection, or motion paused | 0 frames |

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
| `stats()` | Tiles, nodes, edges, items drawn, last frame time, frame count |

Browser checks combine it with real mouse and keyboard input: find where something is
drawn, then click there.

## Extending it

| To add | Change |
| --- | --- |
| A building kind | `ShapeKind` and a case in `buildShape` (`shapes.ts`); a palette entry in `BUILDINGS` (`render.ts`); the mapping in `resourceShape` or `targetItem` (`build.ts`); the kind list in the silhouette test |
| A material | `Material` and `MATERIALS`, `SCENERY` (`build.ts`); `PALETTES` (`atlas.ts`). The atlas grows by a row |
| A region | A spec in `islandSpecs` (`build.ts`): its column, title, caption, bands, material and height. Keep captions to what the framework states |
| An edge category | `RELATION_CATEGORY` and `CATEGORY_LABEL` (`src/lookup.ts`), `CATEGORY_COLORS` (`render.ts`) |
