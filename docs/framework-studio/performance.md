# Isometric performance

The October 2026 optimization preserves the current scene, routes, appearance,
pixel ratio, effects, inspectors and accessible controls. It changes how often
work is repeated and removes the retired scene-building path.

## Bottlenecks and changes

| Cost | Finding | Change |
| --- | --- | --- |
| Terrain and icons | Terrain painting accounted for roughly 75–85% of JavaScript drawing time in the initial profile. Every frame rebuilt plinth faces, plaque rectangles and shadow circles. | Reuse vector `Path2D` geometry and icon tint values. Keep the original gradients, compositing, glow and SVG quality. |
| Connections | Every paint retraced every sampled route, including offscreen routes. Required-input midpoints and metadata were repeatedly derived. | Prepare paths, lengths, bounds, colors, availability and markers once per scene. Cull offscreen wires with a generous allowance for their effects. |
| Labels | Stationary animation repeated card sizing, collision sorting, projected polygon construction, title measurements and flank searches. | Cache card and title placement independently of animation time. Invalidate for the relevant camera, viewport, pixel ratio, selection, hover, focus, scene and font changes. Continue painting the same text and styles. |
| Background | Stationary frames regenerated and traced the same ground lattice. | Cache its two vector paths until the camera or viewport changes. |
| Pointer input | Each pointer event allocated silhouette lists, checked every route and rerendered the hidden entity controls. | Coalesce hover to one hit test per display frame; cache silhouettes and marker locations; reject distant route bounds before exact picking; memoize the accessible controls. Click picking stays synchronous. |
| Idle animation | Any selected non-island ID kept the loop running, including static fixtures and entirely offscreen motion. | Request another frame only when a visible connection carries packets. Island trim stays static. Camera tweens still run normally. |
| Scene construction | The application retained the previous node barycentre, semantic-layout switch and legacy drawing router for historical comparisons. Proxy scoring also computed an unused route length. | Remove the old scene path. Benchmarks now compare the current optimizer's unrefined seed with its refined layout. Retain the same inexpensive scoring curves, without the unused length calculation. Sample the final routing candidate at full resolution only after choosing it. |
| Initial load | The isometric route eagerly loaded Board and Deploy code through the application entry point. | Load those route components when their routes are opened, using the same router mechanism already used by Isometric. |

## Browser measurements

Measured in headless Chrome on the local `/isometric` page, with 61 entities,
951 terrain tiles and 68 grouped connections. The comparison alternated the
original and optimized renderer in the same browser, with the same scene,
camera, loaded fonts and icons. Each state had five warmup draws and 90 timed
animation frames. The following numbers are mean JavaScript rendering duration;
they do not include all deferred GPU rasterization or establish an FPS gain.

| State | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Overview | 1.51 ms | 1.30 ms | 14% |
| Selected GraphQL Lambda | 1.41 ms | 1.20 ms | 15% |
| Search for `graphql` | 1.44 ms | 1.26 ms | 12% |
| Zoomed to 1.1 | 1.19 ms | 0.83 ms | 30% |

Both versions maintained approximately 16.67 ms frame intervals in this run.
Overview, search and other stationary states normally settle; they were forced
to redraw here to compare the same work. Input coalescing and avoiding idle
frames provide separate savings that this table does not measure.

The production entry JavaScript chunk fell from about 594 kB to 490 kB
(183 kB to 153 kB gzipped). Board, Deploy and shared code now have separate
chunks, so the entry size change is not the total initial-transfer saving.
Styles used by shared inspector controls retain their original eager loading
and cascade order.

PNG comparisons at a fixed animation time were identical for overview,
selection, search and zoom at device pixel ratios 1 and 2. This covers eight
specific render states, not every browser or interaction. A tested bitmap
backdrop cache introduced small color differences and was discarded; the
retained caches use the original vector paint operations.

Browser smoke checks exercised hover, canvas selection, retained search,
dragging, wheel zoom and toolbar zoom. Scene/UI regression tests cover
coalescing, canceled hover, cache invalidation, fonts, offscreen animation,
deployment badges, missing-input markers, picking and unchanged layout rules.

