import { useState } from "react";
import { API_ROUTE } from "@repo/api-contract";

import Button from "#/components/Button";
import { frameworkHttpApiFetch } from "#/lib/auth";

export default function WorkflowsPanel() {
  const [starting, setStarting] = useState(false);
  const [status, setStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  async function handleStart() {
    setStarting(true);
    setStatus(null);

    try {
      const response = await frameworkHttpApiFetch(
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
      setStarting(false);
    }
  }

  return (
    <section className="card mt-4">
      <h2 className="text-sm font-semibold">Workflows</h2>
      <p className="mt-1.5 text-sm text-muted">
        Validates the payload in an event Lambda, then runs the container task
        and waits for it to stop. The one graph this repository actually
        declares.
      </p>
      <div className="mt-4">
        <Button
          text={starting ? "Starting..." : "Start workflow"}
          onClick={handleStart}
          disabled={starting}
        />
      </div>

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
