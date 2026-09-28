/**
 * Runs the framework's fixture workflows through the local invocation runner
 * and fails unless each one succeeds.
 *
 * Needs the development stack: a dev deployment exported to .framework/local and
 * `npm run dev` running. Starts executions headlessly, as the runner allows a
 * declared caller to (FRAMEWORK.md, "Invocation smoke checks").
 */
import { randomUUID } from "node:crypto";
import { readAuthoredInputs } from "@repo/framework/config/source";

const SMOKES = [
  {
    target: "workflow:invocation-test-workflow",
    caller: "lambda:test-start-workflow",
    input: { message: "workflows:smoke", taskId: randomUUID(), invokedBy: "workflows:smoke" },
  },
  {
    target: "workflow:capability-check",
    caller: "lambda:test-capability-check",
    input: { runId: randomUUID(), values: [1, 2, 3] },
  },
];

const TIMEOUT_MS = 10 * 60 * 1000;

interface Execution {
  readonly status: string;
  readonly error?: { readonly name: string; readonly cause?: string };
  readonly history: readonly { readonly state: string; readonly type: string; readonly detail?: string }[];
}

async function main(): Promise<void> {
  const port = readAuthoredInputs().LOCAL_INVOCATION_RUNNER_HOST_PORT;
  if (!port) throw new Error("LOCAL_INVOCATION_RUNNER_HOST_PORT is not set in cdk-app/.env.");
  const runner = `http://127.0.0.1:${port}`;
  let failed = false;

  for (const smoke of SMOKES) {
    const started = await fetch(`${runner}/workflows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(smoke),
    });
    const { executionId } = (await started.json().catch(() => ({}))) as { executionId?: string };
    if (!started.ok || !executionId) {
      console.error(`${smoke.target}: the runner refused it (HTTP ${started.status}).`);
      failed = true;
      continue;
    }

    const deadline = Date.now() + TIMEOUT_MS;
    let execution: Execution;
    do {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const response = await fetch(`${runner}/workflows/${encodeURIComponent(executionId)}`);
      execution = (await response.json()) as Execution;
    } while (execution.status === "running" && Date.now() < deadline);

    if (execution.status === "succeeded") {
      console.log(`${smoke.target}: succeeded (${executionId})`);
      continue;
    }
    failed = true;
    console.error(`${smoke.target}: ${execution.status} (${executionId})`, execution.error ?? "");
    for (const step of execution.history.slice(-8)) {
      console.error(`  ${step.state} ${step.type} ${step.detail ?? ""}`);
    }
  }
  if (failed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
