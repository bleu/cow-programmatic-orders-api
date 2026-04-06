import { ponder } from "ponder:registry";
import { sql } from "ponder";

/**
 * Creates the cow_cache schema and orderbook_cache table on startup.
 *
 * The cow_cache schema is separate from Ponder's per-deployment schema, so it
 * survives `ponder start` redeployments (which create a new namespace each time).
 * Ponder's `user` pool does not restrict search_path, so fully qualified names
 * (cow_cache.orderbook_cache) work from event handlers. The `readonly` pool used
 * by the API layer also works with fully qualified names.
 *
 * Cache semantics (enforced by consumers, not here):
 *   - Terminal states (fulfilled/expired/cancelled): cached indefinitely (cannot change)
 *   - Open orders: not cached — always re-fetched
 */
ponder.on("ComposableCow:setup", async ({ context }) => {
  // Create a separate schema that Ponder's per-deployment schema management won't touch.
  await context.db.sql.execute(sql`CREATE SCHEMA IF NOT EXISTS cow_cache`);

  await context.db.sql.execute(sql`
    CREATE TABLE IF NOT EXISTS cow_cache.orderbook_cache (
      cache_key     TEXT PRIMARY KEY,
      response_json TEXT NOT NULL,
      fetched_at    BIGINT NOT NULL
    )
  `);

  // Log surviving cache entries — non-zero means cache persisted across restart/resync
  const result = await context.db.sql.execute(
    sql`SELECT COUNT(*)::int AS count FROM cow_cache.orderbook_cache`,
  ) as { count: number }[];
  const count = result[0]?.count ?? 0;

  console.log(
    `[COW:SETUP] cow_cache.orderbook_cache ready — ${count} entr${count === 1 ? "y" : "ies"} from previous run`,
  );
});
