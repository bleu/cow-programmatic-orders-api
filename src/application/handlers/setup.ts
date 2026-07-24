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
 *   - Terminal states (fulfilled/expired/cancelled): cached, but only trusted
 *     permanently once provably beyond the chain's reorg window — see
 *     src/application/helpers/orderbook/trust.ts (COW-1183). Until then the
 *     row is "soft" and keeps being re-fetched, so reorged statuses heal.
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
      executed_fee    TEXT,
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
  await context.db.sql.execute(sql`ALTER TABLE cow_cache.order_uid_cache ADD COLUMN IF NOT EXISTS executed_fee TEXT`);

  // Reorg-safety / healing columns (COW-1183):
  //   valid_to       — upper bound on execution time; proves finality once
  //                    older than the chain's reorg window
  //   terminal_since — wall-clock first observation of the terminal status;
  //                    anchors the cooling-off rule for future-validTo orders
  //   cache_version  — rows below CACHE_VERSION are re-fetched lazily (healing)
  await context.db.sql.execute(sql`ALTER TABLE cow_cache.order_uid_cache ADD COLUMN IF NOT EXISTS valid_to INTEGER`);
  await context.db.sql.execute(sql`ALTER TABLE cow_cache.order_uid_cache ADD COLUMN IF NOT EXISTS terminal_since BIGINT`);
  await context.db.sql.execute(sql`ALTER TABLE cow_cache.order_uid_cache ADD COLUMN IF NOT EXISTS cache_version INTEGER`);

  // The flash-loan enrichment now lives in order_uid_cache — drop the short-lived
  // dedicated table if a prior build created it.
  await context.db.sql.execute(sql`DROP TABLE IF EXISTS cow_cache.flash_loan_order_cache`);

  // Durable per-owner composable-order rows, keyed by (chain_id, order_uid). Unlike
  // order_uid_cache (per-UID terminal status only), this holds every field needed to
  // rebuild a discreteOrder row without re-hitting the orderbook — so OwnerBackfill
  // drains only the delta newer than MAX(creation_date) on each redeploy instead of
  // the owner's full history. generator_hash (not the per-deployment eventId) is stored
  // so rows survive reindex and re-map to the current generator by hash.
  await context.db.sql.execute(sql`
    CREATE TABLE IF NOT EXISTS cow_cache.composable_order (
      chain_id              INTEGER NOT NULL,
      order_uid             TEXT NOT NULL,
      owner                 TEXT NOT NULL,
      generator_hash        TEXT NOT NULL,
      order_type            TEXT NOT NULL,
      status                TEXT NOT NULL,
      sell_amount           TEXT NOT NULL,
      buy_amount            TEXT NOT NULL,
      fee_amount            TEXT NOT NULL,
      valid_to              INTEGER,
      creation_date         BIGINT NOT NULL,
      executed_sell_amount   TEXT,
      executed_buy_amount    TEXT,
      executed_fee    TEXT,
      fetched_at            BIGINT NOT NULL,
      PRIMARY KEY (chain_id, order_uid)
    )
  `);
  await context.db.sql.execute(sql`ALTER TABLE cow_cache.composable_order ADD COLUMN IF NOT EXISTS executed_fee TEXT`);
  await context.db.sql.execute(sql`ALTER TABLE cow_cache.composable_order ADD COLUMN IF NOT EXISTS terminal_since BIGINT`);
  await context.db.sql.execute(sql`ALTER TABLE cow_cache.composable_order ADD COLUMN IF NOT EXISTS cache_version INTEGER`);

  // One-off idempotent backfill for rows written before the reorg-safety
  // columns existed. terminal_since ≈ fetched_at is slightly generous (the
  // status may be older), which only errs toward extra re-polling; truly old
  // rows are covered by the valid_to fast path anyway. Pre-executed_fee
  // fulfilled rows get version 0 so the lazy-healing path re-fetches them
  // (replaces the old executedFee-is-null special case).
  await context.db.sql.execute(sql`
    UPDATE cow_cache.order_uid_cache
    SET terminal_since = fetched_at
    WHERE terminal_since IS NULL
  `);
  await context.db.sql.execute(sql`
    UPDATE cow_cache.order_uid_cache
    SET cache_version = CASE WHEN status = 'fulfilled' AND executed_fee IS NULL THEN 0 ELSE 1 END
    WHERE cache_version IS NULL
  `);
  await context.db.sql.execute(sql`
    UPDATE cow_cache.composable_order
    SET terminal_since = fetched_at
    WHERE terminal_since IS NULL AND status IN ('fulfilled', 'expired', 'cancelled')
  `);
  await context.db.sql.execute(sql`
    UPDATE cow_cache.composable_order
    SET cache_version = CASE WHEN status = 'fulfilled' AND executed_fee IS NULL THEN 0 ELSE 1 END
    WHERE cache_version IS NULL
  `);
  await context.db.sql.execute(sql`
    CREATE INDEX IF NOT EXISTS composable_order_owner_idx
      ON cow_cache.composable_order (chain_id, owner)
  `);

  // Per-owner drain state for OwnerBackfillLive. Progress is recorded here explicitly,
  // never derived from cached rows (deriving a cursor from MAX(creation_date) conflates
  // "I cached this" with "I cached everything older than this" — a partial drain would
  // look complete and leave a permanent hole in the owner's history).
  //   next_offset     — where the initial full drain resumes /account pagination
  //   fully_drained   — a full pass reached the last page at least once
  //   delta_cursor    — newest creation_date covered by a complete pass; only read when
  //                     fully_drained, only advanced by a complete delta pass
  //   last_attempt_at — stamped at attempt start; drives least-recently-attempted rotation
  await context.db.sql.execute(sql`
    CREATE TABLE IF NOT EXISTS cow_cache.owner_drain (
      chain_id        INTEGER NOT NULL,
      owner           TEXT NOT NULL,
      next_offset     INTEGER NOT NULL DEFAULT 0,
      fully_drained   BOOLEAN NOT NULL DEFAULT FALSE,
      delta_cursor    BIGINT,
      last_attempt_at BIGINT,
      PRIMARY KEY (chain_id, owner)
    )
  `);

  // Log surviving cache entries — non-zero means cache persisted across restart/resync
  const result = await context.db.sql.execute(
    sql`SELECT COUNT(*)::int AS count FROM cow_cache.order_uid_cache`,
  ) as { count: number }[];
  const count = result[0]?.count ?? 0;

  log("info", "setup:cacheReady", { count, entries: `${count} entr${count === 1 ? "y" : "ies"} from previous run` });
});
