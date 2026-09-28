import { linkResources } from "../framework/framework-resources";
import { resources } from "../../../framework-config/resources";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import type { ISecret } from "aws-cdk-lib/aws-secretsmanager";

export interface RdsStackProps extends cdk.StackProps {
  enableRdsProxy?: boolean;
  primaryDatabaseName?: string;
  primaryDatabaseUsername?: string;
  retainStatefulResources?: boolean;
  /** Days of automated backups. Defaults to 7; 0 turns them off. */
  backupRetentionDays?: number;
}

export class RdsStack extends cdk.Stack {
  // Public fields are this stack's resources — `resources.rds` reads them, and
  // `linkResources(this, ...)` at the end of the constructor supplies them.
  //
  // Nothing that embeds the database password may be public. A connection URL
  // built with `secretValueFromJson("password").unsafeUnwrap()` resolves to the
  // plaintext password at deploy time, and a public string field is something a
  // workload may put in an environment variable. Hand out the secret instead
  // and let the workload read it.
  public readonly credentialsSecret: ISecret;
  public readonly proxyEndpoint: string;
  public readonly databaseEndpoint: string;
  public readonly primaryEndpoint: string;

  constructor(scope: Construct, id: string, props?: RdsStackProps) {
    super(scope, id, props);

    // RDS Proxy is optional because some accounts/plans cannot create it.
    // Default is disabled to keep the stack free-tier/account-plan friendly.
    const enableRdsProxy = props?.enableRdsProxy ?? false;
    const primaryDatabaseName = props?.primaryDatabaseName ?? "app_db";
    const primaryDatabaseUsername = props?.primaryDatabaseUsername ?? "app_user";
    const retainStatefulResources = props?.retainStatefulResources ?? false;
    const backupRetentionDays = props?.backupRetentionDays ?? 7;
    // The secret has no snapshot to take, so it keeps the plain pair. The
    // database never disappears without one: unretained, deleting it (by
    // `cdk destroy` or a replacement) leaves a final snapshot behind.
    const secretRemovalPolicy = retainStatefulResources
      ? cdk.RemovalPolicy.RETAIN
      : cdk.RemovalPolicy.DESTROY;
    const databaseRemovalPolicy = retainStatefulResources
      ? cdk.RemovalPolicy.RETAIN
      : cdk.RemovalPolicy.SNAPSHOT;

    const vpc = ec2.Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });

    const dbSecurityGroup = new ec2.SecurityGroup(
      this,
      "PostgresSecurityGroup",
      {
        vpc,
        description: "Security group for PostgreSQL instance",
        allowAllOutbound: true,
      },
    );

    const proxySecurityGroup = enableRdsProxy
      ? new ec2.SecurityGroup(this, "PostgresProxySecurityGroup", {
          vpc,
          description: "Security group for RDS Proxy",
          allowAllOutbound: true,
        })
      : undefined;

    if (proxySecurityGroup) {
      // Allow client access to the proxy so it can be used as a drop-in PostgreSQL endpoint.
      proxySecurityGroup.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(5432),
        "Allow PostgreSQL client traffic",
      );

      dbSecurityGroup.addIngressRule(
        proxySecurityGroup,
        ec2.Port.tcp(5432),
        "Allow proxy to reach PostgreSQL",
      );
    } else {
      // Deliberately open. The framework's Lambdas run outside any VPC, so they
      // reach the database over its public endpoint from addresses no CIDR can
      // name, and migrations run from a developer's machine the same way.
      // Access is guarded by the generated password and by TLS, which RDS for
      // PostgreSQL 16 enforces (rds.force_ssl=1) and which runtime/database.ts
      // verifies against the RDS CA bundle. Narrowing this needs VPC Lambdas.
      dbSecurityGroup.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(5432),
        "Allow PostgreSQL client traffic",
      );
    }

    const credentialsSecret = new rds.DatabaseSecret(
      this,
      "PostgresCredentialsSecret",
      {
        secretName: `${this.stackName}/postgres/credentials`,
        username: primaryDatabaseUsername,
        dbname: primaryDatabaseName,
        excludeCharacters: " %+~`#$&*()|[]{}:;<>?!'/@\"\\",
      },
    );
    credentialsSecret.applyRemovalPolicy(secretRemovalPolicy);

    const database = new rds.DatabaseInstance(this, "PostgresDatabase", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE3,
        ec2.InstanceSize.MICRO,
      ),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
      publiclyAccessible: true,
      credentials: rds.Credentials.fromSecret(
        credentialsSecret,
        primaryDatabaseUsername,
      ),
      databaseName: primaryDatabaseName,
      securityGroups: [dbSecurityGroup],
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      multiAz: false,
      backupRetention: cdk.Duration.days(backupRetentionDays),
      // Kept after the instance is gone, so a mistaken deletion is recoverable
      // for the retention window.
      deleteAutomatedBackups: false,
      deletionProtection: retainStatefulResources,
      removalPolicy: databaseRemovalPolicy,
    });

    const proxy = enableRdsProxy
      ? database.addProxy("PostgresProxy", {
          vpc,
          secrets: [credentialsSecret],
          securityGroups: proxySecurityGroup ? [proxySecurityGroup] : undefined,
          iamAuth: false,
          requireTLS: false,
          debugLogging: false,
        })
      : undefined;

    this.credentialsSecret = credentialsSecret;
    this.proxyEndpoint = proxy?.endpoint ?? database.instanceEndpoint.hostname;
    this.databaseEndpoint = database.instanceEndpoint.hostname;
    this.primaryEndpoint = this.proxyEndpoint;

    // Last, once every public field is assigned. This is what supplies
    // `resources.rds` — the credentials secret included, which is how a Lambda
    // reaches it as `resources.rds.credentialsSecret.arn`.
    linkResources(this, resources.rds);

    new cdk.CfnOutput(this, "RdsProxyEndpoint", {
      value: this.proxyEndpoint,
      exportName: `${this.stackName}:RdsProxyEndpoint`,
    });

    new cdk.CfnOutput(this, "RdsProxyEnabled", {
      value: String(enableRdsProxy),
      exportName: `${this.stackName}:RdsProxyEnabled`,
    });

    new cdk.CfnOutput(this, "RdsProxyPort", {
      value: "5432",
      exportName: `${this.stackName}:RdsProxyPort`,
    });

    new cdk.CfnOutput(this, "RdsDatabaseEndpoint", {
      value: this.databaseEndpoint,
      exportName: `${this.stackName}:RdsDatabaseEndpoint`,
    });

    new cdk.CfnOutput(this, "RdsPrimaryEndpoint", {
      value: this.primaryEndpoint,
      exportName: `${this.stackName}:RdsPrimaryEndpoint`,
    });

    new cdk.CfnOutput(this, "PrimaryDatabaseUrlTemplate", {
      value: `postgresql://${primaryDatabaseUsername}:<password>@${this.primaryEndpoint}:5432/${primaryDatabaseName}`,
      exportName: `${this.stackName}:PrimaryDatabaseUrlTemplate`,
    });

    new cdk.CfnOutput(this, "DirectDatabaseUrlTemplate", {
      value: `postgresql://${primaryDatabaseUsername}:<password>@${this.databaseEndpoint}:5432/${primaryDatabaseName}`,
      exportName: `${this.stackName}:DirectDatabaseUrlTemplate`,
    });

    new cdk.CfnOutput(this, "RdsCredentialsSecretArn", {
      value: credentialsSecret.secretArn,
      exportName: `${this.stackName}:RdsCredentialsSecretArn`,
    });
  }
}
