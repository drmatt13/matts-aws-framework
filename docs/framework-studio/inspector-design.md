# Inspector interaction system

Studio is a visual control room. Inspectors should answer what an item is, where it
runs, and what can be changed before asking the developer to read implementation detail.
The shared system lives in `framework-studio/src/inspector.css`; the section primitives
live in `src/views/InspectorUI.tsx`. Board, Isometric and Database use the same inspector.

## Conventions

| Element | Convention |
| --- | --- |
| Panel | 380–480 px on desktop; bounded split view on narrow screens |
| Scrolling | One content region, with close and draft actions outside it; a new selection starts at the top |
| Type | 20 px item titles, 14 px body, 13 px labels, 12 px captions; monospace for identifiers and source |
| Spacing | Shared 4, 8, 12, 16 and 20 px tokens; 20 px panel gutters |
| Controls | 34 px inputs/selects, 32 px actions and icon actions, 24 px supporting disclosures; shared On/Off switches for boolean settings, checkboxes for acknowledgements and multi-selection; 44 px control targets for touch |
| Sections | `InspectorSection` for immediate controls; `InspectorDisclosure` for supporting information |
| Forms | Associated labels, inline units, visible error messages, semantic `FormGroup` boundaries |
| Color | Existing theme surfaces; teal/violet for environments, accept/refuse colors for validation |

Controls share horizontal padding and a single select-arrow treatment: a 14 px chevron
inset 12 px from the edge, with 10 px between text and icon. Native selects retain keyboard
behavior and return to the platform arrow in forced-colors mode. Focus uses an outline
without changing control geometry. Component styles should not reset shared control
padding, backgrounds or arrow placement.

Field dividers keep 12 px of vertical padding; Deployment instead uses an unruled 16 px
gap from its cards to its selector. Labels, controls and default notes share column tokens.
At widths up to 420 px, fields stack their labels above controls, mapping actions wrap,
and primary dialog actions use the full row. Long labels and source references wrap;
selected options reserve their arrow space and truncate within the control.
Boolean setting rows keep their label and right-aligned switch on the same line at all
widths, with room for long labels to wrap. `InspectorSwitch` in `InspectorUI.tsx` owns
the existing On/Off appearance, accessible name, checked state and native button keyboard
behavior. Workload/default, VPC, database, input, client mapping and creation controls
reuse it while retaining their existing draft, validation and disabled behavior.

VPC interface endpoints use `InterfaceEndpointPicker` in both the network inspector and
creation form. Selected endpoints remain visible as removable service chips. **Add services**
opens a searchable dropdown with AWS service/family artwork, friendly names, exact endpoint
IDs and a visible selection mark. Search and selection stay in place for choosing related
variants such as `ecr.api` and `ecr.dkr`; Escape closes only the picker and restores its
toggle's focus. Arrow keys move through results. The catalog comes from the framework's
CDK-derived list in each mode's snapshot; artwork is presentation metadata and never a
second service allowlist. S3 and DynamoDB gateway switches remain separate. Keep billing
help visible; the catalog does not verify regional service availability.

## Information order

Workload, route, catalog and local-service inspectors begin with identity, source access
and the shared **Deployment** section (`src/views/Deployment.tsx`). Development always
precedes Production; both cards remain visible when disabled. Configurable workloads
and their routes expose the same **Deploy** selector beneath the cards. A route edits
its target's declaration. The cards immediately preview a staged scope, and restoring
inheritance restores the default preview. WebSocket choices account for each graph's
own AWS API flag, including AWS execution in development.
For event Lambdas, Development shows AWS execution unless local replay is enabled;
then it shows AWS capture first, followed by replay on the developer's machine.
This summary follows the staged replay setting and always describes the development graph.
Catalog cards say Available/Unavailable to describe declaration availability rather
than deployed health. Stack members link to their parent; tools link to their consuming
agents; event functions and framework-managed resources explain their fixed availability.
These do not get unsupported deployment overrides. Local services and network fixtures
use the same cards and identify Compose or the production VPC as their configuration source.
VPC island inspectors configure only the selected network and list its entries. Global
Lambda defaults belong to Serverless compute (and the related API/tool defaults to their
family inspectors), container defaults remain under APIs, and connection pool defaults
appear beside Managed PostgreSQL controls. These defaults apply across VPCs; they are
never scoped by which network is selected. Select an individual entry to change its
deployment scope. Client mapping Dev/Prod pills
continue to control file generation rather than workload deployment.

For compute, a compact description preview follows Deployment and precedes memory,
timeout and other lifecycle settings. Numeric fields keep their
inherited default visible after an override and offer a direct way to restore it.
Routing, authentication and event controls follow.
Build configuration, placement, connections, environment bindings and
IAM remain available through explicit disclosures.

Resource titles use the useful short name, with the full catalog identity on a secondary
line. Operational flags remain visible; longer ownership and source explanations expand
on demand. Empty sections are omitted. Local values edit inline with a clear environment,
file destination and saved/default/empty state. Allowed values use a select; freeform values
use the shared environment value control. Secrets start masked. Revert and default actions
stage through the existing private environment-file review rather than navigating away.

Boolean setting help describes what the option does and stays the same when toggled. Keep related
controls in place and disable them when inapplicable (including input defaults and client
mapping options). Draft restrictions belong in existing status space; reserve that space
for both messages so wrapping on narrow panels cannot move the controls below it.

Descriptions show a two-line preview and open their editor deliberately. Source links
show a filename and line, retain the full path in their title and open the original
declaration. Field provenance expands beside its control rather than repeating long
inheritance expressions in every select option. Connection evidence and user-authored
descriptions remain separate. Connection endpoints include their type (for example,
API versus WebSocket) so identically named routes and handlers remain distinguishable.

## Workflows

Environment search and add actions share one toolbar. Mapping rows use the same control
sizes and action alignment as other forms. Client mappings begin with a searchable source
overview; expand a row to select a source type and its inputs. Keep symbolic previews and
availability in sync with the draft, and distinguish omitted fields from empty values.
Use the shared Dev/Prod pills on each row to toggle inclusion independently, and keep
renaming inline with duplicate-name validation and preservation of both source recipes.
The local environment switch follows the graph's navigation guard. Native selects retain
keyboard support with an inset arrow and reserved text space. Shared defaults reuse the ordinary field rows;
membership lists can expand separately from settings. Trigger setup retains its three
steps, brings each step into view and focuses the next relevant field. Back/cancel remain
secondary actions; the next/commit action sits at the end of the action row.

Review dialogs share panel typography and controls. Validation, pending changes and file
diffs have separate visual groups, with actions outside the scrolling body. Staging,
navigation guards, source conflicts, review/apply, undo/redo, masking and deployment
authorization continue through the existing services. UI refinement never writes a value
merely because a control or inspector was opened.

## Extending the system

Use the section primitives and shared tokens before adding a new panel-specific rule.
Scope form styling to the interaction surfaces; map graphics have their own visual model.
Keep primary controls visible and explanations discoverable. Do not add empty metadata
sections, nested scrolling regions, repeated source excerpts or long provenance strings
to routine control labels. Preserve meaningful notices and validation messages.

Check representative compute, stack/member, input/secret, environment-file, client mapping,
island, connection and trigger flows in the browser. Include staged edits, review, cancel,
selection changes and a narrow viewport. Browser checks complement the interaction suites
and `npm run verify`; they do not authorize or prove deployment behavior.
