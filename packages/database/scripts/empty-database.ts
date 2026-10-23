import { createRequire } from "node:module";
import path from "node:path";

/** Metadata only. Extra user namespaces (besides normal empty public) and all
 * unmodeled objects count as occupied, including partially created control tables.
 */
export const DATABASE_EMPTY_SQL = `SELECT EXISTS (
  SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
  UNION ALL SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND t.typtype IN ('e','d')
  UNION ALL SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
  UNION ALL SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname NOT IN ('information_schema','public')
  UNION ALL SELECT 1 FROM pg_catalog.pg_largeobject_metadata
) AS occupied`;

function metadataClient(root: string, connection: string) {
  const pg = createRequire(path.join(root, "packages/database/package.json"))("pg") as { Client: new (options: { connectionString: string }) => { connect(): Promise<void>; query(sql: string): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<void> } };
  return new pg.Client({ connectionString: connection });
}
export async function acquireInitializationLock(root: string, connection: string): Promise<() => Promise<void>> {
  const client = metadataClient(root, connection);
  try {
    await client.connect();
    const result = await client.query("SELECT pg_try_advisory_lock(4590, 1) AS acquired");
    if (result.rows[0]?.acquired !== true) throw new Error("Another Studio session is initializing this database. Wait, then inspect it again.");
    return async () => { try { await client.query("SELECT pg_advisory_unlock(4590, 1)"); } finally { await client.end(); } };
  } catch (error) { await client.end(); throw error; }
}
export async function isDatabaseEmpty(root: string, connection: string): Promise<boolean> {
  const client = metadataClient(root, connection);
  try { await client.connect(); return (await client.query(DATABASE_EMPTY_SQL)).rows[0]?.occupied === false; }
  finally { await client.end(); }
}
