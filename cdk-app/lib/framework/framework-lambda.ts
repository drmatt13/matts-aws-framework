import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cxapi from "aws-cdk-lib/cx-api";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as fs from "fs";
import * as path from "path";
import {
  isNodeLambdaRuntime,
  resolveLambdaTarget,
  type FrameworkConfig,
  type LambdaArchitecture,
  type NodeLambdaRuntime,
  type PythonLambdaRuntime,
  type ResolvedLambdaTarget,
} from "@repo/framework/config";
import {
  findRepositoryRoot,
  resolveFrameworkDirectory,
} from "@repo/framework/config/source";
import type { LambdaPlacement } from "./framework-network";

/**
 * Builds a Lambda from framework defaults plus target-specific overrides.
 *
 * Everything about how a function is packaged, sized and built comes from the
 * config it is handed — never from an imported root singleton, so a fixture
 * application can be built without mutating the real config, and a stack always
 * projects the config it was given.
 */

const REPOSITORY_ROOT = findRepositoryRoot(__dirname);

const NODE_RUNTIMES: Record<NodeLambdaRuntime, lambda.Runtime> = {
  nodejs24: lambda.Runtime.NODEJS_24_X,
  nodejs22: lambda.Runtime.NODEJS_22_X,
};

const PYTHON_RUNTIMES: Record<PythonLambdaRuntime, lambda.Runtime> = {
  "python3.13": lambda.Runtime.PYTHON_3_13,
  "python3.12": lambda.Runtime.PYTHON_3_12,
};

const ESBUILD_TARGETS: Record<NodeLambdaRuntime, string> = {
  nodejs24: "node24",
  nodejs22: "node22",
};

function cdkArchitecture(architecture: LambdaArchitecture): lambda.Architecture {
  return architecture === "arm64"
    ? lambda.Architecture.ARM_64
    : lambda.Architecture.X86_64;
}

function imagePlatform(architecture: LambdaArchitecture): ecrAssets.Platform {
  return architecture === "arm64"
    ? ecrAssets.Platform.LINUX_ARM64
    : ecrAssets.Platform.LINUX_AMD64;
}

/**
 * Python zip packaging. Dependencies are installed inside the runtime's own
 * bundling image so compiled wheels match the Lambda platform — the same thing
 * PythonFunction does internally, without taking on an alpha module that would
 * pin every future aws-cdk-lib bump.
 */
function pythonAssetCode(directory: string, runtime: lambda.Runtime): lambda.Code {
  if (!fs.existsSync(path.join(directory, "requirements.txt"))) {
    return lambda.Code.fromAsset(directory);
  }

  return lambda.Code.fromAsset(directory, {
    bundling: {
      image: runtime.bundlingImage,
      command: [
        "bash",
        "-c",
        "pip install --no-cache-dir -r requirements.txt -t /asset-output && cp -au . /asset-output",
      ],
    },
  });
}

/** Native operational options; the manifest owns build settings. */
export type FrameworkLambdaOptions = Omit<
  lambda.FunctionOptions,
  "architecture" | "memorySize" | "timeout"
>;

const MANIFEST_OWNED_OPTIONS = [
  "architecture", "memorySize", "timeout", "timeoutSeconds", "packaging",
  "directory", "code", "entry", "handler", "runtime", "bundling",
  "logGroup", "logRetention", "logRetentionDays", "loggingFormat",
  // Placement follows `vpc` and `database: true`: see framework-network.ts.
  "vpc", "vpcSubnets", "securityGroups", "securityGroup", "allowPublicSubnet",
  "allowAllOutbound", "allowAllIpv6Outbound", "ipv6AllowedForDualStack",
] as const;

/** Resolves a target id against the given config and builds it. */
export function frameworkLambdaById(
  scope: Construct,
  constructId: string,
  config: FrameworkConfig,
  targetId: string,
  options: FrameworkLambdaOptions = {},
  placement?: LambdaPlacement,
): lambda.Function {
  return frameworkLambda(
    scope,
    constructId,
    resolveLambdaTarget(config, targetId),
    options,
    placement,
  );
}

