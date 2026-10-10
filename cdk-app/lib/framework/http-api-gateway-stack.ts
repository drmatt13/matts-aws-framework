import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import type { ApplicationListener } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as logs from "aws-cdk-lib/aws-logs";
import {
  getDeclaredHttpMethods,
  getHttpRoutes,
  getPublicRoutePath,
  toTargetReference,
  validateFrameworkConfig,
  type FrameworkConfig,
  type HttpMethod,
  type HttpRouteDefinition,
  type LambdaTarget,
  type ServiceTarget,
} from "@repo/framework/config";
import type { IUserPool, IUserPoolClient } from "aws-cdk-lib/aws-cognito";
import { FrameworkTargetRegistry } from "./framework-target-registry";

/**
 * The fixed authentication interface this API is built against.
 *
 * A framework contract, so it lives with the framework rather than in
 * framework-config: the application decides *which* pool by passing one, and
 * `resources.cognito` is how its workloads read that same pool's attributes.
 * The two are different needs — the authorizer wants the construct, a workload
 * wants an id — and only the first one is fixed by the framework.
 */
export type CognitoResources = {
  readonly userPool: IUserPool;
  readonly userPoolClient: IUserPoolClient;
};

export interface HttpApiGatewayStackProps extends cdk.StackProps {
  config: FrameworkConfig;
  targets: FrameworkTargetRegistry;
  /**
   * The user pool this API authorizes against, supplied by the composition root
   * rather than forwarded through a handler stack: the API/router and the
   * handlers are separate consumers of one Cognito contract.
   */
  cognito: CognitoResources;
  frontendUrls: string[];
}

const HTTP_METHODS: Record<HttpMethod, apigwv2.HttpMethod> = {
  DELETE: apigwv2.HttpMethod.DELETE,
  GET: apigwv2.HttpMethod.GET,
  HEAD: apigwv2.HttpMethod.HEAD,
  OPTIONS: apigwv2.HttpMethod.OPTIONS,
  PATCH: apigwv2.HttpMethod.PATCH,
  POST: apigwv2.HttpMethod.POST,
  PUT: apigwv2.HttpMethod.PUT,
};

const CORS_METHODS: Record<HttpMethod, apigwv2.CorsHttpMethod> = {
  DELETE: apigwv2.CorsHttpMethod.DELETE,
  GET: apigwv2.CorsHttpMethod.GET,
  HEAD: apigwv2.CorsHttpMethod.HEAD,
  OPTIONS: apigwv2.CorsHttpMethod.OPTIONS,
  PATCH: apigwv2.CorsHttpMethod.PATCH,
  POST: apigwv2.CorsHttpMethod.POST,
  PUT: apigwv2.CorsHttpMethod.PUT,
};

