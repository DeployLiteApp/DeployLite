import type { Pool, PoolClient } from "pg";
/** pg-pool may resolve end() before idle clients emit remove after their socket ends. */
export function trackPostgresFixtureShutdown(pool: Pick<Pool, "on" | "end">): () => Promise<void> {
  const clients = new Set<PoolClient>();
  let notify: (() => void) | undefined;
  pool.on("connect", client => { clients.add(client); });
  pool.on("remove", client => { clients.delete(client); if (clients.size === 0) notify?.(); });
  return async () => {
    const disconnected = new Promise<void>(resolve => { notify = resolve; if (clients.size === 0) resolve(); });
    await pool.end();
    await disconnected;
  };
}
