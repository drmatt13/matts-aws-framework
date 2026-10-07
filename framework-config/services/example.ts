import type { ServicesSection } from "../contracts";
import { resources } from "../resources";

/**
 * A minimal Express service on ECS. Local-only until its deploy setting
 * changes; in AWS it sits behind an internal load balancer that the HTTP API
 * reaches over a VPC link, so `auth: true` is the only way in.
 */
export const exampleService = {
  "/example-service/*": {
    directory: "/ecs_containers/services/example-service",
    methods: "*",
    auth: true,
    port: 5000,
    healthCheckPath: "/health",
    deploy: "local-only",
    environment: {
      USER_POOL_ID: resources.cognito.userPool.userPoolId,
      USER_POOL_CLIENT_ID: resources.cognito.userPoolClient.userPoolClientId,
    },
    cloud: {
      constructId: "ExampleService",
      cpu: 256,
      memoryMiB: 512,
      desiredCount: 1,
      outputs: { url: { id: "ExampleServiceUrl" } },
    },
  },
} satisfies ServicesSection;
