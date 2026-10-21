import { applicationDatabase } from "../../../framework-config/databases/application";
import { linkResources } from "../framework/framework-resources";
import { frameworkVpc } from "../framework/framework-network";
import { resources } from "../../../framework-config/resources";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as iam from "aws-cdk-lib/aws-iam";
import { DATABASE_LOGIN, type FrameworkDatabase } from "@repo/framework/config";
import { bindPostgresDatabase } from "../framework/framework-database";
import { resolveDatabaseSettings, type DatabaseSettings } from "../../database-settings";

export interface RdsStackProps extends cdk.StackProps {
  /** Source settings without moving the established RdsStack/native scopes. */
  definition?: FrameworkDatabase;
  primaryDatabaseName?: string;
  databaseSettings?: DatabaseSettings;
  retainStatefulResources?: boolean;
  /** Days of automated backups. Defaults to 7; 0 turns them off. */
  backupRetentionDays?: number;
}

export class RdsStack extends cdk.Stack {
  // Public fields are this stack's resources — `resources.rds` reads them, and
  // `linkResources(this, ...)` at the end of the constructor supplies them.
  /**
   * The application's database: framework.config.ts names it as `database`,
   * and a workload reaches it by declaring `database: true`.
   */
  public readonly database: rds.DatabaseInstance;

  constructor(scope: Construct, id: string, props?: RdsStackProps) {
    super(scope, id, props);

    const definition = props?.definition ?? applicationDatabase;
    const primaryDatabaseName = props?.primaryDatabaseName ?? definition.databaseName;
    const retainStatefulResources = props?.retainStatefulResources ?? false;
    const settings = props?.databaseSettings ?? resolveDatabaseSettings({ getContext: () => undefined, env: {}, defaults: definition.settings });
    const backupRetentionDays = props?.backupRetentionDays ?? settings.backupRetentionDays;
    if (settings.readReplicaCount > 0 && backupRetentionDays === 0) throw new Error("Read replicas require positive backup retention on the writer.");
    const vpc = frameworkVpc(this, definition.vpc);
    const vpcSubnets = { subnetType: definition.subnet === "private" ? ec2.SubnetType.PRIVATE_WITH_EGRESS : ec2.SubnetType.PRIVATE_ISOLATED };
    const storageType = { gp2: rds.StorageType.GP2, gp3: rds.StorageType.GP3, io2: rds.StorageType.IO2 }[settings.storageType];

    // The declaration selects private or isolated subnets. The database has no
    // public address and admits nobody until a workload declares
    // database: true. Workloads log in as the IAM login the framework creates
    // on deploy, never with a password. The master user is RDS's requirement:
    // its generated password is read once, on deploy, to create that login.
    this.database = new rds.DatabaseInstance(this, "PostgresDatabase", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.of(settings.engineVersion, settings.engineVersion.split(".")[0]!),
      }),
      instanceType: new ec2.InstanceType(settings.instanceClass.slice(3)),
      vpc,
      vpcSubnets,
      publiclyAccessible: false,
      // Encryption at rest with the AWS-managed key costs nothing.
      storageEncrypted: true,
      credentials: rds.Credentials.fromGeneratedSecret("postgres"),
      iamAuthentication: true,
      databaseName: primaryDatabaseName,
      allocatedStorage: settings.allocatedStorage,
      maxAllocatedStorage: settings.maxAllocatedStorage,
      storageType, iops: settings.iops, storageThroughput: settings.throughput,
      multiAz: settings.multiAz,
      allowMajorVersionUpgrade: settings.allowMajorVersionUpgrade,
      autoMinorVersionUpgrade: settings.autoMinorVersionUpgrade,
      ...(settings.applyImmediately === undefined ? {} : { applyImmediately: settings.applyImmediately }),
      preferredBackupWindow: settings.backupWindow,
      preferredMaintenanceWindow: settings.maintenanceWindow,
      cloudwatchLogsExports: [...settings.logExports],
      cloudwatchLogsRetention: settings.logRetentionDays,
      backupRetention: cdk.Duration.days(backupRetentionDays),
      // Kept after the instance is gone, so a mistaken deletion is recoverable
      // for the retention window.
      deleteAutomatedBackups: false,
      deletionProtection: retainStatefulResources,
      // Unretained, deleting the database (by `cdk destroy` or a replacement)
      // still leaves a final snapshot behind.
      removalPolicy: retainStatefulResources
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.SNAPSHOT,
    });
    // The secret has no snapshot to take, so it keeps the plain pair.
    this.database.secret?.applyRemovalPolicy(
      retainStatefulResources ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    );

    const readReplicas = Array.from({ length: settings.readReplicaCount }, (_, index) => new rds.DatabaseInstanceReadReplica(this, `ReadReplica${index + 1}`, {
      sourceDatabaseInstance: this.database,
      instanceType: new ec2.InstanceType(settings.readReplicaInstanceClass.slice(3)),
      vpc, vpcSubnets,
      // CloudFormation requires encryption to be inherited from the source writer.
      publiclyAccessible: false, iamAuthentication: true,
      // Inherit the writer's actual allocation, including prior storage autoscaling.
      maxAllocatedStorage: settings.maxAllocatedStorage,
      storageType, iops: settings.iops, storageThroughput: settings.throughput,
      multiAz: settings.readReplicaMultiAz,
      autoMinorVersionUpgrade: settings.autoMinorVersionUpgrade,
      ...(settings.applyImmediately === undefined ? {} : { applyImmediately: settings.applyImmediately }),
      preferredMaintenanceWindow: settings.maintenanceWindow,
      cloudwatchLogsExports: [...settings.logExports], cloudwatchLogsRetention: settings.logRetentionDays,
      deletionProtection: retainStatefulResources,
      removalPolicy: retainStatefulResources ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    }));
    let proxy: rds.DatabaseProxy | undefined;
    if (settings.proxyEnabled) {
      const role = new iam.Role(this, "DatabaseProxyRole", { assumedBy: new iam.ServicePrincipal("rds.amazonaws.com") });
      this.database.grantConnect(role, DATABASE_LOGIN);
      proxy = new rds.DatabaseProxy(this, "DatabaseProxy", {
        proxyTarget: rds.ProxyTarget.fromInstance(this.database), vpc,
        vpcSubnets,
        role, defaultAuthScheme: rds.DefaultAuthScheme.IAM_AUTH, requireTLS: true,
        maxConnectionsPercent: settings.proxyMaxConnectionsPercent,
        borrowTimeout: cdk.Duration.seconds(settings.proxyBorrowTimeoutSeconds),
        idleClientTimeout: cdk.Duration.seconds(settings.proxyIdleClientTimeoutSeconds),
      });
      this.database.connections.allowDefaultPortFrom(proxy, "RDS Proxy writer connections");
    }
    bindPostgresDatabase(this, definition.resource, { instance: this.database, proxy, readReplicas });

    // Last, once every public field is assigned. This is what supplies
    // `resources.rds`.
    linkResources(this, resources.rds);

    new cdk.CfnOutput(this, "RdsDatabaseEndpoint", {
      value: this.database.instanceEndpoint.hostname,
      exportName: `${this.stackName}:RdsDatabaseEndpoint`,
    });
  }
}
