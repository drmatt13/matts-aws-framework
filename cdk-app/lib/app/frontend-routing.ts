import path from "node:path";
import * as cdk from "aws-cdk-lib";
import type * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

interface FrontendRoutingProps {
  routingStore: cloudfront.CfnKeyValueStore;
  apiDomainName: string;
  agents: readonly { readonly path: string; readonly runtimeArn: string }[];
}

/**
 * Populate destinations after the website, Cognito and backends exist.
 * The website's template contains no backend references in this mode, so
 * Cognito can use its generated hostname without creating a dependency cycle.
 * The API stack owns the entries; the website owns the store and distribution.
 * Keeping the entries in an existing stack lets CloudFormation remove them
 * before the store when switching back to a custom frontend hostname.
 */
export class FrontendRouting extends Construct {
  constructor(scope: Construct, id: string, props: FrontendRoutingProps) {
    super(scope, id);
    const logGroup = new logs.LogGroup(this, "RoutingHandlerLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const handler = new nodejs.NodejsFunction(this, "RoutingHandler", {
      entry: path.join(__dirname, "frontend-routing-handler.ts"),
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: cdk.Duration.minutes(2),
      logGroup,
      bundling: { externalModules: [], target: "node24" },
    });
    handler.addToRolePolicy(new iam.PolicyStatement({
      actions: ["cloudfront-keyvaluestore:DescribeKeyValueStore", "cloudfront-keyvaluestore:ListKeys", "cloudfront-keyvaluestore:UpdateKeys"],
      resources: [props.routingStore.attrArn],
    }));
    const provider = new cr.Provider(this, "RoutingProvider", { onEventHandler: handler });
    const entries = new cdk.CustomResource(this, "RoutingEntries", {
      serviceToken: provider.serviceToken,
      resourceType: "Custom::FrontendRouting",
      properties: {
        StoreArn: props.routingStore.attrArn,
        Entries: [
          { Key: "http-api", Value: props.apiDomainName },
          ...props.agents.map(({ path: route, runtimeArn }) => ({ Key: `agent:${route}`, Value: runtimeArn })),
        ],
      },
    });
    // Publish only after the API, authorizers, integrations, routes and stage
    // in this stack are ready, including on initial creation.
    for (const child of cdk.Stack.of(this).node.findAll()) {
      if (child instanceof cdk.CfnResource && child.cfnResourceType.startsWith("AWS::ApiGatewayV2::")) {
        entries.node.addDependency(child);
      }
    }
  }
}
