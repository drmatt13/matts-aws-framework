# Inspector interaction system

Studio is a visual control room. Inspectors should answer what an item is, where it
runs, and what can be changed before asking the developer to read implementation detail.
The shared tokens and base controls live in `framework-studio/src/styles.css`.
`src/inspector.css` owns panel layout and aliases those tokens; the section primitives
live in `src/views/InspectorUI.tsx`. Board, Isometric and Database use the same inspector.

## Conventions

Deployment information follows the resource's actual configuration authority:

| Family | Deployment control |
| --- | --- |
| HTTP, WebSocket, authorizer, event and tool Lambdas; services, tasks, workflows, agents | Editable Deploy tokens and input conditions; review validates both environments |
| Tool with no authored override | Inherit follows consuming agents; explicit Deploy overrides it |
| API gateway, stack member, network component | Read-only deployment summary and ownership explanation with navigation to handlers, stack or VPC |
| Catalog input, secret or group | No Deployment section. Inputs/secrets show declaration pills in their header; groups show pills beside each entry. Sources, requirements and consumers explain delivery |
| Native/framework stack, managed database, VPC island | Explicit ownership explanation and navigation; no ineffective independent workload flag |
| CDK/client environment file and input/environment islands | No Deployment section; file status, mappings and entry navigation describe their purpose |
| Other grouping islands | Read-only deployment summary with navigation to entries |

Inferred ownership is text with owner links, never a disabled Deploy selector.
Native CDK construction remains source-owned. A catalog presence change must never be
presented as an AWS deployment switch. Event deployment changes omit optional native
hooks on the next deployment, and the source review calls out that effect.

| Element | Convention |
| --- | --- |
| Panel | 380–480 px on desktop; bounded split view on narrow screens |
| Scrolling | One content region, with close and draft actions outside it; a new selection starts at the top |
| Type | 20 px item titles, 14 px body, 13 px labels, 12 px captions; monospace for identifiers and source |
| Spacing | Shared 4, 8, 12, 16 and 20 px tokens; 20 px panel gutters |
| Controls | 32 px inputs/selects, actions and icon actions, 24 px supporting disclosures; shared On/Off switches for boolean settings, checkboxes for acknowledgements and multi-selection; 44 px control targets for touch |
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
At panel widths up to 420 px, fields stack their labels above controls, mapping actions wrap,
and primary dialog actions use the full row. Long labels and source references wrap;
selected options reserve their arrow space and truncate within the control.
Container queries apply the same behavior to a narrow inspector beside a wide map.
Long public-field types wrap in their metadata column, then stack beneath the field name
in the narrowest panels. Route tag ownership help belongs inside the Tags section;
explanatory copy never sits outside a section's gutters. Tag controls share the normal
field height, identify invalid keys/values, connect validation messages to their inputs,
and return focus to a remaining row or Add tag after deletion.
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

Workload **Implementation** shows the configured directory, artifact readiness and an
editor link. **Create missing starter files** stages a review; it does not immediately
write, start or deploy anything. Existing code stays intact. **Permissions** is always
visible, including on new workloads. **Add access** opens a searchable configured-resource
picker with existing service artwork; selecting a destination reveals only its supported
actions. Services and calls precede configuration inputs. Queue permissions omit bucket
scopes; bucket permissions start with a bounded object-key scope. Saved entries name the
destination and operation; exact supported removals and staged additions have Undo.
**Incoming access** separates other principals from the workload's own grants, including
callbacks and pull triggers whose IAM ownership differs from the graph arrow. Tasks,
workflows and agents offer **Add caller**; resource inspectors offer **Grant access**.
These entry points share the same source draft and reviewed writer. Workflow-owned
access remains defined by its steps. Call bindings show the runtime helper to use in
the handler; generated descriptor keys are not configuration instructions.

The picker supports search, arrow keys, Home/End and Escape. Escape returns focus to
the opening control. Unavailable resources retain their reason; duplicate grants compare
the exact method and object scope. Internal AWS graph state does not rename an IAM grant.
Native method expressions belong under Configuration, while connection titles name the
operation and resource. **Remove workload** is a separate supporting disclosure. Source removal
reviews dependencies and an implementation archive, with an explicit explanation that
deployed resources and their costs require a separate operation.

