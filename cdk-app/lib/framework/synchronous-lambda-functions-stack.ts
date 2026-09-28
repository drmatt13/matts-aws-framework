import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import {
  getCloudTargets,
  type FrameworkConfig,
  type NormalizedTarget,
} from "@repo/framework/config";
import { FrameworkTargetRegistry } from "./framework-target-registry";
import { buildFrameworkLambdas, type CloudBuildContext } from "./framework-cloud";

export interface SynchronousLambdaFunctionsStackProps extends cdk.StackProps {
  readonly config: FrameworkConfig;
  /**
   * Which CDK graph this is. One value
   * rather than two, so a prod mode cannot be combined with a dev
   * resource shape — and adding a required HTTP resource to the config is a
   * missing-field error at this stack's call site.
   */
  readonly cloud: { readonly mode: "dev" | "prod" };
  /**
   * The targets to build, when the composition factory has already selected
   * and validated them. Omitted, the same selection is derived from the config
   * here — from `cloud.mode`, so a fixture gets the graph it asked for rather
   * than every cloud-enabled target regardless of mode.
   */
  readonly targets?: readonly NormalizedTarget[];
}

/**
 * The HTTP handlers, built from their declarations.
 *
 * Every one of them — its runtime, sizing, packaging, environment, the secrets
 * it reads and the outputs it publishes — is declared in framework.config.ts.
 * This stack resolves those declarations against the values the composition
 * root supplied and constructs the result. Adding an HTTP Lambda that uses
 * existing resources changes nothing here.
 */
export class SynchronousLambdaFunctionsStack extends cdk.Stack {
  public readonly targets = new FrameworkTargetRegistry();

  constructor(
    scope: Construct,
    id: string,
    props: SynchronousLambdaFunctionsStackProps,
  ) {
    super(scope, id, props);

    const context: CloudBuildContext = {
      config: props.config,
      mode: props.cloud.mode,
    };

    buildFrameworkLambdas(
      this,
      this.targets,
      props.targets ?? getCloudTargets(props.config, ["http"], props.cloud.mode),
      context,
    );
  }
}
