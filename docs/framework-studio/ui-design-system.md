# Studio UI design system

Studio keeps its graphite surfaces, environment colors, AWS artwork and isometric map.
The shared interaction rules live in `framework-studio/src/styles.css`; inspector and
dialog layouts live in `src/inspector.css`, and deployment layouts in
`src/views/deploy/deploy.css`. New surfaces should consume these rules before adding
component-specific styling. [Inspector conventions](inspector-design.md) describe the
information order and source-review workflow.

| Concern | Shared convention |
| --- | --- |
| Spacing | `--space-1` through `--space-8`: 4–32px in 4px steps; `--panel-padding`: 20px |
| Type | 14px body, 13px controls/labels, 12px supporting text; existing display and monospace families |
| Controls | 32px regular, 28px compact, 36px prominent; icon actions are square |
| Surfaces | Existing theme colors; 4px small, 6px regular, 8px surface radii |
| Selects | Native keyboard interaction; 14px chevron inset 12px with a 10px text gap |
| Actions | `.primary`, `.quiet`, `.button`, `.icon-button`, `.linkish`; destructive actions add `.danger` |
| Feedback | Stable outline focus, shared disabled and invalid states, reduced-motion support, native select arrows in forced colors |
| Density | 4px label-to-control, 8px related helpers/actions, 12–16px groups; avoid stacked default paragraph margins |

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

The October 21, 2026 pass completed `npm run verify` (including 536 Studio tests),
the additional entry-point connection-recovery regression, Studio TypeScript checking,
the production UI build, the knowledge-link check, and
`git diff --check`. A real Chrome pass covered 67 view/size combinations at 320, 420,
760, 1100 and 1440px, checked focus/reset/navigation behavior and forced-color selects,
and found no horizontal page/panel overflow or lost select adornments in those cases.
Separate mocked production plan/deletion checks covered 420, 700, 1000 and 1440px,
confirmation gating and dialog/table containment, with no deployment mutations or
browser runtime errors. The build still reports its existing main-chunk size warning;
live AWS operations and live database behavior were not part of this UI pass.
