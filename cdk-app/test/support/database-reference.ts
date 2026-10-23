import type { DatabaseReference } from "../../lib/app/database-lifecycle";

/** Synthetic physical identities; this fixture never contacts AWS. */
export const databaseReference: DatabaseReference = {
  strategy: "reference", account: "111122223333", region: "us-east-1", sourceDeployment: "original", sourceMode: "prod",
  sourceStackId: "arn:aws:cloudformation:us-east-1:111122223333:stack/original-RdsStack/00000000-0000-0000-0000-000000000000",
  instanceIdentifier: "original-postgres", instanceResourceId: "db-ABCDEFGHIJKLMNOPQRSTUV1234",
  endpoint: "original-postgres.abcdefghijkl.us-east-1.rds.amazonaws.com", port: 5432, databaseName: "app_db",
  engine: "postgres", engineVersion: "16.4", iamAuthentication: true, storageEncrypted: true, iamLogin: "app_user",
  kmsKeyArn: "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001",
  masterSecretArn: "arn:aws:secretsmanager:us-east-1:111122223333:secret:original-postgres-abcdef",
  securityGroupIds: ["sg-0123456789abcdef0"],
  network: {
    vpcId: "vpc-0123456789abcdef0", vpcCidrBlock: "10.0.0.0/16", availabilityZones: ["us-east-1a", "us-east-1b"],
    publicSubnetIds: ["subnet-00000000000000001", "subnet-00000000000000002"],
    privateSubnetIds: ["subnet-00000000000000003", "subnet-00000000000000004"],
    isolatedSubnetIds: ["subnet-00000000000000005", "subnet-00000000000000006"],
    publicSubnetRouteTableIds: ["rtb-00000000000000001", "rtb-00000000000000002"],
    privateSubnetRouteTableIds: ["rtb-00000000000000003", "rtb-00000000000000004"],
    isolatedSubnetRouteTableIds: ["rtb-00000000000000005", "rtb-00000000000000006"],
  },
};
