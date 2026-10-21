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
related:
  - studio.graph-model
  - studio.snapshots
---
# Board and Isometric rendering

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

Validation: [graph layout](../../../framework-studio/test/graph-layout.test.ts), [landscape](../../../framework-studio/test/landscape.test.ts), [isometric UI](../../../framework-studio/test/isometric-ui.test.ts), [iso](../../../framework-studio/test/iso.test.ts), [hover](../../../framework-studio/test/hover.test.ts), [labels](../../../framework-studio/test/labels.test.ts). Check overlap/crossing scores, evaluation bounds and reuse on representative fixtures; browser-test zoom/pan/picking/resize for real rendering changes. [Snapshot](snapshots.md) tests do not establish visual performance.
