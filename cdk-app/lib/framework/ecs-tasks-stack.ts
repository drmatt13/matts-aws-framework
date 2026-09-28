import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as path from "path";
import {
  FrameworkTargetRegistry,
  type FrameworkTaskLaunch,
} from "./framework-target-registry";
import {
  attachContainerResources,
  emitCloudOutputs,
  type CloudBuildContext,
} from "./framework-cloud";
import {
  getCloudTargets,
  isSourcedTarget,
  type ContainerArchitecture,
  type FrameworkConfig,
  type NormalizedTarget,
} from "@repo/framework/config";
import {
  findDockerfile,
  findRepositoryRoot,
  readDockerfileStages,
  resolveFrameworkDirectory,
} from "@repo/framework/config/source";
import { registerAppTask } from "./framework-tasks";

/**
 * Container tasks on Fargate: definitions, not services.
 *
 * `tasks` is to `services` what `events` is to `http` — the same inventory,
 * identity and configuration vocabulary, keyed by a stable id instead of a
 * route. What this stack builds is a *task definition* plus the networking a
 * launch needs; nothing is running until something calls `RunTask`.
 *
 * This stack owns its own cluster rather than extracting the service cluster.
 * Sharing one is not a prerequisite for ECS invocation, and extracting
 * `EcsServicesStack/EcsCluster` would migrate a deployed resource and couple
 * task-only deployment to the presence of a service. The cost is a second
 * cluster, which is a control-plane object with no standing charge.
 */

export interface TaskNetworkInput {
  /** Absent, the default VPC is used. */
  readonly vpcId?: string;
  /** Absent, public subnets are selected. */
  readonly subnetIds?: readonly string[];
  /** Absent, a task security group with no inbound rules is created. */
  readonly securityGroupIds?: readonly string[];
  /** Absent, defaults to true, matching the default public-subnet placement. */
  readonly assignPublicIp?: boolean;
}

export interface EcsTasksStackProps extends cdk.StackProps {
  readonly config: FrameworkConfig;
  /** Which CDK graph this is. */
  readonly cloud: { readonly mode: "dev" | "prod" };
  /**
   * One placement, shared by every task in this deployment. Per-task subnet or
   * group selection, several task VPCs and cross-account launches are
   * unsupported in v1 and rejected rather than inferred: a networking catalog
   * is a second inventory, and guessing connectivity is worse than saying no.
   */
  readonly network?: TaskNetworkInput;
  /** The selection the composition factory validated, when there is one. */
  readonly targets?: readonly NormalizedTarget[];
}

const REPOSITORY_ROOT = findRepositoryRoot(__dirname);

/** Pinned rather than left to "LATEST resolves to whatever": see §3.4. */
const PLATFORM_VERSION = "LATEST";

function taskArchitecture(architecture: ContainerArchitecture): ecs.CpuArchitecture {
  return architecture === "arm64"
    ? ecs.CpuArchitecture.ARM64
    : ecs.CpuArchitecture.X86_64;
}

function imagePlatform(architecture: ContainerArchitecture): ecrAssets.Platform {
  return architecture === "arm64"
    ? ecrAssets.Platform.LINUX_ARM64
    : ecrAssets.Platform.LINUX_AMD64;
}

export class EcsTasksStack extends cdk.Stack {
  public readonly targets = new FrameworkTargetRegistry();

  constructor(scope: Construct, id: string, props: EcsTasksStackProps) {
    super(scope, id, props);

    const tasks =
      props.targets ?? getCloudTargets(props.config, ["task"], props.cloud.mode);
    // The VPC lookup below stays out of an empty stack, exactly as the service
    // stack's does.
    if (tasks.length === 0) return;

    const context: CloudBuildContext = {
      config: props.config,
      mode: props.cloud.mode,
    };

    const network = props.network ?? {};
    const vpc = network.vpcId
      ? ec2.Vpc.fromLookup(this, "TaskVpc", { vpcId: network.vpcId })
      : ec2.Vpc.fromLookup(this, "TaskVpc", { isDefault: true });

    const { subnets, assignPublicIp } = this.selectSubnets(vpc, network);
    const securityGroups = this.selectSecurityGroups(vpc, network);

    const cluster = new ecs.Cluster(this, "EcsTasksCluster", { vpc });

    // Two passes, so declaration order does not matter: a task that launches
    // another needs that task's handle, and the second one may be declared
    // below the first. The config already proved these edges are acyclic.
    const built = tasks.map((target) => ({
      target,
      ...this.addTask(cluster, target, context, {
        subnets,
        securityGroups,
        assignPublicIp,
      }),
    }));

    for (const { target, container, taskRole } of built) {
      attachContainerResources(this, container, taskRole, target, context);
    }
  }

