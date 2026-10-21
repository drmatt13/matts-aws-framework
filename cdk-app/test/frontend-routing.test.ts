import { applicationVpc as fixtureVpc } from "../../framework-config/networks/application";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { defineFrameworkConfig, defineResources } from "@repo/framework/config";
import { defaults } from "../../framework-config/defaults";
import { FrontendWebsiteS3Stack } from "../lib/app/frontend-website-s3-stack";
import { FrontendRouting } from "../lib/app/frontend-routing";
import { HttpApiGatewayStack } from "../lib/framework/http-api-gateway-stack";
import { FrameworkTargetRegistry } from "../lib/framework/framework-target-registry";
import { findCycle, resourceGraph } from "./support/template-graph";

const env = { account: "111122223333", region: "us-east-1" };
const apiDomain = "abc.execute-api.us-east-1.amazonaws.com";
const runtimeArn = "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/example-AbCdEf1234";
function dynamicWebsite() {
  const app = new cdk.App();
  const website = new FrontendWebsiteS3Stack(app, "Website", {
    env, enableCloudFront: true, useDynamicOrigins: true,
  });
  website.addApiOrigin(apiDomain);
  website.addAgentOrigins(env.region, [{ id: "example", path: "/chat/example", runtimeArn }]);
  return { app, website };
}
function functionCode(website: FrontendWebsiteS3Stack, name: string): string {
  const functions = Object.values(Template.fromStack(website).findResources("AWS::CloudFront::Function")) as any[];
  return functions.find(({ Properties }) => Properties.Name.endsWith(name)).Properties.FunctionCode;
}
async function run(code: string, uri: string, method: string, entries: Record<string, string>) {
  const origins: unknown[] = [];
  const request = { uri, method, querystring: { search: { value: "kept" } }, headers: { origin: { value: "https://frontend.cloudfront.net" } } };
  const cf = {
    kvs: () => ({ get: async (key: string) => {
      if (!Object.hasOwn(entries, key)) throw new Error("missing routing key");
      return entries[key];
    } }),
    updateRequestOrigin: (origin: unknown) => origins.push(origin),
  };
  const result = await runInNewContext(`${code.replace("import cf from 'cloudfront';", "")}\nhandler(event);`, { cf, event: { request } });
  return { result: JSON.parse(JSON.stringify(result)), origins: JSON.parse(JSON.stringify(origins)) };
}

test("the generated-domain proxy strips /api, uses the stored HTTPS backend, and preserves request data", async () => {
  const { website } = dynamicWebsite();
  const code = functionCode(website, "strip-api-prefix");
  const { result, origins } = await run(code, "/api/graphql", "POST", { "http-api": apiDomain });
  assert.equal(result.uri, "/graphql");
  assert.deepEqual(result.querystring, { search: { value: "kept" } });
  assert.deepEqual(result.headers, { origin: { value: "https://frontend.cloudfront.net" } });
  assert.deepEqual(origins, [{ domainName: apiDomain, hostHeader: apiDomain }]);
  const unavailable = await run(code, "/api/refresh", "POST", {});
  assert.equal(unavailable.result.statusCode, 503);
  assert.deepEqual(unavailable.origins, []);
});

test("generated-domain agent routing uses only exact declared paths and fails closed without its destination", async () => {
  const { website } = dynamicWebsite();
  const code = functionCode(website, "agent-route");
  const entries = { "agent:/chat/example": runtimeArn };
  assert.equal((await run(code, "/chat/example", "POST", entries)).result.uri,
    `/runtimes/${encodeURIComponent(runtimeArn)}/invocations`);
  assert.deepEqual((await run(code, "/chat/example", "POST", entries)).result.querystring, { qualifier: { value: "DEFAULT" } });
  assert.equal((await run(code, "/chat/example", "GET", entries)).result.statusCode, 405);
  assert.equal((await run(code, "/chat/example/extra", "POST", entries)).result.statusCode, 404);
  assert.equal((await run(code, "/chat/example", "POST", {})).result.statusCode, 503);
});

