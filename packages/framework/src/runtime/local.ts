import { randomUUID } from "node:crypto";
import type { LocalTaskDescriptor, LocalWorkflowDescriptor } from "./descriptor";

/**
 * The local half of the transport.
 *
 * Submissions go to the private runner on the project's Compose network, never
 * to the application's own HTTP API: adding `POST /workflows/:id/start` there
 * would bypass the declared route inventory and could collide with an authored
 * mount. The runner validates the caller-to-target edge itself, from the same
 * declared bindings the cloud grants come from, so a request body cannot choose
 * or override a binding.
 *
 * Like the AWS half, this acknowledges submission. It never holds a request
 * open for the lifetime of a container or a graph.
 */

/** What the runner is told, beyond the payload: who is calling, and about what. */
export interface LocalSubmission {
  readonly caller?: string;
  readonly input: unknown;
  readonly clientToken: string;
}

/**
 * Who the runner is told is calling.
 *
 * The identity belongs to the binding, not to the call site: the local
 * projection wrote this descriptor for one caller and knows which, so
 * `runTask(id, input)` — the two-argument form the README and the manifest
 * document — works here without every handler repeating its own name.
 *
 * An explicit `caller` option is still accepted, because descriptors generated
 * before the field existed carry none. It may agree with the descriptor; it may
 * not replace it. Letting a call site override the binding owner would turn an
 * option into a way to borrow another target's grants, and the runner's edge
 * check is the only thing standing between a submission and a launch.
 */
function resolveCaller(
  descriptor: { readonly caller?: string },
  supplied: string | undefined,
  where: string,
): string | undefined {
  if (supplied === undefined) return descriptor.caller;
  if (descriptor.caller !== undefined && descriptor.caller !== supplied) {
    throw new Error(
      `${where} was given caller "${supplied}", but its descriptor was issued to "${descriptor.caller}". A caller option may confirm the binding it was written for; it cannot reassign it.`,
    );
  }
  return supplied;
}

interface RunnerError {
  readonly error?: string;
}

async function submit<Result extends object>(
  endpoint: string,
  body: unknown,
  where: string,
): Promise<Result> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    // Said plainly rather than retried against AWS: the descriptor selected
    // this endpoint, and there is no other transport to fall back to.
    throw new Error(
      `${where} could not reach the local runner at ${endpoint}: ${error instanceof Error ? error.message : String(error)}. Is "docker compose up --build --watch" running?`,
    );
  }
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text.length > 0 ? (JSON.parse(text) as unknown) : {};
  } catch {
    throw new Error(
      `${where} received a non-JSON response from the local runner (HTTP ${response.status}): ${text.slice(0, 300)}`,
    );
  }
  if (!response.ok) {
    const message = (payload as RunnerError).error ?? `HTTP ${response.status}`;
    throw new Error(`${where} was rejected by the local runner: ${message}`);
  }
  return payload as Result;
}

export async function runLocalTask(
  descriptor: LocalTaskDescriptor,
  input: unknown,
  caller: string | undefined,
): Promise<{ readonly runId: string }> {
  const where = `runTask("${descriptor.target}")`;
  const result = await submit<{ runId?: string }>(
    `${descriptor.runnerUrl}/tasks`,
    {
      target: `task:${descriptor.target}`,
      caller: resolveCaller(descriptor, caller, where),
      input,
      clientToken: randomUUID(),
    } satisfies LocalSubmission & { target: string },
    where,
  );
  if (!result.runId) {
    throw new Error(
      `runTask("${descriptor.target}") was accepted by the local runner, which returned no runId.`,
    );
  }
  return { runId: result.runId };
}

export async function startLocalWorkflow(
  descriptor: LocalWorkflowDescriptor,
  input: unknown,
  caller: string | undefined,
): Promise<{ readonly executionId: string }> {
  const where = `startWorkflow("${descriptor.target}")`;
  const result = await submit<{ executionId?: string }>(
    `${descriptor.runnerUrl}/workflows`,
    {
      target: `workflow:${descriptor.target}`,
      caller: resolveCaller(descriptor, caller, where),
      input,
      clientToken: randomUUID(),
    } satisfies LocalSubmission & { target: string },
    where,
  );
  if (!result.executionId) {
    throw new Error(
      `startWorkflow("${descriptor.target}") was accepted by the local runner, which returned no executionId.`,
    );
  }
  return { executionId: result.executionId };
}
