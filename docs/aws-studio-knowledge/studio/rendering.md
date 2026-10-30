---
id: studio.rendering
summary: Board layout and the Isometric scene, bounded optimizer, connection routing, Canvas rendering and picking.
read_when:
  - Improving layout, routing, performance, focus, or selection
source:
  - framework-studio/src/layout.ts
  - framework-studio/src/scene/build.ts
  - framework-studio/src/scene/layout-optimize.ts
  - framework-studio/src/scene/routing.ts
  - framework-studio/src/scene/corridors.ts
  - framework-studio/src/scene/render.ts
  - framework-studio/src/endpoint-services.ts
  - framework-studio/src/input-groups.ts
  - framework-studio/src/inspector-navigation.ts
  - framework-studio/src/styles/theme.css
  - framework-studio/src/views/Isometric.tsx
  - framework-studio/src/views/InspectorNavigation.tsx
related:
  - studio.graph-model
  - studio.snapshots
---
# Board and Isometric rendering

React-owned map/Board controls, panels, resource lists and tooltip portals use Tailwind
utilities and shared UI recipes; the [design system](../../framework-studio/ui-design-system.md)
owns their conventions. CSS variables in `styles/theme.css` own application colors,
fonts and density. Always-dark map DOM tokens are root-visible so portals receive the
same palette. `scene/look.ts` continues to own artwork/material palettes;
`deployment.ts` supplies deployment badge data to both Canvas and DOM. Runtime geometry,
SVG paths, tooltip positions and splitter dimensions remain TypeScript/inline values.
Never read computed CSS in the drawing frame loop or move camera/routing state into
styling abstractions. Preserve `window.__studioLandscape` diagnostics and stable data
markers used for workspace measurement and accessible row navigation.

The database diagram retains its 340px tables, 69px header plus border (70px routing
accounting), 30px rows and 34px footer. CodeMirror's generated DOM uses its dedicated
adapter; editor identity/undo and Canvas scheduling are independent of utility CSS.


Isometric always retains its topology islands and real VPC/subnet terraces. The compact
key/value tag filter changes only visual presence: nonmatches use the same transparent
style as resources unavailable in the active deployment mode. Untagged and empty values
remain distinct. Filtering preserves canonical IDs, positions, network placement, edges,
source links and inspector selection; it never changes actual deployment availability.
Filter state is a view preference and never stages a source edit.
Tag keys and value totals use active-mode membership: enabled workload lanes and routes,
non-absent catalog entries, enabled local services and built production VPCs. Union-topology
placeholders retain their metadata for filtering/inspection but contribute no counts.
Development VPCs use the continuous blueprint deck: one opaque surface in the VPC violet with
dashed edges, with no per-subnet colour. Production renders every declared VPC
and its gateways/endpoints as solid terraces, including unused VPCs. Captions and hover facts
still report whether production actually builds the network; rendering never provisions it.
The first tag selector includes **Untagged**, matching entities with no effective tags at all,
with mode-scoped totals. The value selector's **Untagged** option instead means missing the
selected key. Empty values and inherited tags count as tags.
Untagged results exclude plain input parameters, namespace containers, environment files
and local database fixtures. Every stack, framework-built or cataloged, is a candidate. Tagged
parameters still match explicit tag values. This applies to both no-tags and missing-key filters.

VPC fixtures wrap into approximately square grids within their subnet. Measurement reserves
separate compute and fixture rows across the terraces; placement reuses these measured
coordinates. Endpoint count grows width and depth together, preserving every fixture,
its service badge, stable ID, subnet ownership and picking silhouette. Gateways sit on
the left-facing perimeter, leaving the interior for compute and the endpoint grid.
Canvas mini badges use the same local AWS SVG service/family catalog as the endpoint
picker (`endpoint-services.ts`); the renderer loads selected artwork once per instance.
Framework ownership is classified by `shared/framework-management.ts` and displayed
as the same mini lock used by inspector ownership badges. A warning or endpoint-service
badge remains on the right when the additional management lock occupies the left;
the icon hull includes both for picking, routing obstacles and label placement.
The zoom floor permits narrow-view fits as network fixture counts grow.
Every selectable canvas hit, including gateways, endpoints and connections, uses a pointer cursor.
Island selection and hover outlines paint with the foundation and terrace surfaces,
before standing resources. Each terrace clips its portion of the outline to its own
painted top/walls; a later terrace never repaints a whole-island overlay across earlier
resource icons. Preserve this painter order when changing terrain or selection styling.

