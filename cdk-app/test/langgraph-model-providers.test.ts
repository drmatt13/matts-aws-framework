import assert from "node:assert/strict";
import test from "node:test";
import { resources } from "../../framework-config/resources";
import {
  DEFAULT_MODEL_PROVIDER,
  MODEL_PROVIDERS,
} from "../ecs_containers/services/langgraph/src/providers/catalog";

// The service switches over MODEL_PROVIDERS with no default branch; the
// deployment input declares the same choices. A value accepted by one and
// unknown to the other would deploy cleanly and fail at container startup.
test("the LangGraph provider catalog and its deployment input agree", () => {
  const input = resources.langgraph.modelProvider as unknown as {
    readonly values?: readonly string[];
    readonly default?: string;
  };
  assert.deepEqual([...(input.values ?? [])].sort(), [...MODEL_PROVIDERS].sort());
  assert.equal(input.default, DEFAULT_MODEL_PROVIDER);
});
