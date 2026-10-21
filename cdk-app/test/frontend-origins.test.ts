import { applicationVpc as fixtureVpc } from "../../framework-config/networks/application";
import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { defineFrameworkConfig, defineResources } from "@repo/framework/config";
import { defaults } from "../../framework-config/defaults";
import { resolveDeploymentInputs, resolveFrontendSettings } from "../deployment";
import { FrontendWebsiteS3Stack } from "../lib/app/frontend-website-s3-stack";
import { HttpApiGatewayStack } from "../lib/framework/http-api-gateway-stack";
import { FrameworkTargetRegistry } from "../lib/framework/framework-target-registry";

const env = { account: "111122223333", region: "us-east-1" };
// Production unless a case says PROD_DEPLOYMENT=false, stated as CDK context.
function inputs(overrides: Record<string, string> = {}) {
  const { PROD_DEPLOYMENT = "true", ...rest } = overrides;
  return resolveDeploymentInputs({
    getContext: (key) => (key === "prodDeployment" ? PROD_DEPLOYMENT : undefined),
    env: {
      CDK_DEFAULT_ACCOUNT: env.account,
      CDK_DEFAULT_REGION: env.region,
      ...rest,
    },
  });
}

test("a generated CloudFront origin appears once in CORS and Cognito URLs", () => {
  const app = new cdk.App();
  const website = new FrontendWebsiteS3Stack(app, "Website", { env, enableCloudFront: true });
  const origin = website.cloudFrontUrl!;
  assert.ok(cdk.Token.isUnresolved(origin));
  const frontend = resolveFrontendSettings(inputs(), origin);
  assert.equal(frontend.useSameOriginApiProxy, true);
  assert.deepEqual(frontend.trustedFrontendUrls, [origin]);
  assert.deepEqual(frontend.cognitoFrontendUrls, [origin]);
  assert.deepEqual(frontend.authCallbackUrls, [`${origin}/auth/callback`]);

  const auth = new cdk.Stack(app, "Auth", { env });
  const userPool = new cognito.UserPool(auth, "Pool");
  const userPoolClient = userPool.addClient("Client");
  const api = new HttpApiGatewayStack(app, "Api", {
    env,
    config: defineFrameworkConfig({ networks: [fixtureVpc],
      resources: defineResources({}), defaults,
      http: [], webSocket: [], services: [], events: [], tasks: [], workflows: [],
    }),
    targets: new FrameworkTargetRegistry(),
    cognito: { userPool, userPoolClient },
    frontendUrls: frontend.trustedFrontendUrls,
  });
  Template.fromStack(api).hasResourceProperties("AWS::ApiGatewayV2::Api", {
    CorsConfiguration: {
      AllowOrigins: [api.resolve(origin)],
      AllowCredentials: true,
    },
  });
});

test("a literal CloudFront origin is normalized and deduplicated", () => {
  const frontend = resolveFrontendSettings(inputs(), "https://example.cloudfront.net/");
  assert.deepEqual(frontend.trustedFrontendUrls, ["https://example.cloudfront.net"]);
  assert.deepEqual(frontend.authCallbackUrls, ["https://example.cloudfront.net/auth/callback"]);
});

test("a custom frontend origin excludes the CloudFront token and local origins", () => {
  const cloudFrontOrigin = `https://${cdk.Token.asString({ Ref: "CloudFrontDomain" })}`;
  const frontend = resolveFrontendSettings(inputs({
    FRONTEND_URL: "https://example.com/",
    FRONTEND_CLOUDFRONT_CERTIFICATE_ARN: `arn:aws:acm:us-east-1:${env.account}:certificate/1234abcd`,
    LOCAL_DEV_URL: "http://192.168.1.10:3000",
  }), cloudFrontOrigin);
  assert.equal(frontend.useSameOriginApiProxy, true);
  assert.deepEqual(frontend.trustedFrontendUrls, ["https://example.com"]);
  assert.deepEqual(frontend.authCallbackUrls, ["https://example.com/auth/callback"]);
});

test("development deduplicates localhost and preserves a distinct LAN origin", () => {
  assert.equal(resolveFrontendSettings(inputs({ PROD_DEPLOYMENT: "false" })).useSameOriginApiProxy, false);
  assert.deepEqual(resolveFrontendSettings(inputs({ PROD_DEPLOYMENT: "false" })).trustedFrontendUrls,
    ["http://localhost:3000"]);
  const frontend = resolveFrontendSettings(inputs({
    PROD_DEPLOYMENT: "false", LOCAL_DEV_URL: "http://192.168.1.10:3000/",
  }));
  assert.deepEqual(frontend.trustedFrontendUrls, ["http://localhost:3000", "http://192.168.1.10:3000"]);
  assert.deepEqual(frontend.authCallbackUrls, ["http://localhost:3000/auth/callback"]);
});
