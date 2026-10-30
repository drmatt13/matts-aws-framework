# Job 4 frontend and graph evidence — 2026-10-23

> Historical evidence record. Results and capability assessments apply to the
> dated checkout/campaign below, not automatically to the current tree. For current
> scope use [implementation status](../aws-studio-knowledge/reference/status.md);
> for current procedures use the [documentation index](../README.md).

This report covers presentation graph construction, routing and browser interaction.
The synthetic fixtures do not evaluate declarations, create application files, contact
AWS or execute deployment operations. Prior renderer reports are historical evidence;
the measurements below were collected from the current checkout.

## Method

The reproducible `framework-studio/scripts/benchmark-graph.ts` harness constructs
exactly 25, 100, 250 and 500 canonical entities: HTTP routes, Lambda targets and
catalog stacks. Each target routes from one entry point and has two declared grants.
All entities remain visible in the scene. This deliberately stresses routing between
three large islands; it does not represent every VPC, workflow or tag topology.

Each size runs in a fresh Node process. The first scene is cold for the module-local
layout cache. Five subsequent samples retain the initial island positions and exercise
the complete scene and route rebuild, Board layout, model indexing and map search.
Cold scene time has one sample per size; warm tables use the median of five and report
the maximum separately in raw JSON. Five samples do not establish a reliable p95.
Imports and fixture creation occur outside the operation timer. Node RSS includes the
tsx loader and must not be treated as browser heap or retained scene memory.
The host reports Darwin 23.1.0 on arm64, Apple M3 Pro with 11 logical CPUs and
18 GiB physical memory, Node v26.0.0 and npm 11.19.0.

The lead serialized CPU windows across build, graph, runtime and source benchmarks.
Raw environment/version/memory data and per-sample times are in the ignored directory
`.framework/job4/frontend/`. The source baseline is the repository HEAD plus the
working tree recorded by the integrated campaign report; the routing source before
modification is retained in that evidence directory.

```sh
for size in 25 100 250 500; do
  node --import tsx framework-studio/scripts/benchmark-graph.ts "$size" 5
done
node --cpu-prof --cpu-prof-dir=.framework/job4/frontend \
  --import tsx framework-studio/scripts/benchmark-graph.ts 500 20
```

## Baseline and confirmed cause

| Entities | Cold scene, ms | Retained-position scene median, ms | Board median, ms | Search median, ms |
| ---: | ---: | ---: | ---: | ---: |
| 25 | 17.73 | 1.33 | 0.049 | 0.072 |
| 100 | 30.41 | 12.26 | 0.171 | 0.179 |
| 250 | 74.48 | 47.00 | 0.351 | 0.396 |
| 500 | 173.15 | 139.69 | 0.676 | 0.702 |

`before-500.cpuprofile` confirms geometry work in the router dominates the large
fixture: 994 self samples in `pathHits`, 369 in `segmentsCross`, 147 in `pathsCross`,
versus 41 in `buildScene` itself. These are profiler samples, not separately timed
stage durations. The router scores four candidate curves per connection against
every entity obstacle and up to 96 earlier curves. Before this change, geometrically
disjoint pairs still ran all exact segment tests. Board layout and indexing were
already small in these fixtures and were left alone.

Whole-path rejection alone reduced the 500-entity retained-position median from
139.69 ms to 127.75 ms (8.5%) and changed the 250-entity result by less than 1%.
That result did not establish a substantial large-graph improvement. The final
comparison also evaluates segment-level rejection at the confirmed geometry hotspot.
The intermediate receipt remains in `after-envelope-only-*.json`.

## Change and correctness contract

Each candidate sampled path now computes its axis-aligned envelope once. The accepted
paths retain their envelope beside their existing sampled points for this routing
call. Disjoint envelopes reject impossible obstacle hits and crossings before exact
geometry. Path helpers reject disjoint segment pairs and segment/box pairs before
evaluating the original strict orientation products; the rectangle's corners are
created once per path/box check. Overlapping candidates still use the same exact checks, sample counts,
weights, scores and deterministic ordering. This introduces no cache across scene
builds and no invalidation or stale-source authority.

The new geometry regression suite challenges the conservative rejection rule using
100 deterministic arbitrary polylines, exhaustive path-pair intersections, obstacle
boxes, reversed extrema, touching boundaries and horizontal/vertical paths. A second
reference check compares 14,400 segment pairs with the original strict orientation
definition, including shared endpoints and degenerate segments.
Before/after route SHA-256 values in the benchmark evidence compare the complete
routed points and lengths for every synthetic size.

## Final scene comparison

| Entities | Retained-position median before → after, ms | Reduction | Cold scene before → after, ms |
| ---: | ---: | ---: | ---: |
| 25 | 1.327 → 1.065 | 19.7% | 17.73 → 14.56 |
| 100 | 12.259 → 7.598 | 38.0% | 30.41 → 22.84 |
| 250 | 47.004 → 25.810 | 45.1% | 74.48 → 49.35 |
| 500 | 139.694 → 67.213 | 51.9% | 173.15 → 95.22 |

