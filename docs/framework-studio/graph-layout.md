# Graph-aware island layout

The isometric map uses a constrained, deterministic graph layout and one shared
connection router. Island geometry and resource identities remain model-derived.

## Investigation and choice

The previous `layout.ts` packer measured islands and arranged semantic rows. It
received no dependencies. A one-sided node barycentre could reorder some buildings,
but could not move heavily connected islands together. Every relationship used the
same upward quadratic arc; drawing sampled 24 segments and picking sampled 16.
The packer assumed 16:9, and camera resizing never reconsidered the composition.
Dragging pans the camera; there were no manual island positions to migrate.

Neither ELK, Dagre nor a force-layout library was installed. ELK's layered pipeline
and Dagre are viable general graph-layout tools, but still need adapters for this
map's footprint lattice, elevation, projected ports, semantic constraints and
incremental placement. A force simulation adds settling and stability concerns.
The chosen implementation reuses the existing measured packer as its seed and
fallback, with dependency layering/barycentric ordering and bounded discrete
refinement. No new package or runtime service is needed.

References: [ELK's layered phases](https://eclipse.dev/elk/blog/posts/2025/25-08-21-layered.html),
[Dagre's client-side design](https://github.com/dagrejs/dagre/wiki).

## Pipeline

1. `build.ts` measures the existing terrain and VPC foundation overhang and computes
   local projected icon anchors. Stack members resolve to their visible parent.
2. `layout-graph.ts` unions Development and Production relationships, excludes
   intra-island/missing endpoints from island optimization, aggregates real
   dependencies, and assigns relationship weights. Resource data and secrets are
   not evaluated here. Dependency orientation distinguishes providers from their
   consumers without reversing the actual displayed relationships.
3. `layout-optimize.ts` condenses cyclic dependencies for layering, performs four
   barycentric ordering sweeps, considers semantic and dependency-ordered multi-row
   seeds, then refines through deterministic moves, neighbour pulls and swaps.
   Environment files stay left of inputs; network islands stay in the right-hand
   zone; Workflows stay left of Stacks. Other islands may follow connections instead of sharing a prescribed row.
4. `layout-quality.ts` scores projected anchor paths, weighted crossings/length,
   island and label rectangles, unrelated-island intersections, viewport utilization,
   negative space and movement. Overlaps dominate the cost. Crossing reduction and
   obstacle clearance outweigh cosmetic symmetry. Labels use a conservative overview
   estimate; actual typography and flank placement still belong to the renderer.
5. `routing.ts` chooses a clear, short curve for each actual relationship. Related
   category/pair connections use small lane offsets, retaining each edge's identity,
   endpoints, provenance, colour and arrow direction. This is corridor/lane routing,
   not merged bus edges. Candidates consider unrelated islands, icon silhouettes
   and estimated overview title envelopes.
   Every candidate uses an upward-bowing quadratic arc with a distance-scaled minimum
   bend perpendicular to its endpoints (rightward for vertical connections). Lane
   offsets and obstacle avoidance increase that bend instead of flattening the wire.
   The extra obstacle-avoidance bend scales smoothly with endpoint distance below
   800 world units, keeping nearby connections compact; longer routes retain their
   established candidates. The distance-scaled minimum bow remains unchanged.
   Drawing, packet animation and hover picking use the same 24-segment cached path.

Projection uses the map's existing `(gx-gy)*32`, `(gx+gy)*16-h*16` transform. Search
and evaluation happen in that projected world plane; camera pan and uniform zoom
preserve intersections. No layout work occurs inside the animation loop.

## Stability, responsiveness and controls

- Canonical IDs and fixed evaluation budgets make results reproducible. The cache
  retains at most 24 input/settings results. Search, hover, selection, animation and
  mode visibility do not change the topology key. A mode switch reuses exact positions.
- Small feasible edits start at previous positions and bound each existing island's
  displacement to 128 projected world units. Geometry growth can require more movement
  to restore clearance; an infeasible incremental packing falls back to a valid seed.
- Resize observation is debounced 180 ms and uses workspace aspect buckets, so the
  temporary inspector does not rearrange the map. Significant workspace aspect changes
  release the incremental preference and recompute; ordinary camera movement does not.
- Fit includes routed-wire extents and a zoom-dependent allowance for screen-sized
  island titles, including VPC foundations. Narrow viewports keep titles on screen.
  The isometric view loads separately so its optimizer does not enlarge the initial
  Board bundle.
- **Auto-arrange islands** releases the previous-position preference and fits a fresh
  arrangement. Fit continues to change only the camera. No settings panel or persisted
  manual-layout store is added. The pure optimizer accepts pinned constraints for a
  future manual-positioning interaction; current drag-to-pan behavior is preserved.
- Search uses at most 360 evaluated candidates (90 above 24 islands) and 36 weighted
  aggregate links. Routing considers the last 96 accepted paths to bound crossing work
  on large edge sets. Every real relationship is still rendered and pickable. These
  limits make optimization heuristic, not an exact global crossing minimum.

## Validation and reproducible measurements

Run from the root:

```powershell
node --conditions=development --import tsx framework-studio/scripts/benchmark-layout.ts
npm --workspace framework-studio test
npm run verify
```

The benchmark compares the previous semantic packing, original node barycentre and
original curves with the new layout/router using the repository's actual graph. It
measures full-resolution painted paths separately from the optimizer's coarse proxy.
Crossings count intersecting wire pairs, excluding shared endpoints. Reported
lengths and obstacle hits weight declared relationships by 2 and source-inferred
links by 1; the optimizer separately uses relationship-specific dependency weights.
Only inter-island wires enter these metrics. Node and title avoidance is additional
routing work.

Recorded desktop results (1920-class workspace, 16:9 target):

| Graph | Crossing pairs, before → after | Weighted length, before → after | Weighted island hits | Aspect utilization |
| --- | --- | --- | --- | --- |
| Development | 493 → 304 | 201,931 → 177,041 | 70 → 24 | 99% |
| Production | 395 → 305 | 198,281 → 173,622 | 70 → 24 | 99% |

On this machine scene construction including routing took about 52 ms on the first
desktop run and 28 ms with the shared layout cached. These are observations, not a
cross-machine performance guarantee. The portrait fixture reached 84% aspect
utilization and fewer crossings, with longer wires (about 13–17%): fitting a narrow
workspace is a deliberate tradeoff. Rerunning the benchmark can produce different
measurements when authored topology changes.

Tests cover crossed bipartite and dense many-to-many graphs, 80-island bounded search,
determinism under input reordering, real dev/prod improvements, non-overlap, preserved
edge endpoints/identities, exact route picking, local edits, growth/removal, pins,
aspect reflow and presentation-only reuse. Existing terrain, camera, selection,
endpoint, colour and projection tests remain in place.