Island titles always stay horizontal outside the left flank; no names are painted onto
island walls. Production subnet headings use dark horizontal cards with 13 px detail
text and subnet-coloured cues. Below 0.65×, text and card geometry shrink gently using
the node-caption scale. Each sits just outside the top-right edge, with its bottom-left
corner anchored near the midpoint of its zone's rim. A small screen-space gap scales
with the card. The trailing name balances its midpoint anchor with the painted end cap,
sliding halfway back along the rim when it overhangs. At overview zoom, neighbouring
headings keep at least four screen pixels of separation via a minimal continuous slide
along the same rim. This terrain bound is independent of viewport clipping. No connector lines or dots are drawn. Icons never trigger independent lifts that
scatter names away from the network. Headings track the camera exactly and share its
existing easing/reduced-motion behavior. Viewport edges never reflow or hide names:
the canvas clips them naturally. Overview opacity follows the node-caption fade convention,
but holds full contrast down to 0.5× and reaches a stronger 50% text floor at 0.08×. Cards dissolve
faster than text. Resource captions yield to section headings.
No independent heading animation runs at rest. Placement caches invalidate with
camera, viewport, scene and font changes. Development shows no subnet names on the canvas
or VPC hover title; the declaration and inspector still retain their networking configuration.

Isometric's one side panel, below its toolbar, shows **Resources** or the **Inspector**, never
both; Database keeps the right-hand inspector. The panel sits on the map's right; it starts
closed and the **Resources** toggle sits at the toolbar's far right, after the view controls.
The list shows canonical map entities with registry icons, names and types, grouped by
island, plus search results and validation errors; any selection opens the same Inspector
in the same panel.

Inspector links extend a contextual trail through the shared `StudioProvider` navigation.
**Back to <previous title>** retraces one accepted browser-history visit; the separate
**Resources** action ends the selection and restores the original root list row, search,
type and scroll. A new map/list selection starts a new trail, while a direct link has the
Resources fallback. The standalone inspector uses the same contextual Back control.
Back and browser Back/Forward restore scroll, open disclosures and triggering-control
focus; a fresh destination opened inside the panel starts at its header and focuses Back.
`inspector-navigation.ts` retains presentation metadata in memory for at most 200 accepted
visits, separately per source mode, without form values, drafts, secrets or DOM references.
Close panel ends the selection, closes the panel and returns focus to the map. Contextual
Back, Resources, Close and the toggle retain the existing unsaved-draft warning; cancelled
navigation never changes the trail.

Opening the panel keeps the map's window position, and every new selection comes into view
at the same zoom (cut-off ones slide just far enough, unseen ones are centred); on narrow
windows the panel sits below the canvas. Search/type filtering changes the list and map
emphasis, never source or infrastructure identity. Missing implementation artifacts add an
attention marker to the resource navigator, Board node and Isometric caption/hover;
selecting that canonical resource exposes its configured path and reviewed repair. These
source-health facts do not imply runtime readiness. Existing keyboard access to every
connection and network fixture is retained. The navigator explicitly distinguishes the
declaration map from running-state evidence in Deploy.

