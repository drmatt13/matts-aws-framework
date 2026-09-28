import { completeCallback, taskCallback, TASK_CALLBACK_ENVIRONMENT } from "@repo/framework/runtime/callbacks";
import { randomUUID } from "node:crypto";

const input = JSON.parse(process.env.FRAMEWORK_TASK_INPUT ?? "{}") as {
  message?: string;
  taskId?: string;
  invokedBy?: string;
};

const taskId = input.taskId ?? randomUUID();

console.log(`Task ${taskId} started`);
console.log(`Waiting 10 seconds to simulate work...`);

await new Promise((resolve) => setTimeout(resolve, 10_000));

console.log(`Message: ${input.message ?? "none"}`);
console.log(`Task ID: ${taskId}`);
console.log(`Invoked by: ${input.invokedBy ?? "unknown"}`);
console.log("Task complete");

// Started with completion: "callback" (the capability-check workflow), the task
// reports its result; started to run to exit, it only exits.
if (process.env[TASK_CALLBACK_ENVIRONMENT]) {
  await completeCallback(taskCallback(), { taskId, message: input.message ?? null });
}