Workload, route and catalog inspectors begin with identity, source access and a compact **Tags** disclosure.
Workloads, routes and infrastructure then show the shared **Deployment** section (`src/views/Deployment.tsx`);
catalog inputs, secrets and groups proceed directly to their description and input settings.
Tags show their effective count without opening the editor, and retain **Modified** or
**Needs attention** on the collapsed heading while a draft exists. Supporting disclosure
headings use a 32px target with 8px vertical padding on each side and the shared panel gutter;
expanded forms keep their normal spacing.
Generated fixtures and local services keep their deployment summary immediately after identity.
Development always
precedes Production; both cards remain visible when disabled. Configurable workloads
and their routes expose the same **Deploy** selector beneath the cards. A route edits
its target's declaration. The cards immediately preview a staged scope, and restoring
inheritance restores the default preview. Role-specific choices come from the framework's lane previews, including AWS execution
for WebSocket handlers during development. Conditional Deploy selects a non-secret input
and compares one literal value in a grouped, full-width form. The input's catalog name
and environment variable appear separately so neither crowds the selector; helpers and
validation remain associated with their controls. Saved settings and review show each
environment's outcome. API gateway headers reuse the catalog's framed Framework managed badge.
For event Lambdas, Development shows AWS execution unless local replay is enabled;
then it shows AWS capture first, followed by replay on the developer's machine.
This summary follows the staged replay setting and always describes the development graph.
Infrastructure catalog cards say Available/Unavailable to describe declaration availability rather
than deployed health. Stack members link to their parent; tools link to their consuming
agents and retain an editable override; framework-managed resources explain their inferred availability.
Infrastructure does not get unsupported deployment overrides. Local services and network fixtures
use the same cards and identify Compose or the production VPC as their configuration source.
VPC island inspectors configure only the selected network and list its entries. Their
deployment summary uses whether production builds the VPC; local workloads never enable
a development VPC. Global
Lambda defaults belong to Serverless compute (and the related API/tool defaults to their
family inspectors), container defaults remain under APIs, and connection pool defaults
appear in Application PostgreSQL's Connection pool defaults. These defaults apply across VPCs; they are
never scoped by which network is selected. Select an individual entry to change its
deployment scope. Client mapping Dev/Prod pills
continue to control file generation rather than workload deployment.

The managed application database has a dedicated inspector shared by the RDS resource and
local Postgres node. Identity leads into Development/Production implementations, the required
VPC home and connection paths. Group production capacity, availability, connections and
maintenance into disclosures, followed by caller pool defaults, deployment overrides and
supporting ownership details. Explain independent data and shared schema without implying
local replication or live health. Placement uses a separate coordinated source review for
the database and its consumers, with no public or unplaced option. Existing RDS moves need
migration/cutover planning and separate deployment; routine policy toggles never perform it.

For compute, a compact description preview follows Deployment and precedes memory,
timeout and other lifecycle settings. Numeric fields keep their
inherited default visible after an override and offer a direct way to restore it.
Default, reset and collapsed provenance share one wrapping support row; expanding
provenance uses the full width below it.
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

## Presentation details

Every inspector follows these rules, so that generated content never repeats or crowds itself
(audited across all 135 map inspectors in both modes on 2026-10-28):

- Identity headers stack eyebrow, title, pills or badges, catalog reference and source lines
  with one rhythm: pills keep 4 px above and 8 px below; consecutive source lines share only
  their link's touch-target height. Catalog stacks show `resources.<key>` beneath their class
  name, as inputs and secrets do. **About this resource** follows the identity lines.
- One disclosure marker: section disclosures draw the lucide chevron; every other summary
  uses the same chevron at its own text size (a CSS mask in `inspector.css`), never the
  browser triangle or a +/− sign. Permission rows and the description's **Edit** summary
  carry their own affordance.
- Lists inside ruled sections draw rules only between rows, never at the list's ends, so a
  section never shows two lines together. This covers relation, permission, environment and
  bundle-member lists.
- **Connections** rows lead with the connection title and its pills; the other endpoint and
  its provenance form the supporting line, so long identifiers never break inside a narrow
  column. Workload access rows name the consumer's kind beside it.
- A connection heading follows the hover rule against repeating its From/To. Bundle rows
  omit a shared action, and an expanded member lists only the endpoint that differs.
- Local values state each fact once: the status line covers Empty and Not set, and an empty
  value select already reads **Use default · value**, so no help line repeats either.
- Input settings begin with their **Input behavior** group rather than a generic heading.
  Form-group legends sit inside their group, below its rule.
- Suggestion fields (`input[list]`) show the shared select chevron in its usual place.

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
