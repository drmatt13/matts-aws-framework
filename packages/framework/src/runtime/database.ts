import { writeFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { rootCertificates } from "node:tls";
import { Signer } from "@aws-sdk/rds-signer";
import { RDS_CA_BUNDLE } from "./rds-ca-bundle";
import { resolveDatabasePool } from "../database-pool";

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
  readonly max?: number;
  readonly connectionTimeoutMillis?: number;
  readonly idleTimeoutMillis?: number;
  readonly connectionString?: string;
  readonly host?: string;
  readonly port?: number;
  readonly database?: string;
  readonly user?: string;
  readonly password?: () => Promise<string>;
  readonly ssl?: { readonly ca: string; readonly rejectUnauthorized: true };
}

/** The variables `database: true` sets, read once per call. */
const selectedReaders = new Map<string, string>();
function declared(role: "writer" | "reader" = "writer"): { readonly url: URL; readonly iam: boolean } {
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
  let selected = value;
  if (role === "reader") {
    const raw = process.env.PRIMARY_DATABASE_READ_URLS;
    if (raw === undefined) throw new Error("Reader access is not declared. Declare database: { readers: true } on this workload.");
    let readers: unknown;
    try { readers = JSON.parse(raw); } catch { throw new Error("PRIMARY_DATABASE_READ_URLS must be a JSON array of PostgreSQL URLs."); }
    if (!Array.isArray(readers) || readers.some(url => {
      if (typeof url !== "string") return true;
      try { const parsed = new URL(url); return !["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname; } catch { return true; }
    })) throw new Error("PRIMARY_DATABASE_READ_URLS must be a JSON array of PostgreSQL URLs.");
    if (readers.length > 0) {
      selected = selectedReaders.get(raw) ?? readers[randomInt(readers.length)]!;
      selectedReaders.set(raw, selected);
    }
  }
  return { url: new URL(selected), iam: auth === "iam" };
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
export function databaseConnection(options: { readonly role?: "writer" | "reader" } = {}): DatabaseConnection {
  if (options.role !== undefined && !["writer", "reader"].includes(options.role)) throw new Error("Database role must be writer or reader.");
  const { url, iam } = declared(options.role);
  const rawPool = process.env.PRIMARY_DATABASE_POOL_OPTIONS;
  let pool: Pick<DatabaseConnection, "max" | "connectionTimeoutMillis" | "idleTimeoutMillis"> = {};
  if (rawPool !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(rawPool); } catch { throw new Error("PRIMARY_DATABASE_POOL_OPTIONS must be a JSON pool settings object."); }
    const settings = resolveDatabasePool(parsed as import("../database-pool").DatabasePoolSettings);
    pool = { max: settings.maxConnections, connectionTimeoutMillis: settings.connectionTimeoutMs, idleTimeoutMillis: settings.idleTimeoutMs };
  }
  if (!iam) return { connectionString: url.toString(), ...pool };
  return {
    ...pool,
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