Search and tag filters use the shared control geometry and inset chevrons. The search match count sits inside the field, and tag selects keep fixed widths with their clear control following the last one (the value select appears only once a key other than Untagged is chosen); the tag match count appears in the map footer (and is announced), so the toolbar keeps one height. Clearing
either restores keyboard focus to the surviving search/key control. Camera controls
are a named group; long tag selections retain their full value in their tooltip.
All controls sit in the shared workspace toolbar outside the measured `.landscape`
canvas container. The toolbar participates in normal flow, so wrapping and search
feedback reduce the canvas viewport without obscuring resources. Resize, picking,
hover and fit keep using the inner scene container. Renderer timing remains in
`window.__studioLandscape.stats()`; normal chrome shows resource/connection counts.
Isometric, Studio's home view at `/` (`/isometric` redirects there), uses the shared
navbar's `SourceEnvironment` selector. `Shell` keeps that selector and source validation
available on every route, including empty/error maps. The map toolbar contains search,
tag filters and camera controls. Named AWS targets remain in operational workspaces.
See the [UI design system](../../framework-studio/ui-design-system.md) for route gutters,
surface and responsive ownership. Board uses a labeled creation action and a themed
chooser; its trailing legend and action wrap together.
Board keeps resource-only and local-service graphs visible even before any compute
is declared; its creation menu remains available on those valid graphs.
The landscape entity list becomes a bounded visible navigator while it contains
keyboard focus. Arrow keys and Home/End browse the existing entity order; Enter
inspects, and Escape returns focus to the canvas without changing selection.
An empty/error graph shows configuration-health guidance; canvas renderer and
wheel listeners mount when a later valid snapshot restores entities, and dispose
again if the graph becomes empty.

Board's [layout.ts](../../../framework-studio/src/layout.ts) arranges entry, compute and catalog columns with role grouping and SVG connections. Isometric builds a separate geometric scene from the same [graph model](graph-model.md); layout coordinates are disposable projections, never infrastructure configuration.

| Stage | Source / important behavior |
| --- | --- |
| Group and measure | `buildScene` in [scene/build.ts](../../../framework-studio/src/scene/build.ts): semantic API/compute/orchestration/resource islands; VPC subnet terraces; member visibility and measured footprints |
| Graph for layout | [layout-graph.ts](../../../framework-studio/src/scene/layout-graph.ts): weighted connections, dev/prod union topology; layout reversals do not change semantic edge direction |
| Initial placement | [layout.ts](../../../framework-studio/src/scene/layout.ts): semantic rows, network placement and aspect-aware packing |
| Optimize | `optimizeLayout` in [layout-optimize.ts](../../../framework-studio/src/scene/layout-optimize.ts): bounded proxy links, mutually reachable grouping, dependency ranking/barycentric ordering, candidate moves/swaps, prior-position reuse and bounded caches |
| Score | `measureLayout` / `measureSceneLayout` in [layout-quality.ts](../../../framework-studio/src/scene/layout-quality.ts): heavy overlap penalties, labels, crossings, obstacles, connection length, aspect and movement |
| Route | `routeConnections` in [routing.ts](../../../framework-studio/src/scene/routing.ts): `routeArcs` picks each connection's quadratic from bounded bow candidates by sampled obstacle/crossing costs; `separateCorridors` in [corridors.ts](../../../framework-studio/src/scene/corridors.ts) then spreads only the wires competing for one corridor. Cached polylines; heuristic, not a global routing solver |
| Draw | `SceneRenderer` in [render.ts](../../../framework-studio/src/scene/render.ts): Canvas2D, cached Path2D/geometry, viewport culling, DPR handling, caption collisions and zoom-dependent labels |
| Interact | [Isometric.tsx](../../../framework-studio/src/views/Isometric.tsx), [picking.ts](../../../framework-studio/src/scene/picking.ts), [focus.ts](../../../framework-studio/src/scene/focus.ts): coalesced pointer/frame work, geometry-based picking, selection/search fades |

