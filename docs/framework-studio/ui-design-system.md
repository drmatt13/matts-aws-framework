# Studio UI design system

Studio keeps its graphite surfaces, environment colors, AWS artwork and isometric map.
React presentation uses Tailwind CSS 4 through the native Vite plugin. Keep layout
next to JSX and repeated appearance in `src/ui/` primitives or existing component
implementations. [Inspector conventions](inspector-design.md) describe the information
order and source-review workflow. The migration changes presentation ownership, not the
visual system or source-editing contracts.

## Styling ownership

There are exactly four production stylesheets:

| File | Owner and allowed contents |
| --- | --- |
| `src/styles.css` | Application entry, layer order, explicit `src/` and `index.html` sources, inclusive media/container variants |
| `src/styles/theme.css` | Runtime tokens, OS light/dark values, `@theme inline` aliases, shared keyframes |
| `src/styles/base.css` | Document sizing, native font inheritance, focus/hidden/reduced-motion safeguards and browser-owned pseudo-elements |
| `src/styles/codemirror.css` | CodeMirror-owned DOM and Prisma syntax integration, loaded by `PrismaEditor` |

Preflight is intentionally omitted. Import theme and utilities separately; do not add
PostCSS, Autoprefixer, forms plugins, JavaScript Tailwind configuration or a second
runtime theme. Ordinary feature stylesheets and `@apply` facades are not supported.
CodeMirror's narrowly scoped adapter remains unlayered to cooperate with injected
editor styles. Its controls explicitly own appearance that React primitives cannot reach.

`Button`/`buttonClasses` share primary, neutral, quiet and link variants; compact,
regular and prominent sizes; default and danger tones. Repeated compact trigger rows use
`size="dense"`; `size="custom"` leaves padding and minimum height to explicit caller
utilities for uncommon geometry. `IconButton` requires an
accessible label. Quiet danger icon buttons use graphite at rest, the shared rounded wash
on hover, and the refuse color on hover or visible keyboard focus. Destructive confirmation
buttons retain their explicit danger treatment.
`TextInput`, `Select` and `Textarea` retain native props/events/refs;
`controlSize` is separate from the native `size`; `controlSize="panel"` follows the
inspector or dialog control-height token. `UnitInput` draws a numeric unit inside the
input's trailing edge; callers keep the unit in the accessible label. `Select`'s
`appearance="quiet"` is for a setting inside another control's frame, such as the model
beside the Agent composer: no box until pointed at, as wide as its value, and the caller
bounds its width. `Card` and `Notice` cover shared surfaces. `Notice` does not invent an
ARIA role.
`InspectorUI`, `FieldRow`, `NavigationStrip`, `WorkspacePanel`, `WorkbenchUI` and
`DocumentCard` remain the higher-level owners. `cx` joins complete static class strings;
it does not resolve conflicting utilities, and JSX class order is not CSS precedence.
Use appearance props/recipes instead of conflicting caller overrides.

