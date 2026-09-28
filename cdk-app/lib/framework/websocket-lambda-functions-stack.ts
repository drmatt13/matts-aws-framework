import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import {
  getCloudTargets,
  type FrameworkConfig,
  type NormalizedTarget,
} from "@repo/framework/config";
import { FrameworkTargetRegistry } from "./framework-target-registry";
import { buildFrameworkLambdas, type CloudBuildContext } from "./framework-cloud";

export interface WebSocketLambdaFunctionsStackProps extends cdk.StackProps {
  readonly config: FrameworkConfig;
  /**
   * Which CDK graph this is.
   *
   * Deliberately narrow: a WebSocket handler is given the user pool and nothing
   * that would make it depend on the API its routes are integrated into.
   */
  readonly cloud: { readonly mode: "dev" | "prod" };
  /**
   * The targets to build, when the composition factory has already selected
   * and validated them. Omitted, the same selection is derived from the config
   * here, which is what a fixture constructing this stack directly does.
   */
  readonly targets?: readonly NormalizedTarget[];
}

/**
 * The WebSocket handlers and the authorizer guarding `$connect`, built from
 * their declarations.
 *
 * A route that pushes messages back to a client declares
 * `cloud.manageConnections`; the policy that permits it is emitted by
 * WebSocketApiStack, because only that stack knows the API and stage to scope
 * it to — and this stack must not depend on the API its handlers serve.
 */
export class WebSocketLambdaFunctionsStack extends cdk.Stack {
  public readonly targets = new FrameworkTargetRegistry();

  constructor(
    scope: Construct,
    id: string,
    props: WebSocketLambdaFunctionsStackProps,
  ) {
    super(scope, id, props);

    const context: CloudBuildContext = {
      config: props.config,
      mode: props.cloud.mode,
    };

    buildFrameworkLambdas(
      this,
      this.targets,
      props.targets ??
        getCloudTargets(
          props.config,
          ["webSocket", "webSocketAuthorizer"],
          props.cloud.mode,
        ),
      context,
    );
  }
}