`landscapeFocus` highlights one-hop neighbors or selected connection endpoints. Hovering or keyboard-focusing a Resources row temporarily uses that same selection emphasis, with highlighted connections animated according to the map's motion setting. Preview leaves the inspector selection, URL, camera and motion preference unchanged; pointer hover takes precedence over keyboard focus, and leaving restores focus/search emphasis. The row opens the map's shared `ResourceHoverContent` (description, environment pills, visible execution locations and source warnings), in a measured portal beside it or above/below on narrow screens. `ResourceTooltip.tsx` measures natural content height, retains the visual viewport's margins and constrains oversized lists for scrolling. Canvas previews use the same measured placement primitives against the visible canvas/window intersection, rather than guessed card dimensions. Mouse opening in Resources is delayed briefly, keyboard focus is immediate, crossing into a card keeps it open, and Escape dismisses without changing selection or moving focus. Keyboard scrolling repositions a Resources preview; wheel scrolling its trigger list, filtering away the row or closing that list clears it. Touch opens the Inspector without a hover card; clicking still uses normal selection motion. Search changes emphasis, not topology. Zoom label detail is not hierarchical automatic graph collapse. `aggregateConnections` retains original relation members; changing visual grouping must preserve selection/evidence access. The [tooltip audit](../../framework-studio/tooltip-audit.md) records presentation rules, dynamic cases and validation limits.

Keep optimization bounded for large graphs. Preserve layout stability across selection/mode switches and avoid recomputing source models during a pointer move. Rendering and picking must share geometric assumptions, especially curve sampling and visible endpoints. Avoid claiming a node-count ceiling or browser FPS guarantee from a synthetic timing fixture.

The three background filters are Routes and events, Environment and secrets, and Resource interactions.
Resource interactions covers grants, database and WebSocket access, workload calls,
workflow steps and local replay. Routes and events covers API routes, authorizers, native
triggers, subscriptions and event failure delivery. Each filter toggles its relationships
together. Empty categories have no filter pill. Structural links remain in the
graph for layout and inspection, but have no background filter and appear only in selected
or previewed context.
The filters **Routes and events** and **Environment and secrets** start off on each page
load; Resource interactions starts on.
An aggregated connection matches any member's category across the dev/prod union, independently
of its styling representative. Drawing and pointer picking share `connectionVisible`;
selecting or previewing a resource reveals its links regardless of those filters. Clearing
selection resumes the unchanged filters. The accessible list still exposes every relationship.

Every Resource interaction and event delivery connection uses the visible source node's
`ICON_TINT` colour and a solid line, including grants, database links, native triggers and
replay. Lambda/ECS interactions therefore match their orange resource icons. An aggregated
wire contains only the same relationship type. Reads and grants between the same resources
remain separate, with independent styles and filters, even across the mode union.
Missing inputs keep their red X marker on the read wire. Hover, selection and environment availability change emphasis,
never its colour or dash style. Folded members use the visible owning stack's icon.

