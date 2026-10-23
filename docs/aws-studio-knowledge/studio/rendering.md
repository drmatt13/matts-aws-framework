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
  - framework-studio/src/scene/render.ts
  - framework-studio/src/endpoint-services.ts
related:
  - studio.graph-model
  - studio.snapshots
---
# Board and Isometric rendering

Isometric always retains its topology islands and real VPC/subnet terraces. The compact
key/value tag filter changes only visual presence: nonmatches use the same transparent
style as resources unavailable in the active deployment mode. Untagged and empty values
remain distinct. Filtering preserves canonical IDs, positions, network placement, edges,
source links and inspector selection; it never changes actual deployment availability.
Filter state is a view preference and never stages a source edit.
Tag keys and value totals use active-mode membership: enabled workload lanes and routes,
non-absent catalog entries, enabled local services and built production VPCs. Union-topology
placeholders retain their metadata for filtering/inspection but contribute no counts.
Development VPCs use the continuous blueprint deck. Production renders every declared VPC
and its gateways/endpoints as solid terraces, including unused VPCs. Captions and hover facts
still report whether production actually builds the network; rendering never provisions it.
The first tag selector includes **Untagged**, matching entities with no effective tags at all,
with mode-scoped totals. The value selector's **Untagged** option instead means missing the
selected key. Empty values and inherited tags count as tags.
Untagged results exclude plain input parameters, namespace containers, environment files,
local database fixtures, and framework-managed stacks and their member projections. Tagged
parameters still match explicit tag values. This applies to both no-tags and missing-key filters.

VPC fixtures wrap into approximately square grids within their subnet. Measurement reserves
separate compute and fixture rows across the terraces; placement reuses these measured
coordinates. Endpoint count grows width and depth together, preserving every fixture,
its service badge, stable ID, subnet ownership and picking silhouette. Gateways sit on
the left-facing perimeter, leaving the interior for compute and the endpoint grid.
Canvas mini badges use the same local AWS SVG service/family catalog as the endpoint
picker (`endpoint-services.ts`); the renderer loads selected artwork once per instance.
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

Isometric's one side panel, below its toolbar, shows **Resources** or the **Inspector**, never both; Board and Database keep the right-hand inspector. The panel sits on the map's right; it starts closed and the **Resources** toggle sits at the toolbar's far right, after the view controls. The list shows canonical map entities with registry icons, names and types, grouped by island, plus search results and validation errors; any selection opens the same Inspector in the same panel. Back to Resources ends the selection and keeps the list's search, type and scroll; Close panel ends the selection and closes the panel. Back, Close and the toggle reuse the draft navigation warning only while edits are pending. Opening the panel keeps the map's window position, and every new selection comes into view at the same zoom (cut-off ones slide just far enough, unseen ones are centred); on narrow windows the panel sits below the canvas. Search/type filtering changes the list and map emphasis, never source or infrastructure identity. Missing implementation artifacts add an attention marker to the resource navigator, Board node and Isometric caption/hover; selecting that canonical resource exposes its configured path and reviewed repair. These source-health facts do not imply runtime readiness. Existing keyboard access to every connection and network fixture is retained. The navigator explicitly distinguishes the declaration map from running-state evidence in Deploy.

Search and tag filters use the shared control geometry and inset chevrons. The search match count sits inside the field, and tag selects keep fixed widths with their clear control following the last one (the value select appears only once a key other than Untagged is chosen); the tag match count appears in the map footer (and is announced), so the toolbar keeps one height. Clearing
either restores keyboard focus to the surviving search/key control. Camera controls
are a named group; long tag selections retain their full value in their tooltip.
All controls sit in the shared workspace toolbar outside the measured `.landscape`
canvas container. The toolbar participates in normal flow, so wrapping and search
feedback reduce the canvas viewport without obscuring resources. Resize, picking,
hover and fit keep using the inner scene container. Renderer timing remains in
`window.__studioLandscape.stats()`; normal chrome shows resource/connection counts.
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
| Route | `routeConnections` in [routing.ts](../../../framework-studio/src/scene/routing.ts): bounded quadratic-bow candidates, sampled obstacle/crossing costs and cached polylines; heuristic, not a global routing solver |
| Draw | `SceneRenderer` in [render.ts](../../../framework-studio/src/scene/render.ts): Canvas2D, cached Path2D/geometry, viewport culling, DPR handling, caption collisions and zoom-dependent labels |
| Interact | [Isometric.tsx](../../../framework-studio/src/views/Isometric.tsx), [picking.ts](../../../framework-studio/src/scene/picking.ts), [focus.ts](../../../framework-studio/src/scene/focus.ts): coalesced pointer/frame work, geometry-based picking, selection/search fades |

`landscapeFocus` highlights one-hop neighbors or selected connection endpoints. Search changes emphasis, not topology. Zoom label detail is not hierarchical automatic graph collapse. `aggregateConnections` retains hidden relation members; changing visual grouping must preserve selection/evidence access.

Keep optimization bounded for large graphs. Preserve layout stability across selection/mode switches and avoid recomputing source models during a pointer move. Rendering and picking must share geometric assumptions, especially curve sampling and visible endpoints. Avoid claiming a node-count ceiling or browser FPS guarantee from a synthetic timing fixture.

Bulk tag grouping and filtering reuse `ModelIndex` resource/local-service maps and a
scene node map. Build local group buckets by appending members, then sort once; copying
the growing bucket for every entity makes a shared tag value quadratic. Hidden member
lookups must resolve to the same visible representative without repeated node scans.
These are derived presentation indexes, never cached source authorities or staged edits.

Validation: [graph layout](../../../framework-studio/test/graph-layout.test.ts), [landscape](../../../framework-studio/test/landscape.test.ts), [isometric UI](../../../framework-studio/test/isometric-ui.test.ts), [iso](../../../framework-studio/test/iso.test.ts), [hover](../../../framework-studio/test/hover.test.ts), [labels](../../../framework-studio/test/labels.test.ts). Check overlap/crossing scores, evaluation bounds and reuse on representative fixtures; browser-test zoom/pan/picking/resize for real rendering changes. [Snapshot](snapshots.md) tests do not establish visual performance.