These measurements describe that renderer fixture, not the repository's current
verification status. Run the [current checks](../aws-studio-knowledge/guides/verification-and-maintenance.md)
after source changes; browser measurements supplement those checks.

The consolidation pass also measured a 12,000-resource shared-tag fixture. Reusing
the existing model index and appending to local group buckets reduced median grouping
time from 55.62 ms to 6.80 ms over five runs each. This removes quadratic copying and
repeated resource scans; it does not establish an FPS improvement. Importing the same
tag validators through `@repo/framework/config/tags` reduced the production entry chunk
from 624.41 kB (191.48 kB gzip) to 605.82 kB (186.01 kB gzip), without adding another
validator implementation. The chunk still exceeds Vite's 500 kB warning threshold.

## Remaining opportunities

- **GPU painting is still the main cost.** Shadows, glow, text and SVG draws
  retain their original quality. A future layer or sprite cache needs visual
  comparisons at fractional camera positions and each pixel ratio; bitmap
  compositing cannot be assumed to preserve the pixels.
- **Large graph startup can block the main thread.** Layout and routing already
  have bounded search budgets and never run in the frame loop. A worker could
  move those pure calculations off the UI thread for substantially larger
  configurations while preserving deterministic output and discarding stale
  jobs. That requires a separate loading/cancellation design.
- **The shared shell remains substantial.** Inspectors, infrastructure browsing
  and editors are still available immediately. Further loading boundaries can
  reduce startup parse work, but should preserve draft guards, selection and
  error handling. The live server also intentionally runs Vite development
  transforms and React development checks; the production build has different
  startup costs.

To investigate a slow interaction, record it in Chrome's Performance panel at
the affected viewport and pixel ratio. Separate scene construction, pointer
handlers, React commits, canvas command submission and GPU paint. The existing
`window.__studioLandscape.stats()` hook exposes frame counts and JavaScript
draw timing. Run the layout benchmark separately from frame timing; it measures
scene construction and graph quality, not interactive rendering speed.

## Server evaluation, review and source index

A second October 2026 pass removed repeated work on the server, which every
save, review and apply waits on. Outputs are unchanged: both mode models,
preflight answers for every field, the source index, export stacks, capability
facts and type-check diagnostics (including an error case) were byte-identical
before and after, measured in-process on a clean export of the same commit.

| Cost | Finding | Change | Before | After |
| --- | --- | --- | ---: | ---: |
| `projectModel`, per evaluator (warm) | `resolveLambdaTarget` normalizes the whole config on every call, and each Lambda was asked about a dozen times (fields, shared defaults, compute, placement). | `lambdaSpec` asks once per Lambda per evaluated config. Lanes still call `isTargetEnabled`/`isTargetDeployed` directly. | 227 ms | 75 ms |
| Candidate type-check (`resourceTypeErrors`) | Each review or apply of a resource, trigger, stack or creation re-parsed about 3,500 `node_modules` declaration files, blocking the server thread. | Parsed dependency declarations are shared with the capability program and dropped after ten idle minutes (about 700 MB while held; peak memory is unchanged). | 2.2 s | 0.6–0.75 s |
| Capability discovery cache miss | The same re-parse after a CDK, catalog or framework-config change. | Same shared declarations. | 1.9 s | 0.29 s |
| `buildSourceIndex` (warm) | The CDK entry point's import graph was walked twice, and export stacks re-parsed their files for a class location. | One `readConstructorSites` walk serves the catalog and export stacks; the location comes from the parsed declaration. | 80 ms | 51 ms |
| Tag editability across 68 entities | Every entity rediscovered the complete config and catalog. | Reuse the current source index's discoveries; resolve edited overlays afresh. Three passes with fresh parsed-file state. | 206–218 ms | 4–8 ms |

`SnapshotBuilder` also parses each source file once per refresh for the index and
both modes' connection evidence. Evaluator process start-up and the framework's own
normalization (about 0.5 ms per call, deliberately not memoized) are unchanged.
