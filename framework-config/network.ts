import { defineNetwork } from "@repo/framework/config";

/**
 * The application's VPC.
 *
 * Built only by a production deployment (PROD_DEPLOYMENT=true), and only once a
 * workload needs it: a Lambda with `vpc: true` or `database: true`, or a
 * container. A dev deployment never builds it: the database runs under
 * Compose, where the local lane enforces the same rules.
 *
 * A Lambda runs in its private subnets when it has `vpc: true` (see
 * defaults.lambda.vpc) or declares `database: true`; every other Lambda runs
 * outside it, with the whole internet.
 *
 * cidr and zones are set once: changing either renumbers every subnet.
 *
 * nat is the network's only cost. Off, the private subnets leave over IPv6
 * only, through an egress-only gateway that is free: enough for a Lambda to
 * reach Cognito, Secrets Manager and the AWS APIs, and nothing more. On, one
 * NAT gateway (about $33 a month plus $0.045 per GB) gives them IPv4 too,
 * which a container needs to run in a private subnet.
 */
export const network = defineNetwork({ cidr: "10.0.0.0/16", zones: 2, nat: false });
