import type { TasksSection } from "../contracts";

export const invocationTestTasks = {
  "invocation-test-task": {
    deploy: "both",
    cloud: {
      cpu: 256,
      memoryMiB: 512,
    },
  },
} satisfies TasksSection;
