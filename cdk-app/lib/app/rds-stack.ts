import { linkResources } from "../framework/framework-resources";
import { frameworkVpc } from "../framework/framework-network";
import { resources } from "../../../framework-config/resources";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";

export interface RdsStackProps extends cdk.StackProps {
  primaryDatabaseName?: string;
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

    const primaryDatabaseName = props?.primaryDatabaseName ?? "app_db";
    const retainStatefulResources = props?.retainStatefulResources ?? false;
    const backupRetentionDays = props?.backupRetentionDays ?? 7;

    // The database sits in the framework network's isolated subnets, which have
    // no route to the internet, and admits nobody until a workload declares
    // database: true. Workloads log in as the IAM login the framework creates
    // on deploy, never with a password. The master user is RDS's requirement:
    // its generated password is read once, on deploy, to create that login.
    this.database = new rds.DatabaseInstance(this, "PostgresDatabase", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE3,
        ec2.InstanceSize.MICRO,
      ),
      vpc: frameworkVpc(this),
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      publiclyAccessible: false,
      // Encryption at rest with the AWS-managed key costs nothing.
      storageEncrypted: true,
      credentials: rds.Credentials.fromGeneratedSecret("postgres"),
      iamAuthentication: true,
      databaseName: primaryDatabaseName,
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      multiAz: false,
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

    // Last, once every public field is assigned. This is what supplies
    // `resources.rds`.
    linkResources(this, resources.rds);

    new cdk.CfnOutput(this, "RdsDatabaseEndpoint", {
      value: this.database.instanceEndpoint.hostname,
      exportName: `${this.stackName}:RdsDatabaseEndpoint`,
    });
  }
}