`connection-presentation.ts` supplies every connection title as **action: relevant value**,
including `Routes to: /api/test/start-workflow`, `Starts workflow: invocation-test-workflow`
and `Reads: 3 environment values`. Calls name the configured destination, workflow steps
name their typed operation and target, and grants retain the resource name. Tooltips,
inspectors, member rows, Board labels and description reviews use this same formatter.
The exception is a heading with From/To beneath it, the hover title and the inspector's
`connectionTitle`: when the value only repeats a From/To endpoint name, it keeps a complete
action label (`Calls tool`, `Connects to database`, `Provides database`, `Conditional Deployment`).
An inspector bundle whose members share one action lists their values only, and an expanded
member shows only the endpoint that differs from the bundle's. Authored labels (route keys, variables, trigger
events) always stay in the title. Deploy conditions read `Deploys when <input> equals "<value>".`
Same-type bundles name their shared purpose and count. `presentConnectionHover` reads both
graphs independently and retains every member, including other-environment-only evidence;
its structured hover rows do not use the compact label API's four-member preview limit.
Every aggregation puts Dev and Prod pills beside each member, even when all members share
one availability, and omits the aggregate pair. Individual resources and single connections
keep their pair at the title's top right.
Framework ownership reuses the Inspector's outlined Framework managed badge and lock
icon on a separate left-aligned line beneath the resource type; the type omits a
redundant management prefix.
From/To labels, endpoint names and kinds
form aligned metadata instead of undifferentiated prose. A framework-managed database's
stack is a Stack endpoint; only the database itself is a Database. Supply rows use catalog
parameter names. Each row retains its own availability, requirement state, operation and
permission facts. A fact is qualified with Dev or Prod only when it differs between the
environments that hold that member, never merely because only one holds it. Common defaults
or IAM summaries appear once, as one sentence below the list ("Every input uses its
declaration default."), while exceptions remain with their member. Warnings have their own
emphasis; permissions form a labeled secondary block. Source paths, inference caveats and
full permission facts expand under Configuration and Permissions in the inspector. Normal
configured inputs need no status sentence. Native trigger hovers name the resolved
constructor. Resource hovers retain descriptions and source warnings without permission counts.
A resource's type line (`kindText` in `src/scene/build.ts`, shared with the Resources
list) never repeats its name. A stack stands under its class name, so its line names the
catalog entry (`Stack · resources.rds`); framework stacks outside the catalog read `Stack`.
Network fixtures name their kind and VPC (`Gateway endpoint · test VPC`), because every VPC
has the same fixtures under the same names. Island hover cards show their title and
caption without an `Island` type line. Hover cards are opaque.

Parallel relationships use a stable fan perpendicular to the projected endpoint span.
Height alone cannot distinguish nearly vertical arcs. The default 48-world-unit
control-point spacing separates both vertical and diagonal spans; a compact spread cap
keeps shorter paths proportional with many types. Opposite directions share the fan's
canonical ordering but retain their actual source and destination. Obstacles choose the
shared base curve by checking every sibling's offset at the final 24-segment resolution,
including opposite-direction wires; a clear first member cannot hide an obstructed outer
member. Drawing, packets and picking reuse the resulting per-type path.

Independent connections can still compete for one corridor: lift moves an arc straight up
the page, so steep wires into one node arrive at nearly the same angle and lie on top of
each other. `separateCorridors` finds pairs closer than `CORRIDOR_CLEARANCE` (24 world
units) and within 20° of parallel for at least three clearances, ignoring the first ~195
units around a node both wires share, where a fan is expected to meet. Wires between the
same two nodes are the fan above and never compete. Only competing wires move, and only
their quadratic's control point, along the chord normal: each stays one curve between its
exact anchors, bows most mid-span, and a sheaf into one node opens into a fan of distinct
arrival angles. Each pair keeps the side it is on (a shallow crossing moves toward its
cheaper end; wires lying exactly on one another take one endpoint order per corridor), so
spacing never crosses the pair. A projected Kaczmarz solve shares each corridor's room by
span (at most 14% of a span, 300 units), with lift reduced by at most 20%. Near-parallel
neighbours within twice the clearance join the solve so making room does not crowd them.
Moves that would cut more obstacles, add more than one crossing to a wire, or leave a wire
competing for more length than before are halved and finally dropped; moves under 3 units
are dropped. Final collision validation runs after overlap rollback and tiny-move removal;
an unsafe endpoint-pair group returns together to its original arcs. This validation repeats
only while groups are removed, bounded by the moving group count. The pass is deterministic,
independent of input order and lens, and leaves unrelated wires bit-identical; above
`CORRIDOR_LIMIT` (300) connections it is skipped.

Conditional deployment is an input-control relationship: `Conditional deployment: $inputPath`.
It uses the same dashed colour as Supplies input. Its model endpoints, arrow, packets,
hover and inspector all run from the selecting input to the workload it controls.
Deployment availability and comparison literals still come from the workload's `Lanes.when`;
the connection ID and description key remain stable when changing this visual direction.

