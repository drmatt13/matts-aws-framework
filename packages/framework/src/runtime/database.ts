import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rootCertificates } from "node:tls";
import { Signer } from "@aws-sdk/rds-signer";
import { RDS_CA_BUNDLE } from "./rds-ca-bundle";

/**
 * How a workload that declares `database: true` reaches the database.
 *
 * The framework hands it `PRIMARY_DATABASE_URL`, and in AWS also
 * `PRIMARY_DATABASE_AUTH=iam`. Deployed, the URL names the database's IAM
 * login and carries no password: each new connection signs a fresh IAM token
 * with the workload's own role instead, which takes no network call and no
 * secret. Locally, the URL is the Compose Postgres, password included. A
 * handler never branches on which it got:
 *
 * ```ts
 * const database = getDatabase(databaseConnection());
 * ```
 */

/**
 * Connection settings in the shape a `pg` pool takes. `password` is a function
 * in AWS: a token is good for new connections for 15 minutes, so the pool asks
 * for one each time it opens a connection rather than holding one.
 */
export interface DatabaseConnection {
  readonly connectionString?: string;
  readonly host?: string;
  readonly port?: number;
  readonly database?: string;
  readonly user?: string;
  readonly password?: () => Promise<string>;
  readonly ssl?: { readonly ca: string; readonly rejectUnauthorized: true };
}

/** The variables `database: true` sets, read once per call. */
function declared(): { readonly url: URL; readonly iam: boolean } {
  const value = process.env.PRIMARY_DATABASE_URL;
  if (!value) {
    throw new Error(
      "PRIMARY_DATABASE_URL is not set. The framework sets it on a workload that declares database: true; declare it on this one.",
    );
  }
  const auth = process.env.PRIMARY_DATABASE_AUTH;
  if (auth !== undefined && auth !== "iam") {
    throw new Error(`PRIMARY_DATABASE_AUTH is "${auth}". The framework sets it to "iam" or leaves it unset.`);
  }
  return { url: new URL(value), iam: auth === "iam" };
}

let trustedAuthorities: string | undefined;

/**
 * The CAs a deployed connection is verified against: the RDS bundle that signs
 * instance endpoints, plus Node's public roots. Supplying `ca` replaces Node's
 * default trust store rather than adding to it, so both go in.
 */
function databaseAuthorities(): string {
  trustedAuthorities ??= [RDS_CA_BUNDLE, ...rootCertificates].join("\n");
  return trustedAuthorities;
}

/** One signer per login, kept for the life of the execution environment. */
const signers = new Map<string, Signer>();

/** Signs an IAM token for the login a deployed URL names. Local, no network call. */
function iamToken(url: URL): Promise<string> {
  const region = process.env.AWS_REGION;
  if (!region) throw new Error("AWS_REGION is not set, so no IAM token can be signed for the database.");
  const hostname = url.hostname;
  const port = Number(url.port || 5432);
  const username = decodeURIComponent(url.username);
  const key = `${username}@${hostname}:${port}`;
  let signer = signers.get(key);
  if (!signer) {
    signer = new Signer({ hostname, port, username, region });
    signers.set(key, signer);
  }
  return signer.getAuthToken();
}

/**
 * Settings for a `pg` pool to the database this workload declared. In AWS,
 * TLS is verified against the RDS certificate authorities and every new
 * connection authenticates with a token it signs itself.
 */
export function databaseConnection(): DatabaseConnection {
  const { url, iam } = declared();
  if (!iam) return { connectionString: url.toString() };
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    database: decodeURIComponent(url.pathname.slice(1)),
    user: decodeURIComponent(url.username),
    password: () => iamToken(url),
    ssl: { ca: databaseAuthorities(), rejectUnauthorized: true },
  };
}

let trustStoreFile: string | undefined;

/** The same authorities as a file, for a tool that only takes a URL. */
function databaseTrustStore(): string {
  if (trustStoreFile) return trustStoreFile;
  const file = path.join(tmpdir(), "framework-database-ca.pem");
  writeFileSync(file, databaseAuthorities());
  trustStoreFile = file;
  return file;
}

/**
 * A connection URL, for a tool that takes nothing else, such as the Prisma
 * CLI applying migrations. In AWS its password is a fresh IAM token, good for
 * opening connections for 15 minutes: ask again rather than keeping it.
 */
export async function databaseUrl(): Promise<string> {
  const { url, iam } = declared();
  if (!iam) return url.toString();
  const signed = new URL(url);
  signed.password = encodeURIComponent(await iamToken(url));
  signed.searchParams.set("sslmode", "verify-full");
  signed.searchParams.set("sslrootcert", databaseTrustStore());
  return signed.toString();
}
