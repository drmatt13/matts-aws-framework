import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { StudioProvider } from "../../../src/studio";
import { Board } from "../../../src/views/Board";
import { Shell } from "../../../src/views/Shell";
import {
  InspectorDisclosure,
  InspectorSection,
  InspectorSwitch,
  FormGroup,
} from "../../../src/views/InspectorUI";
import { WorkbenchDialog } from "../../../src/views/WorkbenchUI";
import { TagRows } from "../../../src/views/Tags";
import { InterfaceEndpointPicker } from "../../../src/views/InterfaceEndpointPicker";
import { EnvironmentValueControl } from "../../../src/views/EnvironmentValueControl";
import { FieldRow } from "../../../src/views/FieldRow";
import { EnvironmentPills } from "../../../src/views/DeploymentBadge";
import {
  inspectorContextClasses,
  inspectorRelationListClasses,
  inspectorRelationRowClasses,
} from "../../../src/inspector-ui";
import { snapshot } from "../support/scenarios";
import { Button } from "../../../src/ui/Button";
import { IconButton } from "../../../src/ui/IconButton";
import { TextInput, Select, Textarea } from "../../../src/ui/FormControls";
import "./gallery.css";

function Controls() {
  const [checked, setChecked] = useState(false),
    [dialog, setDialog] = useState(false),
    [tags, setTags] = useState<Readonly<Record<string, string>>>({ Team: "Studio" });
  const [selected, setSelected] = useState<readonly string[]>(["s3"]),
    [secret, setSecret] = useState("fixture-only-secret");
  return (
    <main aria-label="Shared component gallery" className="browser-gallery">
      <h1>Studio controls</h1>
      <InspectorSection appearance="native" title="Actions">
        <div className="browser-gallery-actions">
          <Button variant="primary">Primary</Button>
          <Button variant="quiet">Quiet</Button>
          <Button>Neutral</Button>
          <Button variant="link">Link action</Button>
          <Button variant="primary" tone="danger">
            Danger
          </Button>
          <Button variant="primary" size="compact">
            Compact
          </Button>
          <Button variant="primary" disabled>
            Disabled
          </Button>
          <IconButton aria-label="Example icon action">+</IconButton>
        </div>
      </InspectorSection>
      <InspectorSection appearance="native" title="Native fields">
        <FormGroup title="Input geometry">
          <label htmlFor="gallery-text">Name</label>
          <TextInput id="gallery-text" defaultValue="Studio" />
          <label htmlFor="gallery-select">Choice</label>
          <Select id="gallery-select" defaultValue="one">
            <option value="one">One</option>
            <option value="two">Two</option>
          </Select>
          <label htmlFor="gallery-invalid">Invalid field</label>
          <TextInput
            id="gallery-invalid"
            aria-invalid="true"
            aria-describedby="gallery-error"
            defaultValue="Invalid"
          />
          <p id="gallery-error">Fixture validation error</p>
          <label htmlFor="gallery-notes">Notes</label>
          <Textarea id="gallery-notes" defaultValue="Long values remain readable." />
        </FormGroup>
      </InspectorSection>
      <InspectorSection appearance="native" title="Boolean">
        <InspectorSwitch label="Example setting" checked={checked} onChange={setChecked} />
      </InspectorSection>
      <InspectorDisclosure
        appearance="native"
        title="Supporting details"
        count={2}
        status="modified"
      >
        <p>Details retain their native keyboard behavior.</p>
      </InspectorDisclosure>
      <InspectorSection appearance="native" title="Tags">
        <TagRows value={tags} onChange={setTags} />
      </InspectorSection>
      <InspectorSection appearance="native" title="Endpoint picker">
        <InterfaceEndpointPicker
          id="gallery-endpoints"
          services={["s3", "dynamodb", "sqs"]}
          selected={selected}
          onChange={setSelected}
        />
      </InspectorSection>
      <InspectorSection appearance="native" title="Masked value">
        <EnvironmentValueControl
          name="FIXTURE_SECRET"
          sensitive
          disabled={false}
          value={secret}
          onChange={setSecret}
        />
      </InspectorSection>
      <Button variant="primary" onClick={() => setDialog(true)}>
        Open example dialog
      </Button>
      {dialog ? (
        <WorkbenchDialog
          title="Example dialog"
          onClose={() => setDialog(false)}
          footer={
            <Button variant="quiet" onClick={() => setDialog(false)}>
              Done
            </Button>
          }
        >
          <p>Native modal focus containment.</p>
          <label htmlFor="dialog-name">Dialog name</label>
          <TextInput id="dialog-name" />
        </WorkbenchDialog>
      ) : null}
    </main>
  );
}
function Gallery() {
  const [selected, select] = useState<string>();
  const response = snapshot(),
    view = new URLSearchParams(window.location.search).get("view");
  return (
    <StudioProvider response={response} selected={selected} select={select}>
      {view === "board" ? (
        <Shell>
          <Board />
        </Shell>
      ) : view === "containers" ? (
        <main aria-label="Inspector container cases" className="browser-gallery">
          <h1>Inspector containers</h1>
          {[299, 300, 301, 359, 360, 361, 380, 419, 420, 421].map((width) => (
            <section
              key={width}
              aria-label={`Inspector ${width}px`}
              className={inspectorContextClasses}
              data-inspector-context
              style={{ width }}
            >
              <InspectorSection embedded title={`Container ${width}px`}>
                <FieldRow
                  target={{ ref: "lambda:fixture-0" }}
                  fact={response.snapshot.models.dev.fields["lambda:fixture-0"]![0]!}
                  editability={{ kind: "literal", text: "256" }}
                />
                <ul className={inspectorRelationListClasses}>
                  <li className={inspectorRelationRowClasses()}>
                    <span>Relationship with a long_identifier_that_must_wrap_in_the_panel</span>
                    <EnvironmentPills
                      className="col-span-full"
                      availability={{ dev: true, prod: false }}
                    />
                  </li>
                </ul>
              </InspectorSection>
            </section>
          ))}
        </main>
      ) : (
        <Controls />
      )}
    </StudioProvider>
  );
}
const route = createRootRoute({ component: Gallery });
const router = createRouter({
  routeTree: route,
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
