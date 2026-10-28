# Tooltip information and interaction audit

Audit date: 2026-10-27. This covers the architecture map's resource, connection,
input-group, island and network-fixture previews, including the Resources panel.
It assesses source configuration and presentation; a tooltip does not establish
deployed infrastructure, effective IAM access or runtime health.

## Scope and findings

The repository snapshot contained **66 connections**, including **18 aggregations**,
across **9 workload roles** and **6 catalog kinds**. The roles were HTTP, WebSocket,
WebSocket authorizer, event, tool, service, task, workflow and agent; the catalog
kinds were stack, member, input, secret, group and environment file. Shared helpers
and synthetic fixtures also cover the **21 relationship families**, including
agent invocation, callbacks, integrations and WebSocket management that are not all
represented in that snapshot.

| Finding | Resulting rule |
| --- | --- |
| Only supplies and groups had per-item pills; other bundles hid individual availability | Every aggregation lists every member with its own Dev and Prod pills; omit a redundant aggregate pair |
| Active-mode fallback could describe another environment's value, label or grant | Read both graphs independently and qualify differing details by environment |
| Group missing-value notes considered only the selected graph | Preserve both environments' required, default, optional, absent and unknown states |
| Default and IAM prose repeated beneath otherwise identical rows, or vanished from bundles | Show facts shared by every member once; keep exceptions with their member |
| Titles, endpoints, prose, IAM and warnings formed one flat text stack | Separate identity, labeled endpoints, member rows, shared details and warnings |
| Execution location was available only in screen-reader text | Show compact Dev/Prod locations on workload, route, local-service and gateway previews |
| Off pills and warnings were too close to secondary-copy styling | Keep omitted pills readable; distinguish warnings with text and a visible rule as well as color |
| Canvas placement guessed a fixed height and could not accommodate long lists | Measure content, constrain it to the visible map/window and allow contained scrolling |
| Map and Resources previews differed in persistence and keyboard behavior | Use dismissible, hoverable previews with stable focus and shared presentation |
| Decorative image titles could compete with the custom Resources tooltip | Decorative row icons and attention markers do not intercept pointer hover |

The 21 families are environment reads, startup secrets, input supplies, client
mappings, routes, authorizers, grants, database connections, local replay, triggers,
task calls, workflow calls, agent calls, tool calls, workflow steps, integrations,
callbacks, WebSocket management, containment, CDK references and deployment conditions.

## Presentation rules

1. Lead with the resource name or the connection's action and relevant value.
   Resource type is supporting text. Keep a single connection's environment pair
   near its title; aggregated connections and input groups use row-level pairs.
2. Render **From** and **To** as aligned metadata labels with separate endpoint
   names and kinds. Long names wrap without pushing a pill outside the card.
3. Retain all original members, including ones present only in the other graph.
   Supply rows use the catalog parameter name; variable assignments and full
   source evidence remain in the Inspector.
4. Distinguish meanings: group pills describe declaration availability, supply
   pills describe delivery by the named file, and connection pills describe a
   relationship with enabled endpoints. A lit pill does not mean a value is set
   or that AWS has been deployed.
5. Keep each mode's label, requirement, condition and permission attached to that
   mode. Shared facts appear once; mode-specific exceptions remain qualified.
   Missing required values name the affected variable/file and receive warning
   emphasis. Normal configured values need no status sentence.
6. Present permissions after operational information, in a labeled secondary
   block. The summary preserves native operations and scopes; full policy,
   source-inference caveats and authorization evidence stay in the Inspector.
7. Values, secret contents, resolved parameter defaults and private requirement
   reason strings never enter group status copy. “Uses the declaration default”
   describes presence without exposing that default. Authored descriptions are
   bounded previews; the Inspector retains their full text.

Cards use the existing dark scene surface, typography and environment colors in
both application themes. The shared geometry is a 400px preferred width, bounded
by available space; 16px outer padding; 12px between content blocks; 8px between
related details and within rows; and 4px between a member and its supporting copy.
Quiet dividers separate member rows without turning every fact into a badge.
Forced-colors styling retains labels and distinguishes omitted pills with borders.

## Interaction and placement

[`ResourceTooltip.tsx`](../../framework-studio/src/views/ResourceTooltip.tsx)
measures the full content size, including overflow. Resources previews prefer the
map side of the triggering row; narrow windows choose above or below. Canvas
previews use the intersection of their host and the visual viewport. Both retain
an 8px viewport margin and a 12px separation from their trigger where space permits.
Resize and visual-viewport changes remeasure the card instead of relying on a
fixed-height estimate. Long lists scroll inside their constrained card.

The intended interaction is dismissal with Escape without changing selection or
moving focus, pointer movement into the preview without losing it, and enough
time to read while its trigger or card remains active. Resources keyboard focus
opens immediately; pointer entry has a brief delay to avoid flashing cards while
scanning. Touch opens inspection. Filtering away a trigger, closing its panel or
invalidating its source removes stale previews. These decisions follow the
dismissible, hoverable and persistent rationale in
[W3C's explanation of WCAG 1.4.13](https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html).
This audit is not a WCAG conformance assessment.

## Dynamic validation matrix

| Dimension | Source and synthetic cases | Evidence owner |
| --- | --- | --- |
| Relationship coverage | All 21 families; single, aggregated and both-disabled endpoints | [Connection presentation tests](../../framework-studio/test/connection-presentation.test.ts) |
| Environment differences | Dev only, Prod only, both; different member sets, variable names, conditions, native scopes and IAM summaries | Connection presentation tests |
| Aggregation size | One member, several members and 40 members; missing requirement in the final row | Connection presentation tests |
| Input status | Configured, shared defaults, one-mode missing, optional, unknown and absent; nested Prod-only secret; empty group | [Hover tests](../../framework-studio/test/hover.test.ts) |
| Value isolation | Sentinel default and private reason strings must not appear in projected group details | Hover tests |
| Runtime and ownership | Local, AWS and combined Development execution; framework ownership; unused stacks; built/unbuilt VPC fixtures | Hover tests |
| Placement | Every corner, portrait windows, oversized content, tiny/partially hidden hosts and visual-viewport offsets | [Placement tests](../../framework-studio/test/resource-tooltip.test.ts) |
| Interaction | Resource/map parity, Escape, focus retention, crossing into cards, list scrolling, touch, filtering and disposal | [Isometric UI tests](../../framework-studio/test/isometric-ui.test.ts) and live browser checks |
| Visual presentation | Long identifiers, dense aggregates, shared/default versus exceptional notes, both themes and forced colors | Live browser and Chrome diagnostics |

## Validation record

- Group hover unit checks: **18 passed** during this audit.
- Combined presentation, placement and interaction checks: **pending** final coordinated run.
- Studio build/typecheck and repository verification: **pending** final coordinated run.
- Live desktop/mobile, keyboard, scrolling, visual-viewport and console/network checks:
  **pending**. Record actual viewports and scenarios after execution.
- Live AWS, deployed IAM and database operations are outside this UI audit.

