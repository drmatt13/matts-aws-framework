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
   Resource type is supporting text. Keep an individual resource or single connection's
   environment pair at the top right beside its title; aggregated connections and input
   groups put a pair beside every member, even when all members share one availability,
   and none beside the title.
   Physical gateways and stacks retain their own resource pair;
   their full route/field inventories belong in the Inspector.
   Framework ownership reuses the Inspector's outlined **Framework managed** badge
   and lock icon on its own left-aligned line beneath the resource type. The type
   omits a redundant management prefix and never repeats the name above it.
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
   mode, including endpoint names and resource types that differ between graphs.
   Shared facts appear once, as one sentence about every member; mode-specific
   exceptions remain qualified. A Dev or Prod qualifier distinguishes environments
   that both hold the item; a fact about the only environment that holds it is not
   qualified, and an undeclared entry is its unlit pill rather than a sentence.
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
The type line tucks 3px under its title (1.35 line-height), and pills never make the
title row taller. Stacked metadata (From/To rows and Dev/Prod locations)
shares one compact rhythm: 1.4 line-height with 2px between rows, a 20px pitch at 13px
and 19px for 12px locations. Cards are opaque.
Quiet dividers separate member rows without turning every fact into a badge.
Forced-colors styling retains labels and distinguishes omitted pills with borders.

## Redundancy and spacing pass, 2026-10-28

A second pass reviewed all **135** map previews in the repository snapshot (66
connections, 10 islands, 16 network fixtures and 43 resources) for repeated or
self-evident copy and for spacing. Each change follows from a rendered card:

| Observed | Resulting rule |
| --- | --- |
| A stack titled `RdsStack` had the type line `Stack, RdsStack` | The type line never repeats the name. A catalog stack names its entry (`Stack · resources.rds`), which is also what its connections call it; a framework stack reads `Stack` |
| `Calls tool: multiply-numbers` above `To multiply-numbers`; `Provides database: rds.database` above `To rds.database` | A single connection whose value only repeats an endpoint keeps an action label (`Calls tool`, `Provides database`, `Connects to database`, `Conditional Deployment`). Authored labels such as route keys and variables stay |
| The `rds` stack appeared as a **Database** endpoint | Only the database itself is a Database; its stack is a Stack |
| Prod-only database connections prefixed every fact, and the Permissions label, with **Prod** | Qualify only facts that differ between environments holding the member |
| `Applies to every entry` labelled a single sentence; groups added `Prod: No entries are declared.` beside an unlit Prod pill | Shared facts are one sentence (`Every input uses its declaration default.`); absence is the unlit pill |
| `Conditional deployment: $enableWebSocketApi` with `Matches "true".` | `Conditional Deployment`, with `Deploys when enableWebSocketApi equals "true".` |
| Two VPCs showed identical `s3 endpoint` cards | Fixtures name their kind and VPC: `Gateway endpoint · test VPC` |
| Map labels showed through the 98%-opaque card | Cards are opaque |
| The type line sat 8.5px of air below its title; From/To rows had a 23.5px pitch, Dev/Prod locations 22px; a closing rule ended lists that were last in the card | 5.5px under the title on every card, islands included; one 20px metadata pitch (19px for 12px locations); a list's closing rule appears only when content follows |

Group and connection member order is unchanged: connection rows keep
`aggregateConnections`' stable edge-id order, group rows keep declaration order.

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
scanning. Page Up and Page Down scroll an overflowing map preview while retaining
the keyboard trigger's focus. Touch opens inspection. Filtering away a trigger, closing its panel or
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

- Presentation/group/placement checks: **61 passed** across the focused suites;
  map and resource-browser interaction checks: **75 passed**.
- Studio build and typecheck passed. Repository `npm run verify` completed its
  artifact/typecheck gates but the broader Studio suite reported **9 failures**
  outside tooltip presentation: assertion formatting, graph/model expectations,
  and source-edit/generator failures. The Studio suite had 1,009 passes and two skips.
- Playwright inspected all **66 connections** at **1280×720**, **390×844**, and
  **320×640**, including all 18 aggregations; member counts, individual environment
  pills, viewport bounds and horizontal overflow checks passed. The Production
  source was checked at 390×844, along with all **69 resource/island/fixture previews**.
- Browser fixtures covered 40 members, a long identifier, mixed environments and a
  warning on the final row; contained scrolling reached the warning. Light/dark
  themes and forced colors were inspected, including dashed omitted-pill borders.
  Pointer crossing/persistence and Escape were exercised on the map at 1440×1000.
  After the header refinement, all **48 single connections** kept their pills at
  the top right at both desktop and 320px widths without horizontal overflow.
- Chrome DevTools independently checked all 66 connection previews: 400px preferred
  width, 16px padding and 12px content gaps matched the intended layout. Its app
  session had no console errors/warnings or failed observed API requests.
- Live AWS, deployed IAM and database operations are outside this UI audit.

