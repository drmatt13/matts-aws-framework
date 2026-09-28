import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";
import { validateFrameworkConfig, type FrameworkConfig } from "@repo/framework/config";
import {
  buildEventLambdas,
  type EventLambdaContext,
  type EventTargetId,
} from "./framework-events";
import { FrameworkTargetRegistry } from "./framework-target-registry";

export interface EventLambdaFunctionsStackProps<C extends FrameworkConfig>
  extends cdk.StackProps {
  readonly config: C;
  readonly cloud: { readonly mode: "dev" | "prod" };
  readonly readers?: EventLambdaContext<C>["readers"];
  readonly replay?: EventLambdaContext<C>["replay"];
  /** Omitted, build every declared event. Native owners can split the inventory. */
  readonly targets?: readonly EventTargetId<C>[];
}

/**
 * Config-owned functions; application CDK connects their native handles.
 *
 * The stack exposes no lookup of its own: whatever it builds is reachable from
 * anywhere in the app with `eventFunction(scope, id)`, which is also how the
 * functions a native owner built are reached.
 */
export class EventLambdaFunctionsStack<
  C extends FrameworkConfig = FrameworkConfig,
>
  extends cdk.Stack
{
  public readonly targets = new FrameworkTargetRegistry();

  constructor(
    scope: Construct,
    id: string,
    props: EventLambdaFunctionsStackProps<C>,
  ) {
    super(scope, id, props);
    validateFrameworkConfig(props.config);
    buildEventLambdas(
      this,
      {
        config: props.config,
        targets: this.targets,
        cloud: props.cloud,
        readers: props.readers,
        replay: props.replay,
      },
      props.targets ?? (Object.keys(props.config.events) as EventTargetId<C>[]),
    );
  }
}