/**
 * Builds one Lambda from an already-resolved target.
 *
 * `constructId` is passed explicitly rather than derived here: the full
 * construct path contributes to the CloudFormation logical id. Preserve both
 * scope and id to keep deployed identity stable.
 */
export function frameworkLambda(
  scope: Construct,
  constructId: string,
  spec: ResolvedLambdaTarget,
  options: FrameworkLambdaOptions = {},
  placement?: LambdaPlacement,
): lambda.Function {
  for (const key of MANIFEST_OWNED_OPTIONS) {
    if (key in options) {
      throw new Error(`Framework Lambda target "${spec.id}": option "${key}" is owned by the manifest; set it in framework.config.ts.`);
    }
  }
  // The declared location, resolved and containment-checked by the same code
  // the generator and the local runner use.
  const directory = resolveFrameworkDirectory(spec.directory, spec.reference, {
    repositoryRoot: REPOSITORY_ROOT,
  });

  // With CDK's managed log group (on in cdk.json), each function owns its
  // /aws/lambda/<name> group and only its retention needs setting. Without it,
  // Lambda would create that group itself, unmanaged and never expiring, so the
  // framework supplies one.
  const cdkManagesLogGroup = cdk.FeatureFlags.of(scope).isEnabled(
    cxapi.USE_CDK_MANAGED_LAMBDA_LOGGROUP,
  );

  const shared = {
    ...options,
    // Passed at construction: a security group added to a function afterwards
    // never reaches its VPC configuration.
    ...(placement ?? {}),
    architecture: cdkArchitecture(spec.architecture),
    memorySize: spec.memorySize,
    timeout: cdk.Duration.seconds(spec.timeoutSeconds),
    ...(cdkManagesLogGroup
      ? {}
      : {
          logGroup: new logs.LogGroup(scope, `${constructId}LogGroup`, {
            retention: spec.logRetentionDays as logs.RetentionDays,
          }),
        }),
    // One JSON object per line, each carrying the request id, which is what
    // CloudWatch Logs Insights queries by. TRACE filters nothing: every
    // console level still reaches the log, as it does locally.
    loggingFormat: lambda.LoggingFormat.JSON,
    applicationLogLevelV2: lambda.ApplicationLogLevel.TRACE,
  };

  const retained = <T extends lambda.Function>(fn: T): T => {
    if (cdkManagesLogGroup) applyLogRetention(fn, spec);
    return fn;
  };

  if (spec.packaging === "container") {
    return retained(new lambda.DockerImageFunction(scope, constructId, {
      ...shared,
      code: lambda.DockerImageCode.fromImageAsset(directory, {
        platform: imagePlatform(spec.architecture),
      }),
    }));
  }

  if (isNodeLambdaRuntime(spec.runtime)) {
    return retained(new nodejs.NodejsFunction(scope, constructId, {
      ...shared,
      runtime: NODE_RUNTIMES[spec.runtime],
      entry: path.join(directory, "index.ts"),
      handler: spec.handler,
      bundling: {
        minify: spec.bundling.minify,
        sourceMap: spec.bundling.sourceMap,
        target: ESBUILD_TARGETS[spec.runtime],
      },
    }));
  }

  const runtime = PYTHON_RUNTIMES[spec.runtime];
  return retained(new lambda.Function(scope, constructId, {
    ...shared,
    runtime,
    handler: spec.handler,
    code: pythonAssetCode(directory, runtime),
  }));
}

/**
 * Keeps a function's logs for the declared number of days rather than CDK's
 * two-year default. Set on the group CDK already created beside the function,
 * so its name (/aws/lambda/<function>) and logical id do not change and a
 * deployed function keeps writing where it always has.
 */
function applyLogRetention(fn: lambda.Function, spec: ResolvedLambdaTarget): void {
  const group = fn.node.tryFindChild("LogGroup")?.node.defaultChild;
  if (!(group instanceof logs.CfnLogGroup)) {
    throw new Error(
      `Framework Lambda target "${spec.id}": CDK did not create the function's log group, so its retention cannot be set.`,
    );
  }
  group.retentionInDays = spec.logRetentionDays;
}
