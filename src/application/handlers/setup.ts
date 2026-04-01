import { ponder } from "ponder:registry";
import { sql } from "ponder";

/**
 * Creates the orderbook_cache table on startup.
 *
 * This table is intentionally NOT exported from ponder.schema.ts — Ponder drops
 * all schema-exported tables on full resync, which would flush the cache mid-sync.
 * Using raw DDL here ensures the cache persists across resyncs.
 *
 * Cache TTL semantics (enforced by consumers, not here):
 *   - Terminal states (fulfilled/expired/cancelled): indefinite
 *   - Open orders: 60–300 seconds
 */
ponder.on("ComposableCow:setup", async ({ context }) => {
  await context.db.sql.execute(sql`
    CREATE TABLE IF NOT EXISTS orderbook_cache (
      cache_key     TEXT PRIMARY KEY,
      response_json TEXT NOT NULL,
      fetched_at    BIGINT NOT NULL,
      expires_at    BIGINT NOT NULL
    )
  `);
});
