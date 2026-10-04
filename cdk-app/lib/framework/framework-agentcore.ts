import * as cdk from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { buildSync } from "esbuild";
import path from "node:path";
import {
  AGENTCORE_TOOLS,
  gatewayInputSchema,
  getAgentLifecycle,
  getAgentTools,
  getCloudTargets,
  type CloudMode,
  type FrameworkConfig,
  type GatewaySchema,
  type GatewayToolManifest,
  type NormalizedTarget,
} from "@repo/framework/config";
import { findRepositoryRoot, resolveAgentSourcePath } from "@repo/framework/config/source";
import { RuntimeMetadataV2 } from "./agentcore-metadata";
import {
  applyCloudPermissions,
  buildFrameworkLambdas,
  emitCloudOutputs,
  resolveInvocationDescriptors,
  resolveTargetCloudValues,
} from "./framework-cloud";
import type { CognitoResources } from "./http-api-gateway-stack";
import { deferResourceAttachment } from "./framework-resources";
import { appInvocationRegistry } from "./framework-tasks";
import { FrameworkTargetRegistry } from "./framework-target-registry";

const ROOT = findRepositoryRoot(__dirname);
const SERVE_MODULE = path.join(ROOT, "packages", "framework", "src", "runtime", "agentcore-serve.ts").replaceAll("\\", "/");

/** Whether this graph builds anything for AgentCore. A dev graph never does: agents run locally. */
export function hasAgentCoreCloudResources(config: FrameworkConfig, mode: CloudMode): boolean {
  return getCloudTargets(config, ["agent", "tool"], mode).length > 0;
}

export interface FrameworkAgentCoreProps {
  readonly config: FrameworkConfig;
  readonly mode: CloudMode;
  /** The user pool an agent declared `auth: true` accepts tokens from, as the HTTP API does. */
  readonly cognito: CognitoResources;
  /** The committed contract projection. Overridable for fixtures. */
  readonly tools?: GatewayToolManifest;
}

/** An agent the browser reaches through its declared same-origin path. */
export interface BrowserAgent {
  readonly id: string;
  readonly path: string;
  readonly runtimeArn: string;
}

function gatewaySchema(definition: GatewaySchema): agentcore.SchemaDefinition {
  return {
    type: agentcore.SchemaDefinitionType.of(definition.type),
    ...(definition.description ? { description: definition.description } : {}),
    ...(definition.properties
      ? {
          properties: Object.fromEntries(
            Object.entries(definition.properties).map(([name, child]) => [name, gatewaySchema(child)]),
          ),
        }
      : {}),
    ...(definition.required ? { required: [...definition.required] } : {}),
    ...(definition.items ? { items: gatewaySchema(definition.items) } : {}),
  };
}

/**
 * An agent's deployable artifact: its source bundled with esbuild — as a zip
 * Lambda is — together with the framework's Runtime adapter, and deployed as
 * Node code. No Docker, no registry, nothing to cross-build for ARM64, and the
 * same module the local session process serves.
 */
function agentArtifact(directory: string): agentcore.AgentRuntimeArtifact {
  return agentcore.AgentRuntimeArtifact.fromCodeAsset({
    path: directory,
    runtime: agentcore.AgentCoreRuntime.NODE_22,
    entrypoint: ["index.js"],
    // The bundle is the artifact, so its hash is the identity: an edit to a
    // shared package changes the agent even though its directory did not.
    assetHashType: cdk.AssetHashType.OUTPUT,
    bundling: {
      // Required by the type; local bundling always answers first.
      image: cdk.DockerImage.fromRegistry("public.ecr.aws/docker/library/node:22"),
      local: {
        tryBundle(outputDirectory: string): boolean {
          buildSync({
            stdin: {
              contents: [
                'import { handler } from "./index";',
                `import { serveAgent } from ${JSON.stringify(SERVE_MODULE)};`,
                "serveAgent(handler).catch((error) => { console.error(error); process.exit(1); });",
              ].join("\n"),
              resolveDir: directory,
              sourcefile: "agentcore-entry.ts",
              loader: "ts",
            },
            bundle: true,
            platform: "node",
            target: "node22",
            format: "cjs",
            minify: true,
            sourcemap: true,
            outfile: path.join(outputDirectory, "index.js"),
            logLevel: "warning",
          });
          return true;
        },
      },
    },
  });
}

/**
 * Every agent, its Gateway and its tools, for a deployment that builds them.
 *
 * One Gateway per agent, holding exactly the tools the agent lists: the
 * agent's Runtime role may invoke its own Gateway and no other, so an agent
 * cannot reach a tool it did not declare — whatever its model asks for.
 *
 * A construct, not a stack: it lives in the orchestration stack beside the
 * workflows (`orchestration-stack.ts`), because a workflow step invokes an
 * agent and a tool or agent starts a workflow, and only a shared stack lets
 * both directions deploy. Nothing here knows about Step Functions beyond the
 * registry a starter's descriptor is read from.
 */
export class FrameworkAgentCore extends Construct {
  public readonly targets = new FrameworkTargetRegistry();
  public readonly browserAgents: BrowserAgent[] = [];
  public readonly region: string;