  /**
   * The subnets a launch places tasks in, and whether they get a public IP.
   *
   * A private subnet needs working egress or VPC endpoints for image pulls,
   * logs, secrets and the calls the task itself makes. An ARN grant is not
   * network connectivity, and nothing here can supply one — so the placement is
   * validated and then trusted, and a missing default VPC or usable public
   * subnet fails with something a reader can act on.
   */
  private selectSubnets(
    vpc: ec2.IVpc,
    network: TaskNetworkInput,
  ): { readonly subnets: readonly string[]; readonly assignPublicIp: boolean } {
    if (network.subnetIds && network.subnetIds.length > 0) {
      const known = new Set([
        ...vpc.publicSubnets.map((subnet) => subnet.subnetId),
        ...vpc.privateSubnets.map((subnet) => subnet.subnetId),
        ...vpc.isolatedSubnets.map((subnet) => subnet.subnetId),
      ]);
      const foreign = network.subnetIds.filter((subnetId) => !known.has(subnetId));
      if (foreign.length > 0) {
        throw new Error(
          `Task networking selects subnet(s) ${foreign.join(", ")}, which are not in VPC ${vpc.vpcId}. One VPC holds every task subnet in v1.`,
        );
      }
      const isPublic = new Set(vpc.publicSubnets.map((subnet) => subnet.subnetId));
      const assignPublicIp = network.assignPublicIp ?? false;
      if (assignPublicIp && network.subnetIds.some((id) => !isPublic.has(id))) {
        throw new Error(
          "Task networking assigns a public IP to a subnet that is not public. Select public subnets, or turn the public-IP policy off and provide egress.",
        );
      }
      return { subnets: network.subnetIds, assignPublicIp };
    }

    const publicSubnets = vpc.publicSubnets.map((subnet) => subnet.subnetId);
    if (publicSubnets.length === 0) {
      throw new Error(
        `VPC ${vpc.vpcId} has no public subnet, so a task cannot pull its image with the default placement. Set TASK_SUBNET_IDS to subnets with working egress, or use a VPC that has public subnets.`,
      );
    }
    return { subnets: publicSubnets, assignPublicIp: network.assignPublicIp ?? true };
  }

  /**
   * Task security groups.
   *
   * With none supplied, one is created with no inbound rules: a task that runs
   * to completion accepts no connections. Anything a specific resource needs to
   * reach — a database, a cache — is a rule the application's own CDK owns,
   * beside the resource that grants it.
   */
  private selectSecurityGroups(
    vpc: ec2.IVpc,
    network: TaskNetworkInput,
  ): readonly string[] {
    if (network.securityGroupIds && network.securityGroupIds.length > 0) {
      return network.securityGroupIds;
    }
    const group = new ec2.SecurityGroup(this, "TaskSecurityGroup", {
      vpc,
      description: "Framework container tasks. No inbound rules by design.",
      allowAllOutbound: true,
    });
    return [group.securityGroupId];
  }

  /**
   * One Fargate task definition, from one declaration.
   *
   * Both roles are created explicitly rather than left to CDK's lazy creation:
   * the caller's `iam:PassRole` grant names both ARNs, so "the execution role
   * exists only if something happened to need it" is not a property this can be
   * built on.
   */
  private addTask(
    cluster: ecs.Cluster,
    target: NormalizedTarget,
    context: CloudBuildContext,
    placement: {
      readonly subnets: readonly string[];
      readonly securityGroups: readonly string[];
      readonly assignPublicIp: boolean;
    },
  ): {
    readonly container: ecs.ContainerDefinition;
    readonly taskRole: iam.Role;
  } {
    const settings = target.cloud.task;
    if (!settings || !isSourcedTarget(target)) {
      throw new Error(
        `Framework target "${target.reference}" is not a task declaration.`,
      );
    }


    const executionRole = new iam.Role(this, `${target.cloud.constructId}ExecutionRole`, {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: `Starts task:${target.id}: image pull, logs and startup secrets.`,
    });
    const taskRole = new iam.Role(this, `${target.cloud.constructId}TaskRole`, {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: `The application identity of task:${target.id}.`,
    });

    const definition = new ecs.FargateTaskDefinition(
      this,
      target.cloud.constructId,
      {
        cpu: settings.cpu,
        memoryLimitMiB: settings.memoryMiB,
        executionRole,
        taskRole,
        runtimePlatform: {
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
          cpuArchitecture: taskArchitecture(settings.architecture),
        },
      },
    );

    // One essential container running its Dockerfile's command. No port
    // mapping, no health check and no sidecar: none of them describes a
    // container whose result is its exit status.
    const containerName = "Main";
    const container = definition.addContainer(containerName, {
      containerName,
      image: this.taskImage(target, settings),
      essential: true,
      environment: {
        // Lambda is told its region; a task is not, and the framework sets it
        // for the same reason - which is why a declaration may not.
        AWS_REGION: this.region,
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: target.id,
        logRetention: logs.RetentionDays.ONE_WEEK,
      }),
    });

