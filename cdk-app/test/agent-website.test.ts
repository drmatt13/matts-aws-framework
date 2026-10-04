import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { FrontendWebsiteS3Stack } from "../lib/app/frontend-website-s3-stack";

const runtimeArn = "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/echo_agent-AbCdEf1234";

function website() {
  const app = new cdk.App();
  const stack = new FrontendWebsiteS3Stack(app, "Website", {
    env: { account: "111122223333", region: "us-east-1" },
    enableCloudFront: true,
  });
  stack.addApiOrigin("api.example.com");
  stack.addAgentOrigins("us-east-1", [
    { id: "echo-agent", path: "/chat/echo", runtimeArn },
    { id: "another-agent", path: "/api/review", runtimeArn: `${runtimeArn}-other` },
  ]);
  return Template.fromStack(stack);
}

test("exact declared agent paths reach AgentCore ahead of the HTTP API's /api/*", () => {
  const template = website();
  const distribution = Object.values(template.findResources("AWS::CloudFront::Distribution"))[0] as {
    Properties: { DistributionConfig: { CacheBehaviors: { PathPattern: string; TargetOriginId: string }[]; Origins: { Id: string; DomainName: string; CustomOriginConfig?: Record<string, unknown> }[] } };
  };
  const config = distribution.Properties.DistributionConfig;
  assert.deepEqual(config.CacheBehaviors.map((behavior) => behavior.PathPattern), ["/chat/echo", "/api/review", "/api/*"]);
  const origin = config.Origins.find((candidate) => candidate.Id === config.CacheBehaviors[0].TargetOriginId)!;
  assert.equal(origin.DomainName, "bedrock-agentcore.us-east-1.amazonaws.com");
  assert.equal(origin.CustomOriginConfig?.OriginProtocolPolicy, "https-only");
});

test("only what AgentCore needs reaches it: the token, the session header, the qualifier — never cookies", () => {
  const template = website();
  const distribution = Object.values(template.findResources("AWS::CloudFront::Distribution"))[0] as {
    Properties: { DistributionConfig: { CacheBehaviors: { PathPattern: string; OriginRequestPolicyId: unknown; CachePolicyId: string }[] } };
  };
  const agents = distribution.Properties.DistributionConfig.CacheBehaviors.find((behavior) => behavior.PathPattern === "/chat/echo")!;
  // The managed CachingDisabled policy: a user's turn is never served to anyone else.
  assert.equal(agents.CachePolicyId, "4135ea2d-6df8-44a3-9df3-4b5a84be39ad");
  const policies = template.findResources("AWS::CloudFront::OriginRequestPolicy");
  const [id, policy] = Object.entries(policies)[0] as [string, { Properties: { OriginRequestPolicyConfig: Record<string, any> } }];
  assert.deepEqual(agents.OriginRequestPolicyId, { Ref: id });
  const config = policy.Properties.OriginRequestPolicyConfig;
  // A route may be chosen under /api; even then its refresh cookie is never forwarded.
  assert.equal(config.CookiesConfig.CookieBehavior, "none");
  assert.equal(config.HeadersConfig.HeaderBehavior, "whitelist");
  assert.deepEqual([...config.HeadersConfig.Headers].sort(), [
    "Accept",
    "Authorization",
    "Content-Type",
    "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id",
  ]);
  assert.deepEqual(config.QueryStringsConfig, { QueryStringBehavior: "whitelist", QueryStrings: ["qualifier"] });
});

test("the agent route function sends a declared agent to its Runtime and refuses anything else", () => {
  const template = website();
  const functions = Object.values(template.findResources("AWS::CloudFront::Function")) as {
    Properties: { Name: string; FunctionCode: string };
  }[];
  const code = functions.find((candidate) => /agent/i.test(candidate.Properties.Name))!.Properties.FunctionCode;
  // Through JSON, because objects built in the function's own context have
  // that context's prototypes.
  const run = (uri: string, method = "POST") =>
    JSON.parse(
      JSON.stringify(runInNewContext(`${code}\nhandler(event);`, { event: { request: { uri, method, querystring: {} } } })),
    ) as {
      uri?: string;
      querystring?: unknown;
      statusCode?: number;
    };

  const routed = run("/chat/echo");
  assert.equal(routed.uri, `/runtimes/${encodeURIComponent(runtimeArn)}/invocations`);
  assert.deepEqual(routed.querystring, { qualifier: { value: "DEFAULT" } });
  assert.equal(run("/api/agents/echo-agent").statusCode, 404);
  assert.equal(run("/chat/echo/extra").statusCode, 404);
  assert.equal(run("/chat/echo/", "POST").statusCode, 404);
  assert.equal(run("/Chat/echo").statusCode, 404);
  assert.equal(run("/chat/echo", "GET").statusCode, 405);
  assert.equal(run("/api/review").uri, `/runtimes/${encodeURIComponent(`${runtimeArn}-other`)}/invocations`);
});
