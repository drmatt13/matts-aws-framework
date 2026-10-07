import { useState } from "react";
import { API_ROUTE } from "@repo/api-contract";

import Button from "#/components/Button";
import { frameworkHttpApiFetch } from "#/lib/auth";

async function responseError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;

  return typeof body?.error === "string"
    ? body.error
    : `Request failed with status ${response.status}.`;
}

export default function InvocationTestPanel() {
  const [isRunningTask, setIsRunningTask] = useState(false);
  const [invocationStatus, setInvocationStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  async function handleRunTask() {
    setIsRunningTask(true);
    setInvocationStatus(null);

    try {
      const response = await frameworkHttpApiFetch(
        API_ROUTE["/test/run-task"],
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "Hello from the client app!" }),
        },
      );
      if (!response.ok) throw new Error(await responseError(response));

      // A 202 is an acknowledgement, not a result. The container is still
      // running when this resolves, and its outcome is read from its logs.
      setInvocationStatus({
        type: "success",
        message: "Task submitted.",
      });
    } catch (error) {
      setInvocationStatus({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to run task.",
      });
    } finally {
      setIsRunningTask(false);
    }
  }

  return (
    <section className="card mt-4">
      <h2 className="text-sm font-semibold">Tasks</h2>
      <p className="mt-1.5 text-sm text-muted">
        Submits the declared container task directly, without a workflow around
        it.
      </p>
      <div className="mt-4">
        <Button
          text={isRunningTask ? "Running task..." : "Run test task"}
          onClick={handleRunTask}
          disabled={isRunningTask}
        />
      </div>
      {invocationStatus && (
        <p
          role={invocationStatus.type === "error" ? "alert" : "status"}
          className={`alert mt-4 ${
            invocationStatus.type === "error" ? "alert-bad" : "alert-ok"
          }`}
        >
          {invocationStatus.message}
        </p>
      )}
    </section>
  );
}
