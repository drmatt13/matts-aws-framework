# Framework Studio — Build the Isometric Architecture View

> Historical design input. For the current product and supported behavior, read
> [AWS Studio](docs/AWS-STUDIO.md) and the [implementation status](docs/aws-studio-knowledge/reference/status.md).
> Preserve this document as context; its proposals and early source names are not current instructions.


## Objective

Framework Studio's first working version is in place. I want the next experiment to be **visual and tangible**: an interactive, dimensional isometric landscape displaying my *actual* framework application, not a mock-up or a static architectural diagram.

**Implement the isometric view now.** The research below is self-contained; do not ask me for another rendering-engine report. It describes engineering techniques worth adapting, **not mandatory implementation details or a codebase to import**. Use judgment against the current repository and show me the result.

This is still experimental. Preserve what works, make a reversible implementation, and prefer a convincing vertical slice over another long planning exercise.

## 1. Where we are now — inspect, verify, reuse

The previous Framework Studio implementation report states:

- `framework-studio/` runs as a host process at `127.0.0.1:4590` via `npm run studio`, with React, TanStack Router and Query.
- The **Board** and **Lanes** views already render actual framework data, with an inspector, source navigation, deployment mode selection, and preview/apply editing.
- The framework itself already has identifiers such as `kind:id`, `NormalizedTarget`, binding/env-reference data, `isTargetEnabled`/`isTargetDeployed`, and a workflow IR. The editor should **not invent competing infrastructure identity or configuration models**.
- Studio's evaluator projects both dev and prod into sanitized browser data, and the host-side source editor already supports verified, reversible edits.
- Existing source editing uses preview, framework validation, hash/conflict checks, atomic writes, re-evaluation, and undo/redo.
- Important verified constraints from the last pass: the code-editing path runs on the host, **not** a Docker Compose sidecar; workflow step identifiers can be construction-order ordinals rather than durable IDs.

**Recheck these facts in the actual code.** Preserve existing Board, Lanes, inspector, Check, editing, validations, and safety boundaries. Do not rewrite the editor backend or framework parser to introduce this visualization. Render from the existing sanitized projection or a narrowly justified *derived view model*. Selection and inspector state should be shared across views.

We previously chose a **TypeScript renderer** over adding Rust/Bevy/WASM to this workspace. Retain that direction unless hands-on repository inspection reveals a compelling reason to change. PixiJS/WebGL, Canvas2D, and similarly appropriate libraries are options, not predetermined answers. Avoid CSS-only faux isometric tiles as the main rendering system.

## 2. What I want to see

Add an **Isometric** view alongside Board and Lanes. It should open to a dark, navigable landscape of raised tile islands/platforms with real, clickable framework entities, labels, and visible connections. The isometric landscape is a distinct **view of the same application**, not an alternative source of truth.

I want to recognize routes, Lambda compute, containers, workflows, agents/tools, and catalog resources. Layouts can initially group by kind or relationship, but should progress toward meaningful regions (entry points, compute, orchestration, catalog, networking). Avoid duplicating a node just because it participates in multiple relationships unless the duplication is an explicitly designed visual proxy.

The scene should have **actual dimensional geometry**: diamond-shaped top surfaces, visible side faces and thickness, height variation, correct front/back occlusion, and rich enough styling that the engine's capabilities are unmistakable. A few carefully constructed, attractive islands are preferable to a huge messy tiling of everything.

Start with original/procedural textures and shapes. We can improve the art direction later. The source mapping, inspector, and editable flags must remain real.

## 3. Isometric projection — technical reference

An effective 2:1 isometric projection from grid `(gx, gy)` and terrain elevation `h` into a **world coordinate system with Y pointing up** is:

```ts
const TILE_W = 64; // projected top diamond width, illustrative
const TILE_H = 32; // projected top diamond height
const ELEV = 16;   // vertical pixels per height unit

function iso(gx: number, gy: number, h = 0) {
  return {
    x: (gx - gy) * TILE_W / 2,
    y: -(gx + gy) * TILE_H / 2 + h * ELEV,
  };
}
```