    const launch: FrameworkTaskLaunch = {
      region: this.region,
      cluster: cluster.clusterArn,
      taskDefinitionArn: definition.taskDefinitionArn,
      containerName,
      launchType: "FARGATE",
      platformVersion: PLATFORM_VERSION,
      subnets: placement.subnets,
      securityGroups: placement.securityGroups,
      assignPublicIp: placement.assignPublicIp,
    };

    const handle = {
      launch,
      taskDefinition: definition,
      grantRun: (grantee: iam.IGrantable): void => {
        grantRunTask(grantee, launch, definition);
      },
    };
    this.targets.task(target.id, handle);
    // Recorded app-wide as well, so a caller in another stack can resolve the
    // handle without it being threaded through props - the same arrangement
    // event Lambdas already use.
    registerAppTask(this, target.id, handle);

    emitCloudOutputs(this, target, {
      taskDefinitionArn: definition.taskDefinitionArn,
    });

    return { container, taskRole };
  }

  /**
   * The task's image, built from its own Dockerfile with the repository root as
   * context — the same reason a service's is: the Dockerfile installs from the
   * root lockfile so npm workspaces resolve `@repo/*`.
   */
  private taskImage(
    target: NormalizedTarget & { readonly directory: `/${string}` },
    settings: NonNullable<NormalizedTarget["cloud"]["task"]>,
  ): ecs.ContainerImage {
    const directory = resolveFrameworkDirectory(target.directory, target.reference, {
      repositoryRoot: REPOSITORY_ROOT,
    });
    const dockerfile = findDockerfile(directory);
    if (!dockerfile) {
      throw new Error(
        `Task "${target.id}" is cloud-enabled, but ${directory} has no Dockerfile.`,
      );
    }
    if (settings.buildTarget) {
      const stages = readDockerfileStages(dockerfile);
      if (!stages.includes(settings.buildTarget)) {
        throw new Error(
          `Task "${target.id}" declares cloud.buildTarget "${settings.buildTarget}", which ${dockerfile} does not define. It has ${stages.length > 0 ? stages.join(", ") : "no named stages"}.`,
        );
      }
    }

    return ecs.ContainerImage.fromAsset(REPOSITORY_ROOT, {
      file: path.relative(REPOSITORY_ROOT, dockerfile),
      ...(settings.buildTarget ? { target: settings.buildTarget } : {}),
      // Always pinned for a task, unlike a service: the image is built once and
      // scheduled somewhere else, so "whatever this Docker host is" is the
      // wrong answer in exactly the case that is hardest to debug.
      platform: imagePlatform(settings.architecture),
    });
  }


}

/**
 * The exact grants a launch needs, and nothing wider.
 *
 * `ecs:RunTask` on this task definition revision, restricted to this cluster;
 * `iam:PassRole` on *both* roles, restricted to the ECS tasks service. The two
 * PassRole resources are deliberate: a launch passes the execution role that
 * starts the task and the task role the application then runs as, and granting
 * only one produces an `AccessDenied` that names neither.
 *
 * Written as explicit statements rather than a broad CDK grant narrowed
 * afterwards. A second Allow does not narrow the first — it widens the policy.
 *
 * @see https://docs.aws.amazon.com/AmazonECS/latest/developerguide/security_iam_id-based-policy-examples.html
 * @see https://docs.aws.amazon.com/AmazonECS/latest/developerguide/CWE_IAM_role.html
 */
export function grantRunTask(
  grantee: iam.IGrantable,
  launch: FrameworkTaskLaunch,
  definition: ecs.TaskDefinition,
): void {
  grantee.grantPrincipal.addToPrincipalPolicy(
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["ecs:RunTask"],
      resources: [launch.taskDefinitionArn],
      conditions: { ArnEquals: { "ecs:cluster": launch.cluster } },
    }),
  );

  const passable = [definition.taskRole.roleArn, definition.executionRole?.roleArn]
    .filter((arn): arn is string => typeof arn === "string");
  grantee.grantPrincipal.addToPrincipalPolicy(
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["iam:PassRole"],
      resources: passable,
      conditions: {
        StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" },
      },
    }),
  );
}
