# Graph-aware island layout

The isometric map places its islands from the architecture's own topology, then routes
every relationship over that arrangement with one shared connection router. Island
geometry and resource identities remain model-derived; positions are disposable
projections, never configuration.

## Investigation and choice

The earlier optimizer refined a fixed semantic row packing (entry left, compute and
networks right, Agents/Workflows/Stacks in a lower row) with a few hundred local moves.
Hard rules tied to island IDs (environment files beside inputs, networks right of the
input cluster, Workflows before Stacks) kept it close to that seed, so islands could not
follow their connections. It tested collisions with screen-aligned bounding boxes, which
waste the empty corners of every isometric diamond, and judged the overview by bounding-box
aspect alone, so an outlying island could "improve" the fit.

The island graph is small (one island per framework region plus one per VPC; tens at most),
so the layout uses the complete distance matrix rather than a simulation:

- **Stress majorization** (SMACOF) gives a deterministic, monotone global solve that places
  strongly connected islands together and hubs centrally. It needs no step size and does not
  oscillate, unlike a force simulation.
- **Projection** enforces non-overlap of the exact projected envelopes during the solve, in
  the spirit of constrained stress layouts (IPSep-CoLa), without a quadratic-programming solver.
- **Discrete refinement** then optimizes the real objective — crossings and corridors are not
  smooth, so they are judged on sampled wires rather than in the stress energy.

ELK and Dagre were not adopted for the reasons the original investigation found: both need
adapters for this map's footprint lattice, elevation, projected anchors and incremental
placement. No dependency or worker was added; the measured cost below does not justify one.

## Pipeline

1. `build.ts` measures each island's terrain (`ground`: width, length, elevations, VPC
   foundation inset) and its projected building anchors, and declares architectural
   `group`s (every VPC; the two configuration islands).
2. `layout-graph.ts` unions both environments' relationships, aggregates island bundles and
   weights, and marks request-path relations (`FLOW_RELATIONS`: routes, tasks, workflows,
   agents, tools, steps, grants, databases) with a reading direction. Configuration,
   authorization and event sources carry no direction.
3. `layout-shape.ts` turns each footprint into its painted envelope. Every edge an island
   paints runs along one of four screen directions, so the envelope is an eight-sided
   discrete oriented polytope over `x`, `y`, `x + 2y` and `x − 2y`: terrain, walls, building
   headroom and VPC foundation. Overlap and clearance tests are exact and allocation-free;
   diamonds nest diagonally. Island titles are screen-sized rectangles on the left flank,
   sized at the zoom the overview will actually reach.
4. `layout-optimize.ts` solves globally from several deterministic starts — classical scaling
   (three best orientations) and the semantic packer — with `layout-stress.ts` majorization
   and `layout-place.ts` projection. Stress ignores rotation, so each start is turned to read
   requests from the upper left, keep heavy bundles off the vertical (wires lift straight up
   the page) and suit the workspace aspect, which also stretches the stress frame.
5. Every candidate lands on the exact lattice (`build.ts` places an origin with no rounding
   when `left + top + length` is even), takes its nearest clear spot, and compacts inward.
   Each is polished by relocating islands beside their neighbours; the best is refined by
   relocate, dock (contact against the strongest partner from eight directions), swap and
   lattice translation moves against the objective, within a fixed evaluation budget.
6. `routing.ts` routes every real relationship. Island obstacles are boxes that hug each
   envelope (`dopBoxes`), so a wire is not bent around a diamond's empty corner.

## Objective

`measureLayout` / `measureSceneLayout` in `layout-quality.ts` score one arrangement:

| Term | Meaning |
| --- | --- |
| Overlaps | Islands closer than `ISLAND_CLEARANCE` (56 world px), titles over islands or titles. Effectively infeasible. |
| Crossings | Weighted wire crossings, excluding wires that share a node. Dominant visual term. |
| Obstacles | Wires through the envelope of an island they do not touch. |
| Length × fill | Weighted wire length, scaled up when islands, titles and wires cover less than 40% of the viewport-shaped rectangle a fit shows. Compacts the map and matches the workspace without letting one outlying island buy a better aspect. |
| Congestion | Bundles from different neighbours leaving an island within 30° of each other: one corridor. |
| Flow | Request-path bundles that read back toward the upper left. |
| Cohesion | Empty space between islands of one group beyond their clearance. |
| Movement | Mean displacement from the previous arrangement, during edits. |

