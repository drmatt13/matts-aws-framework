import { defineNetwork } from "@repo/framework/config";
export const studioTestVpc = defineNetwork({
  "id": "test", "cidr": "10.1.0.0/16", "zones": 2, "natGateway": true, "egressOnlyInternetGateway": true, "gatewayEndpoints": {
    "s3": true, "dynamodb": true
  }, "interfaceEndpoints": []
});
