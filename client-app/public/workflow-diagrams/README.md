# Workflow diagrams

Hand-drawn Step Functions diagrams, one per workflow, shown on the authenticated
home page. A graph is much easier to understand from a picture than from a page
of declarations, and these are the pictures.

Save each one as a PNG named after its workflow:

| File | Workflow |
| --- | --- |
| `invocation-test-workflow.png` | The declared invocation test: validate, then run the container task |
| `order-approval.png` | Placeholder — a queue request that suspends until a human answers |
| `document-pipeline.png` | Placeholder — concurrent fan-out, then a container reporting its own result |
| `nightly-reconciliation.png` | Placeholder — DynamoDB reads with a named retry, then a summary write |
| `partner-webhook.png` | Placeholder — an HTTPS call through a bound connection, then an event |

The panel currently renders an empty slot per workflow; displaying the diagram
in it, and opening it full screen on click, is still to be built. Add or rename
entries in `client-app/src/components/WorkflowsPanel.tsx`; the id in that list
is the filename.

Anything served from `client-app/public/` is public, so keep account ids, ARNs
and internal hostnames out of the images.