For a renderer with screen/world Y pointing **down**, invert the Y convention consistently, e.g. `y = (gx + gy)*TILE_H/2 - h*ELEV`. Do not mix conventions between terrain, edges, sprites, camera, and picking.

For known height `h`, the inverse of the **Y-up** form is:

```ts
const diff = 2 * worldX / TILE_W;                 // gx - gy
const sum  = 2 * (h * ELEV - worldY) / TILE_H;    // gx + gy
const gx = (sum + diff) / 2;
const gy = (sum - diff) / 2;
```

For the Y-down form, `sum = 2 * (worldY + h*ELEV) / TILE_H`.

**Height-aware picking matters.** An inverse projection at `h=0` is not enough to reliably select raised ground. For terrain picking, test candidate elevated diamonds from frontmost/topmost to backmost or use renderer-native polygon picking. Nodes can use their own visible-hit shapes; choose the visually frontmost candidate when they overlap.

Depth must be deterministic. A useful painter-order baseline for ground tiles is the diagonal `gx + gy`. One successful approach grouped all cells with that diagonal into a single mesh/batch, and placed row `k` at render depth `k`; objects standing on the row were drawn immediately above it. Adopt or adapt this strategy according to the renderer and scene organization. Layer groups (terrain, terrain decoration, edges, cards, overlays) must preserve occlusion rather than blindly putting everything on top.

## 4. Terrain meshing / block geometry — technical reference

Reference dimensional rules:

- A top diamond projects to **64 × 32 world units**.
- The height step is **16 units**; exposed island edges can extend at least one additional step downward to form a visible slab.
- At center `(cx,cy)` in a Y-up system, top-diamond corners are `north=(cx,cy+16)`, `east=(cx+32,cy)`, `south=(cx,cy-16)`, `west=(cx-32,cy)`.
- Build the top as textured quad triangles or equivalent geometry.
- Build **two visible outer/step wall faces** from front-facing diamond edges down to the neighboring ground elevation, or to a fixed base where no neighboring cell exists. Darken the left/right faces differently to communicate depth. When adjacent terrain has equal height, don't draw an unnecessary internal wall.
- A simple visual treatment is subtly brighter tops at greater elevations and noticeably darker walls.
- A sparse grid (`Map<cellKey, Tile>`) makes it easy to generate separate floating islands with empty void between them.
- A deterministic hash of grid coordinates can select terrain variants; avoid random tile patterns shifting after every file refresh.

If the renderer can batch textured tops and colored walls into row meshes, great. Otherwise implement a correct, reasonably efficient sprite/geometry equivalent first. **Correct overlap, elevation, and interaction outrank theoretical batching sophistication.** Terrain should not be regenerated every animation frame; rebuild affected geometry only when the scene layout changes.

### Pixel-art atlas details worth borrowing

An effective compact pipeline used **32×32 source block images** whose diamond tops occupied approximately source rows 8–24, with a small side skirt in rows 24–32. Each complete source block was drawn at **2× into a 64×64 rendered quad**, resulting in a 64×32 *top diamond*.

**Important trap:** do not squash the whole 32×32 block sprite into a 64×32 rectangle. That distorts the art and breaks the expected height/overlap.

One texture-atlas strategy is a grid of **34×34 atlas cells** containing each 32×32 sprite with a one-pixel edge-extruded border. Sample only the inner 32×32 region; use nearest-neighbor filtering for terrain pixel art and appropriate interpolation for cards, typography, and other overlays. A procedural colored atlas is fine for the proof of concept; nothing depends on having specific artwork.

## 5. Camera and input — implement, don't approximate

Implement an orthographic-style 2D camera abstraction with consistent world↔screen transforms:

- Drag-to-pan; scrolling/trackpad zoom; zoom about the **pointer position**, not merely about the viewport center.
- `fitToScene`, reset, focus/animate to an entity, and preserve camera state while swapping views if sensible.
- Reasonable zoom limits (e.g. 0.5–2.5 initially), resize and device-pixel-ratio handling, and clean mount/unmount.
- A **6 px-ish click/drag movement threshold** so camera panning doesn't accidentally select nodes.
- Pointer events starting over React inspector/toolbars must not pan or pick the underlying scene.
- Keyboard navigation and touch pinch may be follow-ups if they threaten the first slice.

For zoom anchored to the mouse, one robust algorithm is:

```ts
const anchorBefore = screenToWorld(pointer);
setZoom(clamp(zoom * zoomFactor, minZoom, maxZoom));
const anchorAfter = screenToWorld(pointer);
camera.position += anchorBefore - anchorAfter;
```

An exponentially scaled wheel factor such as `exp(deltaPixels * 0.0015)` can feel smooth, with sign adapted to event convention and normalized wheel units. Prove the world point stays under the cursor within roughly **one screen pixel** after zoom.

Handle canvas coordinate offsets: `clientX/clientY` are **not automatically canvas-local**. Use the element's bounding rectangle and render scaling consistently. Tests should include resize, pan+zoom+selection, and high-DPI screens.

## 6. Nodes, semantics, and inspector integration

Map the existing Studio entities to scene nodes using **their real stable IDs/source references**, not array indices, and reuse the selection and inspector pathways already present. Suggested display: small tinted 2.5D cards or raised icons, compact names, hover/selection borders, and miniature deployment-lane/status badges matching the existing Board.

- The rendered scene's `x/y/height`, islands and color palette are **layout state**, not framework configuration. Moving a visual node must not mutate `framework-config/` or a workload's subnet or `deploy` field.
- Compute an initial deterministic layout from the graph; separate manual layout overrides if useful. Identify where to persist layout only after inspecting existing Studio conventions.
- Avoid silently inventing accessibility, IAM, networking, or runtime implications from a node's visual position.
- Keep the **React/DOM inspector, editing controls, and diff preview**; do not rebuild forms and editors in Canvas or WebGL.
- Keep labels legible at normal zoom. Consider level-of-detail and selectively using DOM overlays for sharp text, tooltips or accessible controls.

Network and deployment indicators must be accurate: local-enabled, dev AWS, and prod AWS are distinct concepts. Lambda is serverless whether inside or outside a VPC; outside a VPC does not mean publicly reachable. A resource such as RDS can be **absent from the dev AWS graph** while used through local substitution. Agent tools may inherit their lane behavior, and event Lambdas do not share the standard deploy toggle. Read actual framework projections and don't flatten these subtleties into a misleading three-color legend.

## 7. Relationships and animated connections

Render existing **typed relationships**, not an invented generic “traffic” graph. Keep the semantic types from Studio's existing projection (route→workload, invocation, resource reference, grant, database use, workflow relationship, etc.) and make the visual encoding distinguish them. Selection should spotlight relevant connections and fade unrelated paths, with edge information available through the existing inspector or a small contextual readout.

A simple connection technique: for endpoints `A` and `B`, draw a thin line between them; its center is `(A+B)/2`, length `|B-A|`, orientation `atan2(dy,dx)`. Render behind node cards; update geometry if a node moves visually.

To imply directional motion, render **a small number** of glowing packets or dashes along selected edges. A useful interpolation is:

```ts
const k = fract(timeSeconds * speed / edgeLength + offset);
const p = A + (B - A) * k;
```

You may offset opposite directions by a few pixels into separate lanes and reserve brighter/faster animation for a selected relationship or an actual execution event. For baseline reference, speeds around 60 world units/sec (normal), 25 (degraded), 0 (inactive), and a 2 px underlying line were previously effective—but these are aesthetic examples, **not runtime telemetry**.

