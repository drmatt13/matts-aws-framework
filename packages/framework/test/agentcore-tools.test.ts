import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { IDENTITY_ARGUMENT } from "../src/protocol/agentcore";
import { authenticatedTool, tool, ToolAuthorizationError, ToolInputError } from "../src/runtime/tools";
import { startTestCognito } from "./support/cognito";

const contract = {
  description: "Echo a message.",
  request: z.object({ message: z.string().min(1) }),
  response: z.object({ message: z.string(), length: z.number().int() }),
} as const;

const lambdaContext = {} as never;

test("a tool validates its arguments and result, and never sees the reserved identity", async () => {
  let received: unknown;
  const handler = tool(contract, async (input) => {
    received = input;
    return { message: input.message, length: input.message.length };
  });

  assert.deepEqual(await handler({ message: "hi", [IDENTITY_ARGUMENT]: "anything" }, lambdaContext), {
    message: "hi",
    length: 2,
  });
  assert.deepEqual(received, { message: "hi" });

  await assert.rejects(handler({ message: "" }, lambdaContext), (error: unknown) => {
    assert.ok(error instanceof ToolInputError);
    assert.match(error.message, /message: /);
    return true;
  });
  await assert.rejects(handler("not an object", lambdaContext), ToolInputError);
});

test("a tool's own failures reach the model as one sanitized sentence", async () => {
  const errors: unknown[] = [];
  const log = console.error;
  console.error = (...values: unknown[]) => errors.push(values);
  try {
    const leaking = tool(contract, async () => {
      throw new Error("password=hunter2 rejected by db.internal");
    });
    await assert.rejects(leaking({ message: "x" }, lambdaContext), { message: "Tool execution failed." });

    const malformed = tool(contract, async () => ({ message: "x" }) as never);
    await assert.rejects(malformed({ message: "x" }, lambdaContext), { message: "Tool execution failed." });
  } finally {
    console.error = log;
  }
  assert.equal(errors.length, 2, "both failures are logged where the developer can see them");
});

test("authenticatedTool hands the handler a verified session and refuses a missing or forged token", async () => {
  const cognito = await startTestCognito();
  try {
    let sub: string | undefined;
    const handler = authenticatedTool(contract, async (input, session) => {
      sub = session.payload.sub;
      return { message: input.message, length: input.message.length };
    });

    const token = await cognito.idToken("user-a");
    await handler({ message: "hi", [IDENTITY_ARGUMENT]: token }, lambdaContext);
    assert.equal(sub, "user-a");

    await assert.rejects(handler({ message: "hi" }, lambdaContext), ToolAuthorizationError);
    // Every credential that is not a live ID token for this app client is refused.
    for (const refused of [
      await cognito.forgedIdToken("user-a"),
      await cognito.expiredIdToken("user-a"),
      await cognito.otherClientIdToken("user-a"),
      await cognito.idToken("user-a", { token_use: "access" }),
      "not-a-jwt",
    ]) {
      await assert.rejects(handler({ message: "hi", [IDENTITY_ARGUMENT]: refused }, lambdaContext), ToolAuthorizationError);
    }
  } finally {
    cognito.restore();
  }
});
