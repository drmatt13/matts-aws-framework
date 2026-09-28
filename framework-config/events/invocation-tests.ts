import type { EventsSection } from "../contracts";

/**
 * The workflow activity for the invocation smoke test.
 *
 * Declared here rather than under a handler section of its own: Step Functions
 * is one more native invoker of an ordinary event Lambda. `events` has no
 * `deploy` toggle by design — its invocation wiring is owned by whatever
 * constructs the trigger, which for this handler is the state machine.
 *
 * No `localReplay`: a capture-and-return path cannot substitute for the
 * synchronous result the next state reads.
 */
export const invocationTestEvents = {
  "invocation-test-step": {
    timeoutSeconds: 10,
  },
} satisfies EventsSection;
