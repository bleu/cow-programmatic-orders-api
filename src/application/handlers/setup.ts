import { ponder } from "ponder:registry";
import { sql } from "ponder";
import { log } from "../helpers/logger";

/**
 * Creates the cow_cache schema and persistent cache tables on startup.
 *
 * The cow_cache schema is separate from Ponder's per-deployment schema, so it
 * survives `ponder start` redeployments (which create a new namespace each time).
 * Ponder's `user` pool does not restrict search_path, so fully qualified names
 * work from event handlers. The `readonly` pool used by the API layer also works
 * with fully qualified names.
 *
 * Cache semantics (enforced by consumers, not here):
 *   - Terminal states (fulfilled/expired/cancelled): cached indefinitely (cannot change)
 *   - Open orders: not cached — always re-fetched
 */
ponder.on("ComposableCow:setup", async ({ context }) => {
  // Create a separate schema that Ponder's per-deployment schema management won't touch.
  await context.db.sql.execute(sql`CREATE SCHEMA IF NOT EXISTS cow_cache`);

  // Per-UID cache of terminal order data, keyed by (chain_id, order_uid). Used by
  // both the discrete-order path (status + executed amounts) and the flash-loan
  // path (kind/receiver/intended + executed amounts). The extra flash-loan columns
  // are nullable; each consumer reads only the columns it needs, and the two UID
  // populations are disjoint. Survives reindex, so a schema-hash change does not
  // re-hit the orderbook for historical orders.
  await context.db.sql.execute(sql`
    CREATE TABLE IF NOT EXISTS cow_cache.order_uid_cache (
      chain_id              INTEGER NOT NULL,
      order_uid             TEXT NOT NULL,
      status                TEXT NOT NULL,
      fetched_at            BIGINT NOT NULL,
      executed_sell_amount   TEXT,
      executed_buy_amount    TEXT,
      kind                  TEXT,
      receiver              TEXT,
      sell_amount           TEXT,
      buy_amount            TEXT,
      PRIMARY KEY (chain_id, order_uid)
    )
  `);

  // Add the flash-loan enrichment columns to caches created before they existed.
  await context.db.sql.execute(sql`ALTER TABLE cow_cache.order_uid_cache ADD COLUMN IF NOT EXISTS kind TEXT`);
  await context.db.sql.execute(sql`ALTER TABLE cow_cache.order_uid_cache ADD COLUMN IF NOT EXISTS receiver TEXT`);
  await context.db.sql.execute(sql`ALTER TABLE cow_cache.order_uid_cache ADD COLUMN IF NOT EXISTS sell_amount TEXT`);
  await context.db.sql.execute(sql`ALTER TABLE cow_cache.order_uid_cache ADD COLUMN IF NOT EXISTS buy_amount TEXT`);

  // The flash-loan enrichment now lives in order_uid_cache — drop the short-lived
  // dedicated table if a prior build created it.
  await context.db.sql.execute(sql`DROP TABLE IF EXISTS cow_cache.flash_loan_order_cache`);

  // Log surviving cache entries — non-zero means cache persisted across restart/resync
  const result = await context.db.sql.execute(
    sql`SELECT COUNT(*)::int AS count FROM cow_cache.order_uid_cache`,
  ) as { count: number }[];
  const count = result[0]?.count ?? 0;

  log("info", "setup:cacheReady", { count, entries: `${count} entr${count === 1 ? "y" : "ies"} from previous run` });
});
