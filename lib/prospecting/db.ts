import type { Pool, PoolClient } from "pg";

import { createPool } from "@/lib/agent-engine/db/pool";

let pool: Pool | undefined;
export function prospectingPool(): Pool {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("prospecting_database_unavailable");
  return (pool ??= createPool(url));
}

export async function prospectingTransaction<T>(
  org: string,
  run: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await prospectingPool().connect();
  try {
    await db.query("begin");
    await db.query("set local statement_timeout = '15s'");
    await db.query("set local lock_timeout = '5s'");
    // Todas as identidades (telefone, empresa, site, external_id) serializam juntas.
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,263))", [org]);
    const result = await run(db);
    await db.query("commit");
    return result;
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    db.release();
  }
}
