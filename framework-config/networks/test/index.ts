import { defineNetwork } from "@repo/framework/config";

/** An independent blueprint; no infrastructure is built until a consumer uses it. */
export const studioTestVpc = defineNetwork({
  id: "test",
  tags: { area: "examples" },
  cidr: "10.1.0.0/16",
  zones: 2,
  natGateway: true,
  egressOnlyInternetGateway: true,
  gatewayEndpoints: { s3: true, dynamodb: true },
  interfaceEndpoints: ["account","execute-api","apprunner.requests","appconfigdata","autoscaling-plans","bedrock","bedrock-fips"],
});
