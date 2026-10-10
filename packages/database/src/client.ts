import pg from "pg";
import postgres from "@prisma/orm-postgres/runtime";
import contractJson from "./generated/contract.json" with { type: "json" };
import type { Contract } from "./generated/contract.js";

/**
 * The only place the Prisma runtime is bound. Everything above this file speaks
 * the ORM-neutral contract in `contracts.ts`.
 */
export type DatabaseClient = ReturnType<typeof postgres<Contract>>;

/** Pool settings: a connection string locally, an IAM-signing password in AWS. */
export type DatabaseConnection = pg.PoolConfig;

/**
 * One pool, owned here rather than by the runtime: the runtime builds its own
 * only from a URL, and a URL cannot carry a password that is signed per
 * connection. Timeouts match the ones the runtime would have chosen.
 */
export function createClient(connection: DatabaseConnection): { client: DatabaseClient; close(): Promise<void> } {
  const pool = new pg.Pool({ connectionTimeoutMillis: 20_000, idleTimeoutMillis: 30_000, ...connection });
  // An idle connection the server drops emits on the pool; unhandled, that
  // event would end the process. The next query opens a new connection.
  pool.on("error", (error) => console.warn("An idle database connection closed:", error.message));
  const client = postgres<Contract>({ pg: pool, contractJson });
  return {
    client,
    close: async () => {
      await client.close();
      await pool.end();
    },
  };
}