function constructName(value: string): string {
  return value
    .replace(/^\$+/, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

function routeMethods(route: HttpRouteDefinition): apigwv2.HttpMethod[] {
  return route.methods === "*"
    ? [apigwv2.HttpMethod.ANY]
    : route.methods.map((method) => HTTP_METHODS[method]);
}

export class HttpApiGatewayStack extends cdk.Stack {
  public readonly apiDomainName: string;

  constructor(scope: Construct, id: string, props: HttpApiGatewayStackProps) {
    super(scope, id, props);
    validateFrameworkConfig(props.config);

    const accessLogGroup = new logs.LogGroup(this, "HttpApiAccessLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const api = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: `${this.stackName}-HttpApi`,
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: props.frontendUrls,
        // Derived from the manifest, not listed: the preflight surface stays
        // exactly as wide as the routes that exist.
        allowMethods: getDeclaredHttpMethods(props.config, "cloud").map(
          (method) => CORS_METHODS[method],
        ),
        allowHeaders: ["Content-Type", "Authorization"],
        allowCredentials: true,
      },
    });

    this.apiDomainName = `${api.apiId}.execute-api.${this.region}.${cdk.Aws.URL_SUFFIX}`;

    api.addStage("DefaultStage", {
      stageName: "$default",
      autoDeploy: true,
      accessLogSettings: {
        destination: new apigwv2.LogGroupLogDestination(accessLogGroup),
        format: apigw.AccessLogFormat.custom(
          JSON.stringify({
            requestId: "$context.requestId",
            routeKey: "$context.routeKey",
            status: "$context.status",
            responseLatency: "$context.responseLatency",
            integrationError: "$context.integrationErrorMessage",
            authorizerError: "$context.authorizer.error",
            sourceIp: "$context.identity.sourceIp",
          }),
        ),
      },
    });

    const userPool = props.cognito.userPool;
    const userPoolClient = props.cognito.userPoolClient;
    const userPoolAuthorizer = new authorizers.HttpUserPoolAuthorizer(
      "HttpUserPoolAuthorizer",
      userPool,
      {
        identitySource: ["$request.header.Authorization"],
        userPoolClients: [userPoolClient],
      },
    );

    const addRoutes = (
      route: HttpRouteDefinition,
      routePath: string,
      integration: apigwv2.HttpRouteIntegration,
    ) => {
      api.addRoutes({
        path: routePath,
        methods: routeMethods(route),
        integration,
        ...(route.auth === true ? { authorizer: userPoolAuthorizer } : {}),
      });
    };

    // One integration per target and mapping, reused by every route bound to
    // it. Construct ids stay derived from the target — never from the public
    // path — so renaming a route cannot replace an integration, and two routes
    // sharing a target cannot collide on an id.
    const integrationCache = new Map<string, apigwv2.HttpRouteIntegration>();
    const integrationFor = (
      key: string,
      create: (constructId: string) => apigwv2.HttpRouteIntegration,
    ): apigwv2.HttpRouteIntegration => {
      const cached = integrationCache.get(key);
      if (cached) return cached;
      const created = create(key);
      integrationCache.set(key, created);
      return created;
    };

    // One VPC link for every internal service, in the subnets the services use.
    let vpcLink: apigwv2.VpcLink | undefined;
    const vpcLinkFor = (listener: ApplicationListener): apigwv2.VpcLink => {
      vpcLink ??= new apigwv2.VpcLink(this, "ServicesVpcLink", {
        vpc: listener.loadBalancer.vpc!,
        // Beside the internal load balancers, in the framework network's
        // private subnets.
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      });
      return vpcLink;
    };

    // Routes whose target is disabled for the cloud scope are skipped here, so
    // a deploy toggle in framework.config.ts removes the resource and the route
    // that would have pointed at nothing.
    for (const [, route] of getHttpRoutes(props.config, "cloud")) {
      // The `-api` suffix is redundant in a CloudFormation id, and dropping it
      // is what the existing logical ids already do. Kept for that reason only.
      const idPrefix = constructName(route.target.replace(/-api$/, ""));

      if (route.type === "lambda") {
        const handler = props.targets.requireLambda(
          toTargetReference("lambda", route.target) as LambdaTarget,
        );
        addRoutes(
          route,
          route.path,
          integrationFor(
            `${idPrefix}Integration`,
            (constructId) =>
              new integrations.HttpLambdaIntegration(constructId, handler, {
                payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
              }),
          ),
        );
        continue;
      }

      const service = props.targets.requireService(
        toTargetReference("service", route.target) as ServiceTarget,
      );
      const serviceUrl = service.url.replace(/\/+$/, "");
      // An internal load balancer is reached over the VPC link; a public one,
      // which configuration allows only without `auth: true`, at its URL.
      const serviceIntegration = (
        constructId: string,
        parameterMapping?: apigwv2.ParameterMapping,
      ): apigwv2.HttpRouteIntegration =>
        service.listener
          ? new integrations.HttpAlbIntegration(constructId, service.listener, {
              vpcLink: vpcLinkFor(service.listener),
              ...(parameterMapping ? { parameterMapping } : {}),
            })
          : new integrations.HttpUrlIntegration(
              constructId,
              serviceUrl,
              parameterMapping ? { parameterMapping } : {},
            );

      if (route.path.endsWith("/*")) {
        const mountPath = getPublicRoutePath(route.path);
        addRoutes(
          route,
          mountPath,
          integrationFor(
            `${idPrefix}RootIntegration`,
            (constructId) =>
              serviceIntegration(
                constructId,
                new apigwv2.ParameterMapping().overwritePath(
                  apigwv2.MappingValue.custom("/"),
                ),
              ),
          ),
        );
        addRoutes(
          route,
          `${mountPath}/{proxy+}`,
          integrationFor(
            `${idPrefix}ProxyIntegration`,
            (constructId) =>
              serviceIntegration(
                constructId,
                new apigwv2.ParameterMapping().overwritePath(
                  apigwv2.MappingValue.custom("/${request.path.proxy}"),
                ),
              ),
          ),
        );
      } else {
        addRoutes(
          route,
          route.path,
          integrationFor(
            `${idPrefix}Integration`,
            (constructId) => serviceIntegration(constructId),
          ),
        );
      }
    }

    new cdk.CfnOutput(this, "HttpApiUrl", {
      value: api.apiEndpoint,
      exportName: `${this.stackName}:HttpApiUrl`,
    });
  }
}
