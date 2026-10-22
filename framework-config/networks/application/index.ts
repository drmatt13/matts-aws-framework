import { defineNetwork } from "@repo/framework/config";

/**
 * The application's original VPC. Import it explicitly on each consumer.
 *
 * Built only by a production deployment (-c prodDeployment=true), and only once a
 * workload is placed in it: a Lambda with subnet: "private" or "isolated" (see
 * defaults.lambda.subnet) or database: true, or any container. A dev deployment
 * never builds it: the database runs under Compose, where the local lane
 * enforces the same rules.
 *
 * Every zone has a public, a private and an isolated subnet. Public subnets
 * reach the internet directly (a container there has its own public IPv4).
 * Private subnets leave only as declared below. Isolated subnets never leave:
 * they reach the database and the endpoints, nothing else.
 */
export const applicationVpc = defineNetwork({
  id: "application",
  tags: { area: "platform" },
  cloud: { constructId: "NetworkStack" },
  // Set once: changing either renumbers every subnet and replaces everything
  // inside them.
  cidr: "10.0.0.0/16",
  zones: 2,

  // How the private subnets reach the internet.
  //
  // IPv6, through an egress-only internet gateway: free, and nothing can
  // connect in through it. A Lambda in the private subnets then calls AWS's
  // dual-stack endpoints, which reach Cognito, Secrets Manager and most AWS
  // APIs.
  egressOnlyInternetGateway: true,
  // IPv4, through one NAT gateway: about $33 a month plus $0.045 per GB. A
  // container in a private subnet needs it (or the interface endpoints below),
  // because Fargate pulls its image over IPv4.
  natGateway: false,

  // S3 and DynamoDB on every route table, free: their traffic never leaves the
  // VPC.
  gatewayEndpoints: { s3: true, dynamodb: true },

  // PrivateLink endpoints, about $7.30 a month per zone each plus $0.01 per
  // GB: one AWS service, reached privately with no gateway, by its endpoint
  // name (com.amazonaws.<region>.<name>). The alternative to a NAT gateway when
  // only AWS services need IPv4, and the only way out of the isolated subnets.
  // A private container without a NAT gateway needs "ecr.api", "ecr.dkr" and
  // "logs" (plus "secretsmanager" if it takes secrets); three endpoints in two
  // zones cost more than the NAT gateway does.
  interfaceEndpoints: [],
});