Each complete route JSON hash matched before/after at all four sizes, covering
every final sampled point and length. The final profile remains dominated by
geometry, but avoids the previously confirmed redundant work. No unsupported
constant-time or node-count ceiling follows from this result.

The saved real application snapshot had 72 canonical entities, 61 scene nodes,
86 raw relationships and 1,928 terrain tiles. Its final cold scene took 38.93 ms;
the retained-position median was 3.43 ms, Board 0.126 ms and search 0.197 ms over
five samples. There is no matching real-snapshot before receipt, so these are
acceptance observations rather than an improvement claim.

## Browser comparison

`prepare-browser-graph.ts` produces a Playwright CLI `run-code` function from a
sanitized snapshot. Each receipt starts in a fresh isolated, sandbox-enabled
headless Chromium 155.0.8059.12 context at 1440×1000, using the same production
asset preview, source payload, fonts, icons and reduced-motion preference. The
before assets were archived before any routing change; the after assets came
from a successful Studio production build. All API requests were intercepted
inside that tab. These presentation checks do not prove a live source server,
deployment, or AWS behavior.

Each size has five document loads, five search changes and five keyboard-driven
Inspector openings. Load timing ends when the landscape diagnostics expose the
expected node count; search/Inspector timing includes Playwright interaction and
two animation frames. Selected packet rendering collects 90 RAF observations.
These wall times include automation and browser scheduling; JavaScript draw time
does not include deferred rasterization. Fresh document loads are warm for assets
after the first sample, while application JavaScript and scene state are recreated.

| Entities | Load median before → after, ms | Inspector median before → after, ms | Draw median before → after, ms | RAF interval median before → after, ms |
| ---: | ---: | ---: | ---: | ---: |
| 25 | 144 → 145 | 69 → 68 | 0.4 → 0.4 | 16.7 → 16.7 |
| 100 | 178 → 172 | 83 → 80 | 0.9 → 0.9 | 16.7 → 16.7 |
| 250 | 253 → 229 | 115 → 119 | 1.8 → 1.8 | 33.3 → 33.3 |
| 500 | 430 → 328 | 166 → 161 | 3.2 → 3.1 | 50.0 → 50.0 |

The 500-entity document load improved by 23.7%. Inspector and drawing differences
are small; this change does not establish faster picking, search or frame rate.
Search medians were 40/56/160/313 ms before and 43/87/160/322 ms after. The
100-entity result varied by 31 ms despite unchanged rendering/search code; five
automation samples cannot establish a causal search regression or improvement.

The browser ran with SwiftShader software graphics and disabled GPU compositing.
Large-graph RAF intervals and long tasks remain a visible scaling limit in that
environment. A 500-entity graph with 8,880 tiles and 498 grouped connections is
not evidence of a smooth 60 FPS experience. Preserve that limitation in beta
readiness claims. A future worker can address scene stalls separately from
rasterization; changing raster quality or caching bitmap layers needs new visual
evidence and was outside this targeted change.

Raw initial browser receipts remain `browser-before.log/json`. Those used
privacy-quantized `performance.memory` values and must not support heap claims.
The corrected independent receipts are `browser-before-cdp.log/json` and
`browser-after-cdp.log/json`, using CDP `Runtime.getHeapUsage` and explicit GC for
retained-memory observations. No page errors were recorded in either corrected
receipt. Thirty Board↔Isometric/search cycles left 2,129 DOM elements and exactly
one created/active/peak EventSource instance in each receipt. The intercepted
stream tests subscription ownership, not a live SSE connection.

Both retained-heap endpoints followed `HeapProfiler.collectGarbage`. The baseline
grew from 11.44 MB to 16.89 MB, and the optimized receipt from 11.44 MB to 15.36 MB
over 30 cycles (decimal MB). This finite increase does not establish either an
unbounded leak or a stable plateau. Independent QA should replay additional batches
with forced-GC checkpoints; `.framework/job4/frontend/heap-followup.js` supplies that
exact continuation. No leak-free claim is made. The benchmark browser and preview
were closed after the receipts; only ignored evidence and the reproducible scripts
remain. The optional follow-up requires reopening the fixture runner first.

## Verification and independent challenge

From `framework-studio/`, the geometry, graph layout, event hub, landscape and
Isometric UI suites passed 140/140 tests in 32.45 s. This includes invalid/empty
graph recovery, source-mode transitions, canceled pointers, keyboard navigation,
retained search and resource selection, tag filtering, label caches, and renderer
disposal behavior. Invoking the UI tests from the repository root selected the
wrong JSX transform (`React is not defined`); that diagnostic run was interrupted
and the workspace command above passed. The production build passed with the
existing warning about chunks above 500 kB. The integrated report owns the final
monorepo verification outcome.

An independent build specialist reviewed the final geometry change and found no
correctness blocker: endpoint rejection excludes only pairs entirely outside one
strict axis interval; endpoint interior hits still precede box pruning; exact
four-edge predicates and route scoring remain unchanged. The reviewer specifically
challenged vertical, horizontal, zero-length and touching-boundary behavior and
required the brute-force reference checks and all four unchanged route hashes.