| Reuse tier | Owners | Use and limits |
| --- | --- | --- |
| Native UI primitives | [src/ui/](../../framework-studio/src/ui/): buttons, form controls, cards, notices and toolbar | Preserve native props, refs, events and submission behavior; appearance variants do not own application state |
| Shared application composition | `InspectorUI`, `FieldRow`, `NavigationStrip`, `WorkspacePanel`, `DocumentUI`, `WorkbenchUI` | Reuse the existing information/layout contract; each workflow retains its draft, approval and modal policy |
| Source/context retry feedback | [RetryNotice.tsx](../../framework-studio/src/views/RetryNotice.tsx) | Stateless alert with a retry action for document-workspace read failures; caller owns the query, message, retry label and pending state |
| Feature rendering | [views/inspector/](../../framework-studio/src/views/inspector/), [views/map/](../../framework-studio/src/views/map/), existing deployment/WebSocket modules | Keep feature-specific props and semantics; extract cohesive rendering without inventing universal configurable components |
| Domain and integration behavior | `draft-entries`, `editing-state`, typed endpoint/query adapters | Keep validation, edit gating and side effects outside presentation primitives; see [editing](../aws-studio-knowledge/studio/editing.md) and the [source map](../aws-studio-knowledge/REPOSITORY-MAP.md#where-to-change-studio) |

`RetryNotice` intentionally covers only the equivalent source/context retry rows.
Stale observations, ordinary status messages, operation outcomes and modal errors keep
their existing components and ARIA behavior. Similar markup alone does not establish
a shared lifecycle or approval contract.

`ToastNotice` owns transient notification appearance across Shell, Deploy and the
fullscreen Database editor: a graphite border, wrapping message and a circular
top-right dismiss button. Callers own dismissal state and existing expiry timers.
The button has an accessible name, visible keyboard focus and a 44px coarse-pointer
target; message padding reserves its space.

Dialog primary actions compose `dialogPrimaryActionClasses` directly with
`buttonClasses`. This preserves their 110px minimum and full row at 420px and below;
the footer no longer finds them through `data-variant`. `Button` still emits that
attribute for inspection and integrations. Attributes identify UI, state, focus targets
and test fixtures; ordinary layout must not depend on a distant selector finding them.
Native dialogs explicitly restore pointer events when rendered inside map overlays.
Boolean field help and inheritance details span both grid columns, leaving the
switch column sized by the switch itself; never place long support copy in that
auto-sized column.
On short windows, the stacked map panel retains a 260px minimum and uses workspace
scrolling so its resource rows remain reachable. Dense operational tables retain
readable column widths inside named, keyboard-focusable horizontal scroll regions.
Database review transitions reset the modal body scroll when the review title changes.

`src/inspector-ui.ts` contains explicit recipes for inspector headers, section gutters,
field rows, labels, relationship rows and native dialogs. Import the recipe at the element
it styles: `inspectorHeaderClasses` belongs on a header, `inspectorRelationRowClasses`
on each list item, and `inspectorFieldLabelClasses` on the label. Choose switch/stacked
field geometry and modified-label treatment from component state instead of inferring
them through descendant roles or `data-slot`. `InspectorSection` and
`InspectorDisclosure` accept `contentClassName` for their content layout, so callers can
set a shared grid or gap without reaching through the component's DOM.

Problems on map entities have one producer, `src/issues.ts`, and one treatment per surface.
Errors use `refuse` (inspector) or `map-error` (map cards and canvas); warnings use `local`
or `map-warning`. Inspector headers end with `IssueNotice` (a `Notice` per issue: glyph and
title, then the same sentences the hover card shows; errors are alerts, warnings notes) and
pass `issues={false}` to `ResourceStatus`, so a header never states a problem twice. Lists
too narrow for a notice, such as island entries, use `IssueChips`. Map cards use
`HoverIssues` and `hoverToneClasses` from `views/map-styles.ts`; a neutral `info` tone
marks expected, non-problem reasons. Colour is never the only cue: every issue keeps its
glyph and words.

Resource ownership badges own their spacing and appearance in `ResourceStatus.tsx`.
Their explicit `placement` and `appearance` props cover inspector headers and dark map
previews. Changing the managed badge's margin starts in that component; neither
`data-resource-status` nor the inspector scroll area supplies it. `Written` owns its
source-line layout and header placement. `EntityIcon` accepts a literal pixel `size`
(20, 22, 24, 26 or 32) and optional badge size; consumers no longer resize its private
image through an attribute selector.

`DocumentUI` and `WorkbenchUI` keep shared document recipes near their composition
components. Feature forms own their labels, control widths, supporting copy, table cells
and disclosure contents. Repeated tooltip typography and fact rows live beside their
surface recipe in `views/map-styles.ts`; resource and connection tooltip JSX references
them directly. Use `FormGroup appearance="plain"` when a fieldset needs a plain frame
instead of overriding nested fieldsets from an ancestor.

The theme supplies 32px control/icon and 24px disclosure-target defaults. Inspector and
dialog contexts retain their scoped 44px coarse-pointer minimums. Browser-owned
pseudo-elements, ARIA/native disclosure state, focus-within behavior, forced-color
adaptation and third-party CodeMirror DOM remain appropriate selector uses. The Shell's
recovery row uses `:has` because its asynchronous child owns whether it is present.
These boundaries are distinct from ordinary component spacing and typography. Preserve
DOM behavior and compare computed geometry when removing a selector; class string order
alone never establishes which conflicting utility wins.

Put one-off placement in JSX. Extract repeated appearance into its actual component or
small typed variant recipe, never a runtime mapping from old presentation class names.
Do not interpolate utility fragments. Use semantic colors, preserve the 4px spacing
base and the existing rem type roles, and reserve arbitrary values for actual geometry
or documented parity exceptions. Do not replace exact pixel/container boundaries with
Tailwind defaults: `vp-*`, `map-band`, `inspector-*`, `detail-640`, `coarse` and
`forced-colors` variants encode the original inclusive queries.

Tailwind side-border utilities already set that side's style. Without Preflight, adding
an all-sides `border-solid` to `border-b` can activate unwanted native medium widths on
other sides. Native dialogs must only acquire flex/grid while open; `[hidden]` remains
a document safeguard. Preserve explicit submit buttons, cancellation/busy guards,
autofocus and focus return. Behavior and measurements use refs, roles and stable data
attributes, never presentation classes or assertions about utility strings.

| Concern | Shared convention |
| --- | --- |
| Spacing | `--space-1` through `--space-8`: 4–32px in 4px steps; workspace gutters: 16px; document page column: `pageWidthClasses`; inspector gutters: 20px |
| Type | Document pages: 18px page titles, 15px card/subsection titles, 13px nested titles and labels, 14px body, 12px supporting text; sans headings at 600 weight; native controls inherit their context |
| Controls | 32px regular, 28px compact, 36px prominent; icon actions are square |
| Surfaces | Existing theme colors; `rounded-sm` is 4px, `rounded-md` is the regular 6px, `rounded-lg` is 8px |
| Selects | Native keyboard interaction; 14px chevron inset 12px with a 10px text gap |
| Actions | `Button`, `IconButton` and their recipes; destructive actions use `tone="danger"` |
| Feedback | Stable outline focus, shared disabled and invalid states, reduced-motion support, native select arrows in forced colors; entity problems through `IssueNotice`, `IssueChips` and `HoverIssues` |
| Motion | State changes are instant except explicit spatial transitions. The bottom Activity/Agent drawer uses an interruptible 280ms `cubic-bezier(.22,1,.36,1)` slide, disabled under reduced motion. Loading and busy indicators may pulse with `animate-deploy-pulse`, off under reduced motion. The map's Local runtime switch (`views/map/ComposePreview.tsx`) uses interruptible transitions on the `--spring` and `--spring-bounce` curves plus its `compose-*` keyframes in `styles/theme.css`, all off under reduced motion and the map's Motion toggle |
| Density | 4px within a group (label, control, support; identifier and source), 8px action-to-note, 12px heading-to-content, 16px sections; use container gaps rather than stacked paragraph margins |

## Navigation and workspace rhythm

The application bar owns the app's name (renamed in place from its pencil), eight
navigation links (seven core workspaces and the auxiliary Agent test experiment) and
the **Source** Development/Production selector, which sits at the right on every route. The navbar
uses a 52px row on desktop, 89px with two rows at 760px and below, and 129px with
three rows at 560px and below. Route changes never add or remove source controls.
When the configuration does not load, the canvas banner's **Show why** opens
configuration details.

`SourceEnvironment` mounts once in `Shell`. It reflects the framework's two declaration
projections and retains the unsaved-draft guard. Deploy, Database and inspection forms
keep their own named-target and region controls, and display the active Source profile
through `AwsConnectionSummary`; profile selection lives in the navbar. Domains edits Production
domain settings; Database edits one shared contract and keeps its editor's draft undo.
Source-edit undo/redo controls and APIs are removed; use Git for saved source history.
Failed-write rollback and interrupted-write recovery retain their existing guards.

`NavigationStrip` provides the shared link/button geometry for primary navigation,
Cognito sections and Database workspaces. Native links and buttons retain their keyboard
behavior. Overflow scrolls within the strip; active items and keyboard focus are revealed
without moving the surrounding page. Keep each name on one line.

Studio has exactly two page layouts. **Workbenches** (Map and Database) are tools that need
the whole window: their toolbars and content run edge to edge within 16px gutters, and
Database's tabs keep that frame so its navigation stays still when moving to and from the
Schema editor. **Document pages** (Deploy, GraphQL, Cognito, Domains, WebSockets and Agent
test) share one column; a new page is a document page unless it needs the whole window.

Document pages share header geometry; Deploy uses a plain page header that blends into
the page, keeping machine readiness beside its deployment heading in the same column.
It has no toolbar surface or visible bottom rule. Deploy omits the full-width This machine,
frontend-release and stateful-retention cards; header readiness, findings and operational
evidence retain their existing controls. Other document pages retain their toolbar surface.
Deploy reserves the account/region caption line even during reads. Login errors use that
same caption line as a red text action with an underline on hover/focus, opening AWS profile
configuration instead of adding a button or error card. On narrow screens, machine readiness
always occupies its own row so switching declaration modes does not reflow the header.
`pageToolbarClasses` owns `--toolbar-padding` (12px vertically), `--toolbar-height` (57px
minimum including the rule), the `--sheet` surface and the `--rule` bottom border.
`workspaceToolbarClasses` adds `--workspace-gutter` (16px) for workbenches. Controls are 32px tall.
Additional rows accommodate genuine controls, warnings or narrow widths; do not add a
route-specific heading spacer or an inset rule above the first toolbar. Keep responsive
utilities with their owning component; register shared query variants in the application entry.

Composition preserves each workspace's purpose. Isometric devotes its area
to the map, without a redundant page heading. Database leads with its workspace tabs
and editor controls. Deploy follows the global Source mode, with machine readiness at the
right of its deployment heading. Cognito's section navigation precedes variable
inspection evidence so its position remains stable.

Document pages compose three recipes from `DocumentUI`. `PageToolbar` draws the full-bleed
toolbar surface and puts its contents in the column. `pageWidthClasses` is that column:
centered, `--workspace-page-max` (1280px) wide including the 16px gutters; use it for
subsection navigation or a full-bleed strip's contents. `pageBodyClasses` is the column plus
the rhythm below a toolbar: 16px above (12px at 720px and below) and 24px below. Titles in a
toolbar use the 18px `pageTitleClasses`; Deploy's deployment name is its page title.
Page chrome stays outside the column: the navbar and global Activity tray span the window.
Activity occupies the final shell row on every route; its memoized owner stays mounted
through navigation. Opening the bounded tray reduces workspace height instead of covering
content, including on narrow screens. The map canvas is the one exception: it keeps its height
and runs beneath the tray, so opening it moves nothing on the map. `--activity-drawer` is the
drawer's one height, notices included, and the `activity-open` variant styles anything that
depends on the tray.
The map's bottom dock fades out over 140ms when the tray opens and returns over
220ms after an 80ms lead-in as it closes. Opacity reverses from its current value
on rapid toggles; visibility follows the exit fade and pointer input stops immediately.
The `activity-expanded` variant follows toggle intent, while `activity-open` retains
the map's layout through the closing slide. The map's Motion toggle and OS reduced
motion disable the dock fade. A dock above a stacked phone panel remains available.
While open, only the thin top-edge separator resizes that shared height, preserving
it for the mounted shell. The separator supports Up/Down and Home/End; window
resizing bounds the drawer to the window; it can cover the navigation at full height.
The shell keeps a small workspace reservation for hidden toolbar layout and caps the map compensation
at that reservation, preserving its camera even when the tray covers the whole screen.
Pointer resizing disables
the shell's height transition until release; opening and closing retain their slide.
The Agent panel spends the drawer on its transcript. Its Conversation and Sightline views
are a second tier in the bar, unbordered beside the bordered Activity/Agent modes, and they
replace the panel's summary while it is open. Heading, suggestions, composer and helper line
share one left edge in a 752px column, using the document title and support roles. The empty
state centres in the transcript; a conversation starts at its top and takes a rule above the
composer. The composer is one 46px row that wraps at 650px, its focus border is `--faint`
rather than the near-white `--graphite`, and whatever stops a question from being sent takes
the helper line's place, in the warning or error colour.
Shared `DocumentCard` and its native child controls
own 6px corners, 16px padding (12px at 720px and below) and 12px spacing between content
groups. Page-level cards are 12px apart; avoid per-route card overrides.
`documentTitleClasses`, `documentSubheadingClasses`, `documentProseClasses` and
`documentSupportClasses` name the document type roles. Heading level follows the content
hierarchy independently of visual size: cards below a subsection heading use `h3`.
`documentSummaryClasses` gives native disclosures a 32px minimum target, 13px semibold
sans text and immediate state changes; whole-card disclosure titles use the 15px title role.
Deploy and Cognito select the document appearance of retention controls; Database keeps
its workbench appearance. Inspection/search rows align control bottoms, with no bottom margin
on toolbar labels. Source actions group their button and supporting explanation;
on narrow screens the actions wrap within the card. Flow-spacing selectors exclude
native dialogs so browser modal centering remains intact.

Cognito and Domains share `inspectionControlClasses` for connection summaries, deployment and region
fields, including label spacing, 32px inputs and responsive wrapping. Cognito groups
source provenance and its evidence disclosure on one wrapping support row. Inspection
transport failures explain how to restore the Studio connection and retry; server
diagnostics and earlier observations remain available.

Load failures use a contained `Notice` in the same content column, with
wrapping details and a nearby retry action. Keep independent source and deployment
context failures independently recoverable, and show progress during retry. Alerts
must remain visible without widening the document or separating them from their controls.
Deploy keeps its plain title header and column through loading, missing profiles, missing targets
and read failures; background read failures retain the deployment and contextual retry.

Database workspace choices use a restrained selected treatment: wash surface, rule
border, regular radius and readable foreground. The map retains its compact floating
creation action.

Isometric search, tag filters and camera controls occupy a normal-flow toolbar outside
the measured canvas. Wrapping controls must reduce the canvas viewport rather than cover
resources. The scene remains dark in both themes; its toolbar follows the application
theme. Use the existing scene container for pointer coordinates, resize and camera fit.
At 701–1100px, search and tag filters share a full-width row above camera
actions. Search counts and reset actions must leave the input editable at every width.
The map footer gives resource/connection counts; tile counts and frame timing belong
to the existing diagnostics API, not normal application chrome.

Deploy keeps its name on the left and machine readiness on the right of the same heading
row. Issues and remedies precede passed checks in both visual and keyboard order. Narrow
layouts wrap the group below the name, retaining right alignment within the page column. AWS connection details
remain in the global Source menu; the deployment heading retains account and effective
region. A profile's
default region never overrides a selected target's pinned region. Uninspected deployment
status says **Unverified**. Related deployment disclosures share one summary target.
Healthy machine checks collapse into
one named disclosure with versions/details on demand. Warnings, failures and remedies
remain visible. Refresh reports pending state and partial failures, keeps prior results
available and works when no profile is configured. Never communicate refresh failure
only through a disappearing notification.

Cognito uses one persistent workspace below the application bar. Its internal route
navigation has the same restrained selected treatment, followed by one wrapping
connection/deployment/region toolbar and compact evidence status. User Pools starts
with pool identity and app clients; provider setup and policy tools have their own
routes. Use bounded, horizontally scrollable tables for long provider/role metadata,
wrapping identifiers and associated form labels. Keep source declarations, AWS
observations and simulation evidence individually labeled. Technical limitations
belong in contextual disclosures; failed reads, missing prerequisites and stale
evidence remain visible and actionable. Subsection navigation preserves mounted
forms and must not invoke the leave-workspace discard flow.

## Inspector density and disclosure

Keep identity and source first, then a compact **Tags** disclosure with its effective
count, followed by deployment and operational controls. Tags retain a visible **Modified**
or **Needs attention** state when collapsed. Supporting disclosure headings use a 32px
target with 8px vertical padding on each side, shared gutters and a hover cue. Do not add empty sections or repeat generic
descriptions above self-explanatory controls.

Use `FieldRow` for registry-backed fields; it dispatches boolean domains to the shared
On/Off switch, including build options and inherited defaults. Keep inheritance/reset
information, native keyboard behavior and complete draft gating when changing a
control's presentation. Route paths, helper text and validation share an associated
label and description. Dialogs and expanded disclosures follow the same form geometry.

Numeric defaults, reset actions and collapsed provenance share a wrapping support row;
expanded provenance occupies its full width. Creation fields begin with their naming
help, then show field errors after interaction or blur. Canonical validation still
disables review from the start, and server errors remain immediate.

Set select surface colors with `background-color`: the `background` shorthand removes
the shared chevron. Do not reset select padding in component styles. Search fields use a
single enclosing focus outline and explicit labeled reset actions where provided.
Helpers and validation belong with their control and are connected through
`aria-describedby`; labels remain associated when errors appear.

Inspector forms respond to their container width, including when a desktop map leaves a
narrow panel. Long identifiers wrap in metadata, while constrained map cards and selects
truncate with their full identifier available. Related key/value fields align; section
gutters and rules belong to shared sections rather than individual paragraphs. Creation
forms keep their descriptions, tag editors and list controls across the full form width.

Keyboard users can operate map and deployment menus with arrow keys and Escape. Search
reset, tag deletion, and drawer dismissal retain a useful focus destination. The map's
accessible resource list becomes a bounded visible navigator while it contains focus;
Escape returns to the canvas. Native dialogs keep their browser focus containment.
Deployment cards adapt to available width; review tables scroll within their own region
and confirmation actions wrap without leaving the dialog. Log updates follow the bottom
only while the reader remains there.

Gate a form's related controls together. VPC and workload placement editors pause native
inputs, switches, placement selects, endpoint pickers and removal actions during pending
review/apply, configuration evaluation, stale configuration, and source conflicts.
A partially disabled form invites edits that cannot participate in the displayed review.
The shared draft enforces its accepted-write boundary independently of control state;
see [editing transactions](../aws-studio-knowledge/studio/editing.md).

## Audit and regression coverage

The consistency audit covered shell navigation and health, Board, Isometric controls,
creation, configuration inspectors, tags, public fields, database schema, and deployment
overview/review/deletion/activity surfaces. In addition to spacing and chevron defects it
found empty Settings sections, missing secret-only Environment disclosures, resource-only
Boards mistaken for load failures, empty map mount/recovery crashes, invisible keyboard
focus, incomplete creation conflict gating, background refresh errors discarding drafts,
and log refreshes losing the reader's place. Initial connection failures offer retry;
background failures preserve the current map and draft with a persistent retry notice.

`inspector-styling.spec.ts` exercises ownership badges, missing-source headers, grouped
inputs and environment-file inspectors at desktop and phone widths. It records measured
geometry and screenshots while checking keyboard disclosure and overflow behavior.
It also checks local-value gutters, loading/read-error/missing-file states, synthetic
secret masking and reversion, and long client mappings at 1440, 1100, 390 and 320 px.
Those fixtures never read real input values or apply source changes; both themes receive
keyboard, geometry and accessibility checks.

Interaction regressions live in `navigation-polish.test.ts`, `isometric-ui.test.ts`,
`draft-ui.test.ts`, `startup-ui.test.ts`, `cognito-workspace-ui.test.ts`,
`domains-workspace-ui.test.ts`, and `deploy-ui.test.ts`. Browser checks should include desktop,
380px inspector panels and 320–420px windows, expanded disclosures, long identifiers,
creation and unsaved-change dialogs, forced colors, and both themes. Deployment review
and deletion can be exercised with mocked API responses while refusing all operation
requests. These checks establish UI behavior; applying source, deployment, live database
operations and infrastructure replacement retain their separate authorization boundaries.

`document-style.spec.ts` checks the shared Deploy, GraphQL, Cognito and Domains type
roles, card geometry, heading hierarchy and disclosure keyboard behavior at desktop and
phone widths in both themes. It also covers Deploy loading, failed reads, missing profiles,
missing targets and keyboard retry. `responsive.spec.ts` checks the shared document column
at 1512px, 1100px and 390px. These are presentation fixtures, not live AWS observations.

For control changes, exercise the complete stage → review → back/discard lifecycle,
including a delayed review and stale source. Check the rendered disabled state and
keyboard focus as well as the draft transitions. Browser checks should report the
actual viewports and workflows exercised; unit fixtures alone establish neither layout
quality nor live AWS behavior. Build output and current checks belong in the engineering
handoff rather than permanent historical test counts here.

## Browser regression workflow

Run `npm --workspace framework-studio run test:browser` after the production build and
focused Node suites. Playwright owns strict preview ports 4592 (production entry) and
4593 (test-only gallery); it never reuses an unknown development server. The gallery
has a separate HTML entry/output and explicit test sources, and never enters the app's
routes or production scan. Install the pinned browser binaries with
`npm exec --workspace framework-studio -- playwright install chromium firefox webkit`.

Fixtures intercept APIs and designated WebSocket URLs and simulate EventSource events;
unexpected network requests fail. They inject the protocol/token before modules execute,
fix time/locale, and fulfill the seven production font faces from licensed local test
copies. Source writes and cloud/database operations are represented only by explicit
fixture responses. This suite verifies UI response to events; the real middleware and
transport need their own smoke checks.

Reference PNGs are tied to their named browser project and OS. Compare on the same
platform, inspect every diff, and only update baselines as an explicit reviewed action:
`npm --workspace framework-studio run test:browser -- --update-snapshots`.
Do not update references to silence a regression. Keyboard, settled-route/dialog axe,
responsive geometry, editor identity, route revisits and visual checks supplement one
another. The [browser regression guide](../../framework-studio/test/browser/README.md)
documents the executable acceptance matrix and its limits; report remaining unverified
states separately. The styling contract Node test rejects new production CSS owners
and retired feature stylesheet imports.
