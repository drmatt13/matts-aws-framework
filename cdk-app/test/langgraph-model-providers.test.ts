import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { findRepositoryRoot, resolveAgentSourcePath } from "@repo/framework/config/source";
import framework from "../../framework.config";
import { models } from "../../framework-config/models";
import { resources } from "../../framework-config/resources";
import {
  DEFAULT_MODEL_PROVIDER,
  MODEL_PROVIDERS,
} from "../../packages/models/src/catalog";

// The agent switches over MODEL_PROVIDERS with no default branch; the
// deployment input declares the same choices. A value accepted by one and
// unknown to the other would deploy cleanly and fail on the agent's first turn.
test("the LangGraph provider catalog and its deployment input agree", () => {
  const input = resources.langgraph.modelProvider as unknown as {
    readonly values?: readonly string[];
    readonly default?: string;
  };
  assert.deepEqual([...(input.values ?? [])].sort(), [...MODEL_PROVIDERS].sort());
  assert.equal(input.default, DEFAULT_MODEL_PROVIDER);
});

// Locally the model is called with the developer's AWS profile, so an agent
// that forgot the shared declaration works on a laptop and is refused on its
// deployed Runtime's first turn. Depending on the package is the promise to
// declare what it needs.
test("every agent that depends on @repo/models declares what its providers need", () => {
  const root = findRepositoryRoot(__dirname);
  for (const [id, agent] of Object.entries(framework.agents ?? {})) {
    const directory = resolveAgentSourcePath(framework, id, { repositoryRoot: root });
    const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")) as {
      readonly dependencies?: Readonly<Record<string, string>>;
    };
    if (!manifest.dependencies?.["@repo/models"]) continue;

    const where = `agents["${id}"] depends on @repo/models`;
    const fix = "Spread framework-config/models.ts into its declaration.";
    for (const name of Object.keys(models.environment)) {
      assert.ok(name in (agent.environment ?? {}), `${where} but its environment has no ${name}. ${fix}`);
    }
    for (const statement of models.access) {
      assert.ok(
        agent.cloud?.access?.some((declared) => isDeepStrictEqual(declared, statement)),
        `${where} but its cloud.access lacks ${statement.actions.join(", ")}. ${fix}`,
      );
    }
    for (const requirement of models.requirements) {
      assert.ok(
        agent.cloud?.requirements?.some((declared) => declared === requirement),
        `${where} but its cloud.requirements lack "${requirement.message}" ${fix}`,
      );
    }
  }
});
