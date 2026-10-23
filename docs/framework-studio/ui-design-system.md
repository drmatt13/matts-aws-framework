# Studio UI design system

Studio keeps its graphite surfaces, environment colors, AWS artwork and isometric map.
The shared interaction rules live in `framework-studio/src/styles.css`; inspector and
dialog layouts live in `src/inspector.css`, and deployment layouts in
`src/views/deploy/deploy.css`. New surfaces should consume these rules before adding
component-specific styling. [Inspector conventions](inspector-design.md) describe the
information order and source-review workflow.

| Concern | Shared convention |
| --- | --- |
| Spacing | `--space-1` through `--space-8`: 4–32px in 4px steps; workspace gutters: 16px; inspector gutters: 20px |
| Type | 14px body, 13px controls/labels, 12px supporting text; existing display and monospace families |
| Controls | 32px regular, 28px compact, 36px prominent; icon actions are square |
| Surfaces | Existing theme colors; 4px small, 6px regular, 8px surface radii |
| Selects | Native keyboard interaction; 14px chevron inset 12px with a 10px text gap |
| Actions | `.primary`, `.quiet`, `.button`, `.icon-button`, `.linkish`; destructive actions add `.danger` |
| Feedback | Stable outline focus, shared disabled and invalid states, reduced-motion support, native select arrows in forced colors |
| Density | 4px label-to-control, 8px related helpers/actions, 12–16px groups; avoid stacked default paragraph margins |

## Navigation and workspace rhythm

The application bar owns view navigation, the **Environment** selector, edit history and
configuration health. Health stays at the right edge across routes and exposes both
environments' verdicts to assistive technology. Database edits one shared source contract,
so it omits the graph selector and configuration undo/redo; selected-target database
operations keep their own explicit target controls.

Every route starts immediately below navigation with `.workspace-toolbar`. It owns
`--workspace-gutter` (16px), `--toolbar-padding` (12px vertically), `--toolbar-height`
(57px minimum including the rule), `--sheet` surface and `--rule` bottom border.
Controls are 32px tall. Content follows the same horizontal gutter. Additional rows
accommodate genuine controls, warnings or narrow widths; do not add a route-specific
heading spacer or an inset rule above the first toolbar. Keep shell and map responsive
rules in `styles.css`, not in inspector or feature stylesheets.

Board relationship toggles and Database workspace choices use the same restrained
selected treatment: wash surface, rule border, regular radius and readable foreground.
Keep Board's toolbar pinned during horizontal and vertical graph scrolling.
Group Board's trailing legend and **Add to application** action so they stay together
when the toolbar wraps. At phone widths the relation filters scroll horizontally instead
of taking several rows; keyboard focus scrolls the focused filter into view.
Board's creation action has a visible label and its chooser
uses theme tokens; the map retains its compact floating creation action.

Isometric search, tag filters and camera controls occupy a normal-flow toolbar outside
the measured canvas. Wrapping controls must reduce the canvas viewport rather than cover
resources. The scene remains dark in both themes; its toolbar follows the application
theme. Use the existing scene container for pointer coordinates, resize and camera fit.
The map footer gives resource/connection counts; tile counts and frame timing belong
to the existing diagnostics API, not normal application chrome.

Deploy's account toolbar uses the same geometry. Healthy machine checks collapse into
one named disclosure with versions/details on demand. Warnings, failures and remedies
remain visible. Refresh reports pending state and partial failures, keeps prior results
available and works when no profile is configured. Never communicate refresh failure
only through a disappearing notification.

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

Interaction regressions live in `navigation-polish.test.ts`, `isometric-ui.test.ts`,
`draft-ui.test.ts`, `startup-ui.test.ts`, and `deploy-ui.test.ts`. Browser checks should include desktop,
380px inspector panels and 320–420px windows, expanded disclosures, long identifiers,
creation and unsaved-change dialogs, forced colors, and both themes. Deployment review
and deletion can be exercised with mocked API responses while refusing all operation
requests. These checks establish UI behavior; applying source, deployment, live database
operations and infrastructure replacement retain their separate authorization boundaries.

For control changes, exercise the complete stage → review → back/discard lifecycle,
including a delayed review and stale source. Check the rendered disabled state and
keyboard focus as well as the draft transitions. Browser checks should report the
actual viewports and workflows exercised; unit fixtures alone establish neither layout
quality nor live AWS behavior. Build output and current checks belong in the engineering
handoff rather than permanent historical test counts here.
