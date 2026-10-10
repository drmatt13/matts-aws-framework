import type { TasksSection } from "../contracts";

export const invocationTestTasks = {
  "invocation-test-task": {
    deploy: "both",
    cloud: {
      cpu: 256,
      memoryMiB: 512,
      // A test fixture runs whether or not the network has a NAT gateway.
      subnet: "public",
    },
  },
} satisfies TasksSection;
