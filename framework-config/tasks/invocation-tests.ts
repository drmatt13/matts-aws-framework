import { applicationVpc } from "../networks/application";
import type { TasksSection } from "../contracts";

export const invocationTestTasks = {
  "invocation-test-task": {
    deploy: "both",
    cloud: {
      vpc: applicationVpc,
      cpu: 256,
      memoryMiB: 512,
    },
  },
} satisfies TasksSection;
