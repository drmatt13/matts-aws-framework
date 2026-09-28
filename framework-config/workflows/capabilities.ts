import {
  aws, dynamodb, eventbridge, expr, map, parallel, runTask, runWorkflow, sequence, sns, sqs,
  transform, wait, workflow,
} from "@repo/framework/config";
import type { WorkflowsSection } from "../contracts";
import { resources } from "../resources";

/** Bound in WorkflowFixturesStack, which fixes the parameter's name. */
export const readFixtureParameter = aws.operation<
  Record<string, never>,
  { readonly Parameter: { readonly Value: string } }
>("fixture-read-parameter", { service: "ssm", action: "getParameter" });

interface FixtureItem { readonly pk: string; readonly status: string }
interface FixtureKey { readonly pk: string }

/**
 * Exercises every workflow step that crosses between the local lane and AWS,
 * so a seam that breaks is found here rather than by an application.
 * Run with `npm run workflows:smoke`.
 */
export const capabilityWorkflows = {
  "capability-child": workflow<{ value: number }>(
    ({ input }) => sequence(wait({ seconds: 1 }), transform({ doubled: expr.multiply(input.value, 2) })),
    { deploy: "local-only", timeoutSeconds: 120 },
  ),
  "capability-check": workflow<{ runId: string; values: number[] }>(
    ({ input }) => {
      const fixtures = resources.workflowFixtures;
      const key = { pk: input.runId };
      return sequence(
        dynamodb.put<FixtureItem, FixtureKey>(fixtures.fixtureTable, { item: { pk: input.runId, status: "started" } }),
        dynamodb.get<FixtureItem, FixtureKey>(fixtures.fixtureTable, { key, consistentRead: true }),
        dynamodb.update<FixtureItem, FixtureKey>(fixtures.fixtureTable, { key, set: { status: "updated" } }),
        parallel({
          queue: sqs.send(fixtures.fixtureQueue, { runId: input.runId }),
          topic: sns.publish(fixtures.fixtureTopic, { runId: input.runId }),
          bus: eventbridge.put(fixtures.fixtureBus, { source: "framework.fixtures", detailType: "capability-check", detail: { runId: input.runId } }),
          parameter: aws.call(readFixtureParameter, {}),
        }),
        map(input.values, ({ item }) => runWorkflow<{ doubled: number }, { value: number }>("capability-child", { payload: { value: item } }), { maxConcurrency: 3 }),
        runTask<{ readonly message: string }>("invocation-test-task", { completion: "callback", timeoutSeconds: 300, payload: { message: "capability-check", taskId: input.runId } }),
        dynamodb.delete<FixtureItem, FixtureKey>(fixtures.fixtureTable, { key }),
      );
    },
    { deploy: "local-only", timeoutSeconds: 900 },
  ),
} satisfies WorkflowsSection;
