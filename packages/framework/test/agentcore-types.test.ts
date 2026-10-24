import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { agent } from "../src/runtime/agentcore";
import type { ToolTargetDefinition } from "../src/config/index";

export const toolDeploy: ToolTargetDefinition = {
  deploy: "both",
};
export const invalidToolDeploy: ToolTargetDefinition = {
  // @ts-expect-error Deployment accepts framework tokens or a declared input condition.
  deploy: "sometimes",
};

/**
 * Compile-time assertions about how an agent is written: `npm run typecheck`
 * is the test, and the runtime body only proves the module loads.
 */

const request = z.object({ message: z.string() });
const event = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"), text: z.string() }),
  z.object({ type: z.literal("done") }),
]);
const response = z.object({ status: z.enum(["ok", "failed"]) });

// A streaming agent's yields are typed by its event contract, literals included.
export const streaming = agent("echo-agent", { request, event }).stream(async function* (input) {
  yield { type: "status", text: input.message };
  yield { type: "done" };
});

export const wrongEvent = agent("echo-agent", { request, event }).stream(
  // @ts-expect-error An event the contract does not declare.
  async function* () {
    yield { type: "unknown" };
  },
);

// A JSON agent returns its response contract.
export const answering = agent("echo-agent", { request, response }).respond(async () => ({ status: "ok" }));

// @ts-expect-error A response the contract refuses.
export const wrongAnswer = agent("echo-agent", { request, response }).respond(async () => ({ status: "maybe" }));

// @ts-expect-error A JSON agent does not stream.
export const wrongShape = agent("echo-agent", { request, response }).stream;

test("agent definitions type-check as written", () => {
  assert.equal(streaming.kind, "framework-agent");
  assert.equal(answering.kind, "framework-agent");
});
