import assert from "node:assert/strict";
import test from "node:test";
import { cognitoIssuer } from "../src/runtime/cognito";

test("the issuer comes from AWS_REGION, or from the pool id where the runtime sets no region", () => {
  assert.equal(
    cognitoIssuer({ AWS_REGION: "eu-west-2", USER_POOL_ID: "eu-west-2_Abc" }),
    "https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_Abc",
  );
  // AgentCore Runtime does not document setting AWS_REGION; a pool id names its own region.
  assert.equal(cognitoIssuer({ USER_POOL_ID: "us-east-1_Abc" }), "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Abc");
  assert.equal(cognitoIssuer({ USER_POOL_ID: "not-a-pool-id" }), undefined);
  assert.equal(cognitoIssuer({}), undefined);
});
