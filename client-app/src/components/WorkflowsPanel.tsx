import { useState } from "react";
import { ImageIcon } from "lucide-react";
import { API_ROUTE } from "@repo/api-contract";

import Button from "#/components/Button";
import { FrameworkHttpApiFetch } from "#/lib/auth";

/**
 * The workflow shelf: one row per graph, each with room for its diagram.
 *
 * Four of these are placeholders on purpose. A Step Functions graph is far
 * easier to understand from a picture than from a page of declarations, and the
 * pictures are drawn by hand — so the slots exist first and the diagrams arrive
 * into them. The section names the directory they belong in, which is the whole
 * instruction for adding one.
 *
 * The thumbnails are deliberately inert for now: displaying a diagram, and
 * opening it full screen, is the next piece of work on this panel.
 *
 * Like ProjectsPanel, this owns its own failure state: a refused start should
 * degrade to a line of text rather than take the page down.
 */

/** Where a diagram goes. Served from client-app/public, so the path is public. */
const DIAGRAM_DIRECTORY = "/workflow-diagrams";

interface WorkflowEntry {
  /** Matches the diagram's filename, and the workflow id where there is one. */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /**
   * Whether this row can actually start something.
   *
   * Only the invocation test is a declared workflow today; the rest are slots
   * waiting for a graph, and a button that pretended otherwise would be a
   * button that always fails.
   */
  readonly startable?: boolean;
}

const WORKFLOWS: readonly WorkflowEntry[] = [
  {
    id: "invocation-test-workflow",
    name: "Invocation test",
    description:
      "Validates the payload in an event Lambda, then runs the container task and waits for it to stop. The one graph this repository actually declares.",
    startable: true,
  },
  {
    id: "order-approval",
    name: "Order approval",
    description:
      "Placeholder. Reads an order, asks a human through a queue, and suspends until someone answers — the callback pattern rather than a polling loop.",
  },
  {
    id: "document-pipeline",
    name: "Document pipeline",
    description:
      "Placeholder. Fans out over pages concurrently, then lets a container report its own parsed result instead of an exit code.",
  },
  {
    id: "nightly-reconciliation",
    name: "Nightly reconciliation",
    description:
      "Placeholder. Reads yesterday's records from DynamoDB, retries the flaky step under a named error, and writes a summary back.",
  },
  {
    id: "partner-webhook",
    name: "Partner webhook",
    description:
      "Placeholder. Calls a partner API through a bound EventBridge Connection and publishes what came back onto the event bus.",
  },
];

export default function WorkflowsPanel() {
  const [starting, setStarting] = useState<string | null>(null);
  const [status, setStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  async function handleStart(id: string) {
    setStarting(id);
    setStatus(null);

    try {
      const response = await FrameworkHttpApiFetch(
        API_ROUTE["/test/start-workflow"],
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "Hello from the client app!" }),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        throw new Error(
          typeof body?.error === "string"
            ? body.error
            : `Request failed with status ${response.status}.`,
        );
      }

      // A 202 is an acknowledgement. The execution is still running when this
      // resolves; its outcome is read from the runner or from the console.
      setStatus({ type: "success", message: "Workflow started." });
    } catch (error) {
      setStatus({
        type: "error",
        message:
          error instanceof Error ? error.message : "Unable to start workflow.",
      });
    } finally {
      setStarting(null);
    }
  }

  return (
    <section className="card mt-4">
      <h2 className="text-sm font-semibold">Workflows</h2>
      <p className="mt-1.5 text-sm text-muted">
        Reference graphs, each with a slot for its Step Functions diagram. Drop a
        PNG into{" "}
        <code className="rounded bg-ink/5 px-1.5 py-0.5 font-mono text-xs">
          client-app/public{DIAGRAM_DIRECTORY}/
        </code>{" "}
        named after the workflow to fill one in.
      </p>

      <ul className="mt-4 space-y-3">
        {WORKFLOWS.map((workflow) => (
          <li
            key={workflow.id}
            className="rounded-xl border border-line bg-canvas/50 p-4"
          >
            <div className="flex flex-wrap items-start gap-4">
              {/* The thumbnail is the affordance: it is visibly empty until a
                  diagram exists, so the gap reads as "add one here". */}
              <div className="flex size-14 shrink-0 items-center justify-center rounded-lg border border-dashed border-line bg-ink/5">
                <ImageIcon className="size-5 text-muted/60" />
              </div>

              <div className="min-w-48 flex-1">
                <p className="text-sm font-medium">{workflow.name}</p>
                <p className="mt-0.5 text-sm text-muted">
                  {workflow.description}
                </p>
              </div>

              {workflow.startable && (
                <Button
                  text={starting === workflow.id ? "Starting..." : "Start"}
                  onClick={() => void handleStart(workflow.id)}
                  disabled={starting !== null}
                />
              )}
            </div>
          </li>
        ))}
      </ul>

      {status && (
        <p
          role={status.type === "error" ? "alert" : "status"}
          className={`alert mt-4 ${
            status.type === "error" ? "alert-bad" : "alert-ok"
          }`}
        >
          {status.message}
        </p>
      )}
    </section>
  );
}
