import {
  attempt,
  fail,
  invokeLambda,
  runTask,
  sequence,
  succeed,
  workflow,
} from "@repo/framework/config";
import type { WorkflowsSection } from "../contracts";
import type {
  InvocationTestStepEvent,
  InvocationTestStepResult,
} from "../../cdk-app/lambda_functions/event_functions/invocation-test-step";

/**
 * The framework's end-to-end workflow fixture: validate, then run a container
 * and wait for it.
 *
 * The graph lives here and nowhere else — a workflow has no source directory,
 * and its steps are targets this same config declares. It derives its own
 * outgoing permissions from the two steps below, which is why the starter
 * Lambda needs no grant on either of them.
 *
 * Written as control flow rather than as states: there is no `startAt`, no
 * `next`, and no reference path. The framework generates the state names, the
 * transitions and the expressions that carry data between steps.
 */
export const invocationTestWorkflows = {
  "invocation-test-workflow": workflow<InvocationTestStepEvent>(
    ({ input }) => {
      const validated = invokeLambda<
        InvocationTestStepResult,
        InvocationTestStepEvent
      >("invocation-test-step", { payload: input });

      return sequence(
        validated,

        attempt(
          runTask("invocation-test-task", {
            payload: validated.output,
            timeoutSeconds: 600,
          }),
          () =>
            fail({
              error: "InvocationTestTaskFailed",
              cause: "invocation-test-task did not exit zero.",
            }),
        ),

        succeed(validated.output),
      );
    },
    { deploy: "both", timeoutSeconds: 900 },
  ),
} satisfies WorkflowsSection;
