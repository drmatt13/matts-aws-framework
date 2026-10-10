import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as iam from "aws-cdk-lib/aws-iam";
import {
  getCloudTargets,
  getWebSocketAuthorizer,
  getWebSocketRoutes,
  toTargetReference,
  validateFrameworkConfig,
  type CloudMode,
  type FrameworkConfig,
  type LambdaTarget,
} from "@repo/framework/config";
import { FrameworkTargetRegistry } from "./framework-target-registry";

export interface WebSocketApiStackProps extends cdk.StackProps {
  config: FrameworkConfig;
  targets: FrameworkTargetRegistry;
  /**
   * Which CDK graph this is. The router carries it for the same reason the
   * handler stack does: the connection-management grants below are applied to
   * the handlers this deployment built, not to every one the config declares.
   */
  mode: CloudMode;
}

function constructName(routeKey: string): string {
  const normalized = routeKey.replace(/^\$+/, "");
  return normalized
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

export class WebSocketApiStack extends cdk.Stack {
  public readonly api: apigatewayv2.WebSocketApi;
  public readonly stage: apigatewayv2.WebSocketStage;
  public readonly apiId: string;
  public readonly stageName: string;

  constructor(scope: Construct, id: string, props: WebSocketApiStackProps) {
    super(scope, id, props);
    validateFrameworkConfig(props.config);

    this.api = new apigatewayv2.WebSocketApi(this, "MyWebSocketAPI", {
      routeSelectionExpression: "$request.body.action",
      // Dual-stack, so a handler inside the VPC, where only IPv6 leaves, can
      // still push to its connections through this API's own endpoint.
      ipAddressType: apigatewayv2.IpAddressType.DUAL_STACK,
    });
    this.apiId = this.api.apiId;

    this.stage = new apigatewayv2.WebSocketStage(this, "ProdStage", {
      webSocketApi: this.api,
      stageName: "prod",
      autoDeploy: true,
    });
    this.stageName = this.stage.stageName;

    // The authorizer declared on $connect in framework-config, attached exactly
    // when it is declared: the local WebSocket dev server enforces the same
    // declaration, so the two lanes cannot disagree about who may connect.
    //
    // The token is the identity source, so API Gateway refuses a handshake
    // that carries none without invoking the authorizer at all.
    const authorizerTarget = getWebSocketAuthorizer(props.config);
    const webSocketAuthorizer = authorizerTarget
      ? new authorizers.WebSocketLambdaAuthorizer(
          "WebSocketLambdaAuthorizer",
          props.targets.requireLambda(authorizerTarget),
          { identitySource: ["route.request.querystring.token"] },
        )
      : undefined;

    for (const [routeKey, target] of Object.entries(
      getWebSocketRoutes(props.config),
    )) {
      const idPrefix = constructName(routeKey);
      const route = this.api.addRoute(routeKey, {
        integration: new integrations.WebSocketLambdaIntegration(
          `${idPrefix}Integration`,
          props.targets.requireLambda(target),
        ),
        ...(routeKey === "$connect" && webSocketAuthorizer
          ? { authorizer: webSocketAuthorizer }
          : {}),
      });

      if (routeKey !== "$connect" && routeKey !== "$disconnect") {
        new apigatewayv2.CfnRouteResponse(this, `${idPrefix}RouteResponse`, {
          apiId: this.api.apiId,
          routeId: route.routeId,
          routeResponseKey: "$default",
        });
      }
    }

    this.grantConnectionManagement(props);

    new cdk.CfnOutput(this, "WebSocketAPIEndpoint", {
      value: `wss://${this.api.apiId}.execute-api.${this.region}.${cdk.Aws.URL_SUFFIX}/${this.stage.stageName}`,
      description: "The API Gateway endpoint for the WebSocket API",
    });
  }

  /**
   * Permits the routes that declared `cloud.manageConnections` to push to a
   * connection, scoped to this API and stage.
   *
   * The policy is created here, attached to the handler's existing role, rather
   * than granted from the handler stack: the API already depends on those
   * handlers through its integrations, so a grant in the other direction would
   * close the cycle. Attaching an explicit Policy to the role — instead of a
   * convenience grant, which would add to the role's own default policy and put
   * the resource back in the handler stack — is what keeps the dependency
   * pointing one way.
   */
  private grantConnectionManagement(props: WebSocketApiStackProps): void {
    for (const target of getCloudTargets(props.config, ["webSocket"], props.mode)) {
      if (!target.cloud.manageConnections) continue;

      const handler = props.targets.requireLambda(
        toTargetReference("lambda", target.id) as LambdaTarget,
      );
      if (!handler.role) {
        throw new Error(
          `Framework target "${target.reference}" declares cloud.manageConnections, but its function has no role to attach the policy to.`,
        );
      }

      new iam.Policy(this, `${constructName(target.id)}ManageConnectionsPolicy`, {
        roles: [handler.role],
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["execute-api:ManageConnections"],
            resources: [
              cdk.Stack.of(this).formatArn({
                service: "execute-api",
                resource: this.api.apiId,
                resourceName: `${this.stage.stageName}/*`,
              }),
            ],
          }),
        ],
      });
    }
  }
}