test("generated-domain routing creates an acyclic graph with exact Cognito URLs, JWT auth and scoped store writes", () => {
  const { app, website } = dynamicWebsite();
  const auth = new cdk.Stack(app, "Auth", { env });
  const userPool = new cognito.UserPool(auth, "Pool");
  const userPoolClient = userPool.addClient("Client", {
    oAuth: { callbackUrls: [`${website.cloudFrontUrl}/auth/callback`], logoutUrls: [website.cloudFrontUrl!] },
  });
  const backend = new cdk.Stack(app, "Backend", { env });
  const fn = new lambda.Function(backend, "Handler", {
    runtime: lambda.Runtime.NODEJS_24_X, handler: "index.handler", code: lambda.Code.fromInline("exports.handler = async () => ({statusCode: 200});"),
    environment: { TRUSTED_FRONTEND_ORIGINS: website.cloudFrontUrl! },
  });
  const targets = new FrameworkTargetRegistry();
  targets.lambda("example", fn);
  const api = new HttpApiGatewayStack(app, "Api", {
    env, targets, cognito: { userPool, userPoolClient }, frontendUrls: [website.cloudFrontUrl!],
    config: defineFrameworkConfig({ networks: [fixtureVpc],
      resources: defineResources({}), defaults,
      http: [{ "/example": { directory: "/lambda_functions/http_functions/example", methods: ["GET"], auth: true } }],
      webSocket: [], services: [], events: [], tasks: [], workflows: [],
    }),
  });
  new FrontendRouting(api, "FrontendRouting", {
    routingStore: website.routingStore!, apiDomainName: api.apiDomainName,
    agents: [{ path: "/chat/example", runtimeArn }],
  });
  const assembly = app.synth(); // Also refuses any cross-stack dependency cycle.
  for (const stack of assembly.stacks) assert.equal(findCycle(resourceGraph(stack.template)), undefined);
  const site = Template.fromStack(website);
  const text = JSON.stringify(site.toJSON());
  assert.ok(!text.includes(apiDomain) && !text.includes(runtimeArn));
  assert.doesNotMatch(text, /Fn::ImportValue/);
  site.hasResourceProperties("AWS::CloudFront::Distribution", { DistributionConfig: {
    CacheBehaviors: [
      { PathPattern: "/chat/example", CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" },
      { PathPattern: "/api/*", CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad", OriginRequestPolicyId: "b689b0a8-53d0-40ab-baf2-68738e2966ac" },
    ],
  } });
  site.hasResourceProperties("AWS::CloudFront::OriginRequestPolicy", { OriginRequestPolicyConfig: { CookiesConfig: { CookieBehavior: "none" } } });
  Template.fromStack(auth).hasResourceProperties("AWS::Cognito::UserPoolClient", {
    CallbackURLs: [auth.resolve(`${website.cloudFrontUrl}/auth/callback`)],
    LogoutURLs: [auth.resolve(website.cloudFrontUrl)],
  });
  Template.fromStack(api).hasResourceProperties("AWS::ApiGatewayV2::Route", { AuthorizationType: "JWT" });
  Template.fromStack(api).hasResourceProperties("Custom::FrontendRouting", { Entries: [
    { Key: "http-api", Value: api.resolve(api.apiDomainName) },
    { Key: "agent:/chat/example", Value: runtimeArn },
  ] });
  const statements = Object.values(Template.fromStack(api).findResources("AWS::IAM::Policy"))
    .flatMap((policy: any) => policy.Properties.PolicyDocument.Statement);
  const writes = statements.filter((statement: any) => JSON.stringify(statement.Action).includes("cloudfront-keyvaluestore"));
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].Resource, api.resolve(website.routingStore!.attrArn));
  assert.deepEqual(writes[0].Action, ["cloudfront-keyvaluestore:DescribeKeyValueStore", "cloudfront-keyvaluestore:ListKeys", "cloudfront-keyvaluestore:UpdateKeys"]);
});

test("switching frontend hostname modes preserves construct identities and the API export used by existing websites", () => {
  const build = (generated: boolean) => {
    const app = new cdk.App();
    const website = new FrontendWebsiteS3Stack(app, "Website", {
      env, enableCloudFront: true, useDynamicOrigins: generated,
      ...(generated ? {} : { frontendDomainName: "example.com", frontendCloudFrontCertificateArn: `arn:aws:acm:us-east-1:${env.account}:certificate/1234abcd` }),
    });
    const origin = generated ? website.cloudFrontUrl! : "https://example.com";
    const auth = new cdk.Stack(app, "Auth", { env });
    const userPool = new cognito.UserPool(auth, "Pool");
    const userPoolClient = userPool.addClient("Client", { oAuth: { callbackUrls: [`${origin}/auth/callback`], logoutUrls: [origin] } });
    const api = new HttpApiGatewayStack(app, "Api", {
      env, cognito: { userPool, userPoolClient }, frontendUrls: [origin], targets: new FrameworkTargetRegistry(),
      config: defineFrameworkConfig({ networks: [fixtureVpc], resources: defineResources({}), defaults, http: [], webSocket: [], services: [], events: [], tasks: [], workflows: [] }),
    });
    website.addApiOrigin(api.apiDomainName);
    if (website.routingStore) new FrontendRouting(api, "FrontendRouting", {
      routingStore: website.routingStore, apiDomainName: api.apiDomainName, agents: [],
    });
    const assembly = app.synth();
    return {
      assembly,
      templates: [website, auth, api].map((stack) => Template.fromStack(stack).toJSON()),
    };
  };
  const custom = build(false);
  const generated = build(true);
  const originalTypes = new Set(["AWS::CloudFront::Distribution", "AWS::S3::Bucket", "AWS::Cognito::UserPool", "AWS::Cognito::UserPoolClient", "AWS::ApiGatewayV2::Api"]);
  const identities = (template: any) => Object.entries(template.Resources).filter(([, resource]: any) => originalTypes.has(resource.Type)).map(([id]) => id);
  assert.deepEqual(generated.templates.map(identities), custom.templates.map(identities));
  const apiExport = (template: any) => Object.entries(template.Outputs).filter(([id]) => id.startsWith("ExportsOutputRefHttpApi"));
  assert.equal(apiExport(custom.templates[2]).length, 1);
  assert.deepEqual(apiExport(generated.templates[2]), apiExport(custom.templates[2]));
  const dependencies = (built: ReturnType<typeof build>, name: string) => built.assembly.stacks.find((stack) => stack.stackName === name)!.dependencies.map(({ id }) => id);
  assert.ok(dependencies(custom, "Website").includes("Api"));
  assert.ok(dependencies(generated, "Api").includes("Website"));
});