  public constructor(scope: Construct, id: string, props: FrameworkAgentCoreProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    this.region = stack.region;
    const { config, mode } = props;
    const manifest = props.tools ?? (AGENTCORE_TOOLS as GatewayToolManifest);

    const toolTargets = getCloudTargets(config, ["tool"], mode);
    for (const target of toolTargets) {
      if (!manifest[target.id]) {
        throw new Error(`tools["${target.id}"] has no generated contract projection. Run npm run framework:generate.`);
      }
    }
    const tools = buildFrameworkLambdas(stack, this.targets, toolTargets, { config, mode }, new Construct(this, "Tools"));

    const gatewaysScope = new Construct(this, "Gateways");
    const runtimesScope = new Construct(this, "Runtimes");
    const agents = getCloudTargets(config, ["agent"], mode);
    // One MMDSv2 provider for every Runtime; see RuntimeMetadataV2.
    const metadata = agents.length > 0 ? new RuntimeMetadataV2(this, "RuntimeMetadata") : undefined;
    for (const target of agents) {
      this.buildAgent(target, { config, cognito: props.cognito, manifest, tools, gatewaysScope, runtimesScope, metadata: metadata! });
    }
  }

  private buildAgent(
    target: NormalizedTarget,
    context: {
      readonly config: FrameworkConfig;
      readonly cognito: CognitoResources;
      readonly manifest: GatewayToolManifest;
      readonly tools: ReadonlyMap<string, lambda.Function>;
      readonly gatewaysScope: Construct;
      readonly runtimesScope: Construct;
      readonly metadata: RuntimeMetadataV2;
    },
  ): void {
    const stack = cdk.Stack.of(this);
    const { config, cognito, manifest, tools } = context;
    const declaration = config.agents?.[target.id];
    const auth = declaration?.auth === true;
    const lifecycle = getAgentLifecycle(config, target.id);
    const constructId = target.cloud.constructId;

    const runtime = new agentcore.Runtime(context.runtimesScope, constructId, {
      agentRuntimeArtifact: agentArtifact(resolveAgentSourcePath(config, target.id, { repositoryRoot: ROOT })),
      lifecycleConfiguration: {
        idleRuntimeSessionTimeout: cdk.Duration.seconds(lifecycle.idleSeconds),
        maxLifetime: cdk.Duration.seconds(lifecycle.maxLifetimeSeconds),
      },
      ...(auth
        ? {
            // An ID token carries the app client in `aud`, not `client_id`, so
            // the client is the allowed audience — the token the browser
            // already sends to every authenticated route.
            authorizerConfiguration: agentcore.RuntimeAuthorizerConfiguration.usingJWT(
              `https://cognito-idp.${stack.region}.amazonaws.com/${cognito.userPool.userPoolId}/.well-known/openid-configuration`,
              undefined,
              [cognito.userPoolClient.userPoolClientId],
            ),
            // The adapter verifies the token again, as an authenticated
            // handler does behind the HTTP API's authorizer.
            requestHeaderConfiguration: { allowlistedHeaders: ["Authorization"] },
          }
        : {}),
    });
    appInvocationRegistry(this).agent(target.id, {
      arn: runtime.agentRuntimeArn,
      region: stack.region,
      auth,
      // InvokeAgentRuntime only: the ForUser variant that grantInvoke adds is
      // for acting through AgentCore Identity, which no framework caller does.
      grantInvoke: (grantee) => {
        runtime.grantInvokeRuntime(grantee);
      },
    });
    if (auth && declaration?.route !== undefined) {
      this.browserAgents.push({ id: target.id, path: declaration.route, runtimeArn: runtime.agentRuntimeArn });
    }

    const agentTools = getAgentTools(config, target.id);
    const gateway =
      agentTools.length === 0
        ? undefined
        : new agentcore.Gateway(context.gatewaysScope, constructId, {
            authorizerConfiguration: agentcore.GatewayAuthorizer.usingAwsIam(),
            protocolConfiguration: agentcore.GatewayProtocol.mcp({
              supportedVersions: [agentcore.MCPProtocolVersion.MCP_2025_03_26],
            }),
          });
    for (const tool of agentTools) {
      const fn = tools.get(tool.id);
      if (!fn) throw new Error(`agent:${target.id} lists tools("${tool.id}"), which this deployment did not build.`);
      const entry = manifest[tool.id];
      gateway!.addLambdaTarget(`Target${tool.id}`, {
        gatewayTargetName: tool.id,
        lambdaFunction: fn,
        toolSchema: agentcore.ToolSchema.fromInline([
          {
            name: tool.id,
            description: entry.description,
            inputSchema: gatewaySchema(gatewayInputSchema(entry)),
            outputSchema: gatewaySchema(entry.outputSchema),
          },
        ]),
      });
    }
    gateway?.grantInvoke(runtime);

    // Resource values resolve once every linked stack exists.
    deferResourceAttachment(this, () => {
      const values = resolveTargetCloudValues(target, this);
      const resource = runtime.node.defaultChild as agentcore.CfnRuntime;
      resource.environmentVariables = {
        ...values.environment,
        ...resolveInvocationDescriptors(this, target),
        FRAMEWORK_AGENTCORE_ADAPTER: stack.toJsonString({
          agent: target.id,
          auth,
          ...(gateway ? { gateway: { transport: "iam", url: gateway.gatewayUrl, region: stack.region } } : {}),
        }),
      };
      applyCloudPermissions(this, runtime, target, values);
    });
    emitCloudOutputs(stack, target, { arn: runtime.agentRuntimeArn });
    context.metadata.enable(constructId, runtime);
  }
}