Avoid placing individual animated sprite entities every ~34 px on **every edge**: an earlier design produced roughly 940 animated particles on only 44 edges. For a large application prefer sparse effects, shaders, batching, or selection-driven animation. Support a reduced-motion mode.

## 8. Framework-specific scene composition

Make the layout recognizable and useful, not merely decorative. Explore:

1. An **entry-point region** for HTTP, WebSocket, service mounts, and agent routes.
2. **Compute platforms** for Lambda, containers/tasks, and agents/tools.
3. An **orchestration region** for workflows and invocations.
4. A **resource/catalog region** for typed CDK references, inputs and secrets (names/types only).
5. Optional **network regions** showing derived VPC/subnet placement when the selected deployment graph supports it.

These are sketches, not hard-coded AWS assumptions. A few routes may share one workload; a catalog resource can have multiple consumers; disabled/absent nodes should remain discoverable without pretending they are deployed. Avoid exponential clutter. Consider grouping, collapsible islands, deterministic positioning, view filtering, edge highlighting, and fit-to-selection.

The selected Development/Production mode should update the landscape consistently with Studio's current data, without rereading secrets or performing AWS actions. Use the same target enablement/deployment logic already established in the framework.

## 9. Implementation focus and scope

**Build a working vertical slice before broad polish.** A productive order is:

1. Inspect current Studio components and projection; select the least disruptive TypeScript rendering approach (briefly state why).
2. Add **Isometric** tab/view and render a few raised, shaded islands using correct projection and depth.
3. Add pan, cursor-anchored zoom, fit/focus, and hit testing.
4. Populate real routes, workloads and catalog entities, preserving IDs and selection/inspector wiring.
5. Draw real typed edges and a restrained animated highlight.
6. Add environment/deployment badges, coherent grouping, visual refinement, and a few performance checks.

**Do not turn this phase into a redesign of source editing, the evaluator, Docker Compose, resource authoring, workflow compiler, or networking rules.** No need to implement workflow-run overlays or relationship editing before the first convincing isometric scene. Do not modify live AWS infrastructure, synth/deploy, secrets, or framework configuration as a side effect of trying the visualization. Preserve working Studio edits on the existing Board/Inspector.

I want you to experiment with art direction: dark empty background, separated elevated miniature islands, textured diamonds, subdued glowing connections, distinct service icons, and clear selected-node emphasis. The output must look noticeably different from a conventional dependency-board layout, while remaining readable and practical.

## 10. Acceptance criteria and delivery

Verify and demonstrate:

- **Real geometric depth:** raised islands have tops and side walls; overlap is correct at multiple heights.
- **Real data:** nodes and edges originate from the existing Studio/framework projection, not just hard-coded demo names.
- **Camera:** drag/pan, zoom under pointer, fit/reset work, including after resizing.
- **Picking:** clicking overlapping/elevated cards selects the intended entity under multiple zoom levels; dragging the camera doesn't select nodes.
- **Editor integration:** selected entities open the existing inspector and source-navigation actions, with Board and Lanes still functional.
- **Deployment semantics:** switching modes gives accurate indicators and doesn't misrepresent absent/dev-only resources or private/public network placement.
- **Rendering efficiency:** no unnecessary full terrain rebuild each frame or thousands of animated particles; measure or inspect rough performance with the real repository's graph.
- **Safety:** framework source files are not rewritten by camera/layout interactions; existing edit-preview and validation behavior is preserved.
- **Quality:** run relevant Studio tests, typechecks, and `npm run verify`; actually launch the view and inspect it in a browser if available.

Give me the working implementation, a screenshot or precise browser verification evidence when possible, a concise summary of files changed, test results, and the biggest remaining visual/engineering limitations. If you encounter a tradeoff, choose the smallest implementation that demonstrates the actual isometric engine rather than expanding the design document.

**This phase is about seeing the isometric world work. Build it.**