The optimizer searches over at most 36 proxy links that keep distinct attachment fans
apart; `measureSceneLayout` measures the actual painted routes.

## Stability, responsiveness and controls

- **Reuse.** An unchanged topology key, or a rename with every island still clear, reuses
  exact positions with zero evaluations. Mode switches therefore never move anything.
- **Incremental edits.** A result carries per-island fingerprints (size and bundles). On the
  next build, unchanged islands keep their exact origin and a resized island keeps its
  centre. Where growth now collides, projection parts the colliding pairs only, with the
  resized island holding its ground; islands merely resting at their clearance stay put.
  A new island takes the nearest clear spot at the weighted centre of its placed neighbours.
  Refinement is limited to new and resized islands, islands whose bundles changed, and
  neighbours of anything new or resized, within 96–192 px of where they settled.
- **Broad edits.** When added, removed and resized islands sum to at least a quarter of the
  map, a fresh solve is computed as well. It replaces the incremental result only when it is
  at least 20% better, translated so the surviving islands keep their centre and the camera's
  view stays put. Small edits never reshuffle the map.
- **Determinism.** Inputs are sorted by ID, every start and tie-break is index-derived, and
  the cache (at most 24 results) is keyed by the complete input. The same model always
  produces the same layout.
- **Pins.** `LayoutSettings.pins` hold islands fixed through solving, projection, legalizing
  and refinement, ready for a future manual-positioning interaction; there is no persisted
  manual-layout store and drag still pans.
- **Aspect.** Resize observation is debounced 180 ms and uses workspace aspect buckets, so
  the inspector panel does not rearrange the map; a bucket change recomputes afresh.
- **Bounds.** 720 evaluations at most (150 above 24 islands, which also keeps one
  orientation). Repeating the refinement from a second start measured no better.
- No transition is animated: an edit moves few islands, and little, by construction.

## Validation and reproducible measurements

Run from the root:

```sh
node --conditions=development --import tsx framework-studio/scripts/benchmark-layout.ts
npm --workspace framework-studio test
npm run verify
```

The benchmark compares the legalized semantic seed (`budget: 1`) with the optimized layout
on the repository's actual graph, using painted routes. Crossings count intersecting wire
pairs between islands, excluding shared endpoints; lengths weight declared relationships by 2
and source-inferred links by 1.

Measured 2026-11-01 (Apple silicon, Node 26), previous optimizer versus this one on
identical snapshots and identical route metrics. Zoom is the fitted overview zoom (larger
draws every island larger); time is a warm scene build including routing.

| Architecture | Workspace | Crossings | Weighted length | Overview zoom | Scene build |
| --- | --- | --- | --- | --- | --- |
| This repository (8 islands, 68 connections) | 1920×1028 | 251 → 157 | 179,009 → 107,709 | 0.359 → 0.492 | 42 → 97 ms |
| This repository | 900×1000 | 269 → 173 | 201,525 → 119,915 | 0.212 → 0.312 | 42 → 89 ms |
| Three VPCs, 58 connections | 1920×1028 | 808 → 536 | 333,228 → 237,734 | 0.333 → 0.429 | 52 → 107 ms |
| Eight agents, 60 connections | 1920×1028 | 362 → 281 | 167,721 → 111,786 | 0.460 → 0.508 | 32 → 54 ms |
| Dense: 101 resources, 250 connections | 1920×1028 | 7,473 → 6,166 | 1,220,403 → 728,354 | 0.273 → 0.367 | 374 → 315 ms |

Edits to this repository's graph, measured as island displacement with previous memory:
adding one Lambda moved the compute island and Stacks 72 px; adding a stack or removing a
relationship moved at most one island; adding a VPC placed it and moved one neighbour 32 px;
adding ten Lambdas grew compute around its centre and moved its neighbours 64–128 px. A
fresh solve would have moved every island 330–2,400 px on average. A fresh solve alone takes
about 65 ms for this repository, 170 ms for 20 dense islands and 230–400 ms for 80; edits
take 20–45 ms. These are observations on one machine, not a cross-machine guarantee.

`test/island-placement.test.ts` covers envelope containment against the renderer's painted
slabs, geometry primitives, stress majorization, clearance and exact-lattice placement over
24 seeded architectures, determinism under reordering, aggregate quality over 30 seeded
architectures, group cohesion, incremental insertion, growth and relationship edits, pins
and bounded work. `test/graph-layout.test.ts` and `test/landscape.test.ts` keep the real
dev/prod improvements, painted non-overlap, reading direction and routing contracts.