When a seed has title collisions, the optimizer reserves a small part of its existing
evaluation budget for local title-clearance moves after the wire search. Added input
groups can keep their titles clear without increasing the optimizer's work limit.

The optimizer keeps at most 36 proxy links. Within that cap it preserves genuine shared
node attachments and spends unused slots on the geometric spread of input/handler fans;
collapsing every attachment on an island to one mean can hide crossings that remain in
the painted wires. Source relationships and final routing remain complete.

Routing rejects disjoint sampled-path envelopes before exact obstacle/crossing
checks. Path helpers reject segment pairs and segment/box pairs whose envelopes
cannot intersect before applying the original strict orientation tests. Envelopes
must cover every sampled point, including interior extrema and zero-width paths.
Touching boundaries retain the existing strict intersection semantics. Standalone candidate
curves and crossing costs use eight segments; shared parallel fans check obstacles at the
final 24-segment resolution. Candidate ordering and picking reuse the chosen routes.
These envelopes belong to one routing call; they do not cache source or scenes.
Use `framework-studio/scripts/benchmark-graph.ts` with 25/100/250/500 or a sanitized
snapshot JSON path to measure cold scene creation and retained-position rebuilds
separately from rendering; `benchmark-routing.ts` times base arcs and corridor separation on
seeded fan-heavy architectures and reports how many routes a single edit leaves unchanged. `prepare-browser-graph.ts` prepares a Playwright CLI
fixture runner against an existing production preview; API requests stay intercepted
in that browser tab. See the [Job 4 evidence](../../framework-studio/job4-frontend-evidence-2026-10-23.md)
for procedure, comparisons and remaining software-rendering limits.

Bulk tag grouping and filtering reuse `ModelIndex` resource/local-service maps and a
scene node map. Build local group buckets by appending members, then sort once; copying
the growing bucket for every entity makes a shared tag value quadratic. Hidden member
lookups must resolve to the same visible representative without repeated node scans.
These are derived presentation indexes, never cached source authorities or staged edits.

Validation: [graph layout](../../../framework-studio/test/graph-layout.test.ts), [landscape](../../../framework-studio/test/landscape.test.ts), [isometric UI](../../../framework-studio/test/isometric-ui.test.ts), [iso](../../../framework-studio/test/iso.test.ts), [hover](../../../framework-studio/test/hover.test.ts), [labels](../../../framework-studio/test/labels.test.ts). Check overlap/crossing scores, evaluation bounds and reuse on representative fixtures; browser-test zoom/pan/picking/resize for real rendering changes. [Snapshot](snapshots.md) tests do not establish visual performance.

The APIs island has one building per actual API Gateway. Shared `src/drawn-as.ts`
representatives fold HTTP/service and WebSocket routes and gateway export stacks into
those buildings; agent routes fold into their agent. Catalog input groups (plain objects
such as `resources.langgraph`) are one building on Input parameters and secrets: every
entry and nested group folds into the outermost group, so its reads, file supplies, client
mappings and `deployWhen` controls leave from the group as same-type bundles. Layout,
aggregated connections, selection, search and tag filtering use the same mapping.
Connection availability retains the original endpoints even when several routes share a
building; a grouped entry keeps its own absence, unlike a stack field, which follows its
stack. `src/input-groups.ts` reads a group through its entries for the hover facts
(per-graph entry counts, readers, mappings, missing required names) and the group inspector.
Group hovers replace the prose name list with entry rows. Pills describe declaration
availability across both graphs, including nested and other-environment-only entries; they
do not claim that a value is set or deployed. Every row has its own pair and the group's
title has none. An undeclared entry is shown by its unlit pill and no sentence.
`groupHoverEntries` retains both modes' exceptional status details; `groupHoverDetails`
hoists common default, optional or unknown states once, counting only the entries each
graph declares. Missing required notices
name variables and files without projecting authored values or resolved defaults.
