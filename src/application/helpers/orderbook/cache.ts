import { and, eq, inArray, sql } from "ponder";
import type { Context } from "ponder:registry";
import { pgSchema, integer, text, bigint } from "drizzle-orm/pg-core";
import { type Hex } from "viem";
import { log } from "../logger";
import {
  type CachedOrderData,
  type ComposableCacheRow,
  type ComposableOrder,
  type FlashLoanEnrichment,
} from "./types";

/** Project a freshly-decoded ComposableOrder into the durable-cache row shape. */
export function toCacheRow(o: ComposableOrder): ComposableCacheRow {
  return {
    orderUid: o.uid,
    generatorHash: o.generatorHash,
    orderType: o.orderType,
    status: o.status,
    sellAmount: o.sellAmount,
    buyAmount: o.buyAmount,
    feeAmount: o.feeAmount,
    validTo: o.validTo ?? null,
    creationDate: o.creationDate,
    executedSellAmount: o.executedSellAmount ?? null,
    executedBuyAmount: o.executedBuyAmount ?? null,
    executedFeeAmount: o.executedFeeAmount ?? null,
  };
}

// ─── Per-UID cache helpers ──────────────────────────────────────────────────
// cow_cache.order_uid_cache is created by setup.ts. One per-UID cache of terminal
// order data, shared by the discrete path (status + executed amounts) and the
// flash-loan path (kind/receiver/intended + executed amounts). The flash-loan
// columns are nullable; the two UID populations are disjoint.
const cowCacheSchema = pgSchema("cow_cache");

// Durable full composable-order rows (survives reindex). See setup.ts for the DDL.
const composableOrderCache = cowCacheSchema.table("composable_order", {
  chainId: integer("chain_id").notNull(),
  orderUid: text("order_uid").notNull(),
  owner: text("owner").notNull(),
  generatorHash: text("generator_hash").notNull(),
  orderType: text("order_type").notNull(),
  status: text("status").notNull(),
  sellAmount: text("sell_amount").notNull(),
  buyAmount: text("buy_amount").notNull(),
  feeAmount: text("fee_amount").notNull(),
  validTo: integer("valid_to"),
  creationDate: bigint("creation_date", { mode: "bigint" }).notNull(),
  executedSellAmount: text("executed_sell_amount"),
  executedBuyAmount: text("executed_buy_amount"),
  executedFeeAmount: text("executed_fee_amount"),
  fetchedAt: bigint("fetched_at", { mode: "bigint" }).notNull(),
});

const orderUidCache = cowCacheSchema.table("order_uid_cache", {
  chainId: integer("chain_id").notNull(),
  orderUid: text("order_uid").notNull(),
  status: text("status").notNull(),
  fetchedAt: integer("fetched_at").notNull(),
  executedSellAmount: text("executed_sell_amount"),
  executedBuyAmount: text("executed_buy_amount"),
  executedFeeAmount: text("executed_fee_amount"),
  kind: text("kind"),
  receiver: text("receiver"),
  sellAmount: text("sell_amount"),
  buyAmount: text("buy_amount"),
});

/** Read cached flash-loan enrichment for a list of UIDs. */
export async function getCachedFlashLoanEnrichment(
  context: Context,
  chainId: number,
  uids: string[],
): Promise<Map<string, FlashLoanEnrichment>> {
  const result = new Map<string, FlashLoanEnrichment>();
  if (uids.length === 0) return result;

  try {
    const batchSize = 500;
    for (let i = 0; i < uids.length; i += batchSize) {
      const batch = uids.slice(i, i + batchSize);
      const rows = await context.db.sql
        .select({
          orderUid: orderUidCache.orderUid,
          receiver: orderUidCache.receiver,
          kind: orderUidCache.kind,
          sellAmount: orderUidCache.sellAmount,
          buyAmount: orderUidCache.buyAmount,
          executedSellAmount: orderUidCache.executedSellAmount,
          executedBuyAmount: orderUidCache.executedBuyAmount,
        })
        .from(orderUidCache)
        .where(
          and(
            eq(orderUidCache.chainId, chainId),
            inArray(orderUidCache.orderUid, batch),
          ),
        );
      for (const row of rows) {
        // Skip discrete rows that lack enrichment (kind/amounts null). In practice
        // the UID sets are disjoint, so this only guards against accidental overlap.
        if (row.kind == null || row.sellAmount == null || row.buyAmount == null) continue;
        result.set(row.orderUid, {
          receiver: row.receiver,
          kind: row.kind as "sell" | "buy",
          sellAmount: row.sellAmount,
          buyAmount: row.buyAmount,
          executedSellAmount: row.executedSellAmount ?? "0",
          executedBuyAmount: row.executedBuyAmount ?? "0",
        });
      }
    }
  } catch {
    // Cache miss on error — will re-fetch from API
  }

  return result;
}

/**
 * Persist flash-loan enrichment into the shared cache (terminal, so cached
 * indefinitely). status is set to "fulfilled" to satisfy the shared NOT NULL
 * column — flash-loan orders are settled by definition.
 */
export async function cacheFlashLoanEnrichment(
  context: Context,
  chainId: number,
  entries: { uid: string; enrichment: FlashLoanEnrichment }[],
): Promise<void> {
  if (entries.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  try {
    await context.db.sql
      .insert(orderUidCache)
      .values(
        entries.map(({ uid, enrichment }) => ({
          chainId,
          orderUid: uid,
          status: "fulfilled",
          receiver: enrichment.receiver,
          kind: enrichment.kind,
          sellAmount: enrichment.sellAmount,
          buyAmount: enrichment.buyAmount,
          executedSellAmount: enrichment.executedSellAmount,
          executedBuyAmount: enrichment.executedBuyAmount,
          fetchedAt: now,
        })),
      )
      .onConflictDoNothing();
  } catch (err) {
    log("warn", "ob:flashLoanCacheWriteFailed", { chainId, entries: entries.length, err: String(err) });
  }
}

/** Get cached data for a list of UIDs. Returns a Map of uid -> CachedOrderData. */
export async function getCachedUidStatuses(
  context: Context,
  chainId: number,
  uids: string[],
): Promise<Map<string, CachedOrderData>> {
  const result = new Map<string, CachedOrderData>();
  if (uids.length === 0) return result;

  try {
    // Query in batches to avoid overly long IN clauses
    const batchSize = 500;
    for (let i = 0; i < uids.length; i += batchSize) {
      const batch = uids.slice(i, i + batchSize);
      const rows = await context.db.sql
        .select({
          orderUid: orderUidCache.orderUid,
          status: orderUidCache.status,
          executedSellAmount: orderUidCache.executedSellAmount,
          executedBuyAmount: orderUidCache.executedBuyAmount,
          executedFeeAmount: orderUidCache.executedFeeAmount,
        })
        .from(orderUidCache)
        .where(
          and(
            eq(orderUidCache.chainId, chainId),
            inArray(orderUidCache.orderUid, batch),
          ),
        );
      for (const row of rows) {
        result.set(row.orderUid, {
          status: row.status,
          executedSellAmount: row.executedSellAmount,
          executedBuyAmount: row.executedBuyAmount,
          executedFeeAmount: row.executedFeeAmount,
        });
      }
    }
  } catch {
    // Cache miss on error — will re-fetch from API
  }

  return result;
}

/** Cache terminal statuses and executed amounts for composable orders. */
export async function cacheUidStatuses(
  context: Context,
  chainId: number,
  orders: ComposableOrder[],
): Promise<void> {
  if (orders.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  try {
    // One multi-row upsert instead of N individual roundtrips.
    await context.db.sql
      .insert(orderUidCache)
      .values(orders.map((order) => ({
        chainId,
        orderUid: order.uid,
        status: order.status,
        fetchedAt: now,
        executedSellAmount: order.executedSellAmount,
        executedBuyAmount: order.executedBuyAmount,
        executedFeeAmount: order.executedFeeAmount,
      })))
      .onConflictDoUpdate({
        target: [orderUidCache.chainId, orderUidCache.orderUid],
        set: {
          status: sql`excluded.status`,
          fetchedAt: now,
          executedSellAmount: sql`excluded.executed_sell_amount`,
          executedBuyAmount: sql`excluded.executed_buy_amount`,
          executedFeeAmount: sql`excluded.executed_fee_amount`,
        },
      });
  } catch {
    // Best-effort cache write
  }
}

// ─── Durable composable-order cache helpers ───────────────────────────────────
// cow_cache.composable_order (created in setup.ts) holds full composable-order rows
// keyed by (chain_id, order_uid), so the backfill drains only the delta newer than
// MAX(creation_date) per owner instead of the full history on each reindex.

/** Newest creation_date already cached for this owner (Unix seconds), or undefined
 *  when nothing is cached — the signal to do a full-history drain. */
export async function readOwnerBackfillCursor(
  context: Context,
  chainId: number,
  owner: Hex,
): Promise<number | undefined> {
  try {
    const rows = (await context.db.sql
      .select({ cursor: sql<string | null>`max(${composableOrderCache.creationDate})` })
      .from(composableOrderCache)
      .where(
        and(
          eq(composableOrderCache.chainId, chainId),
          eq(composableOrderCache.owner, owner.toLowerCase()),
        ),
      )) as { cursor: string | null }[];
    const raw = rows[0]?.cursor;
    return raw == null ? undefined : Number(raw);
  } catch {
    return undefined; // no cache table / error → full drain
  }
}

/** All durably-cached composable rows for an owner. */
export async function readOwnerComposableCache(
  context: Context,
  chainId: number,
  owner: Hex,
): Promise<ComposableCacheRow[]> {
  try {
    return (await context.db.sql
      .select({
        orderUid: composableOrderCache.orderUid,
        generatorHash: composableOrderCache.generatorHash,
        orderType: composableOrderCache.orderType,
        status: composableOrderCache.status,
        sellAmount: composableOrderCache.sellAmount,
        buyAmount: composableOrderCache.buyAmount,
        feeAmount: composableOrderCache.feeAmount,
        validTo: composableOrderCache.validTo,
        creationDate: composableOrderCache.creationDate,
        executedSellAmount: composableOrderCache.executedSellAmount,
        executedBuyAmount: composableOrderCache.executedBuyAmount,
        executedFeeAmount: composableOrderCache.executedFeeAmount,
      })
      .from(composableOrderCache)
      .where(
        and(
          eq(composableOrderCache.chainId, chainId),
          eq(composableOrderCache.owner, owner.toLowerCase()),
        ),
      )) as ComposableCacheRow[];
  } catch {
    return [];
  }
}

/** Upsert durable composable rows; excluded status/validTo/executed overwrite on conflict. */
export async function upsertComposableCache(
  context: Context,
  chainId: number,
  owner: Hex,
  rows: ComposableCacheRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const now = BigInt(Math.floor(Date.now() / 1000));
  try {
    await context.db.sql
      .insert(composableOrderCache)
      .values(rows.map((r) => ({
        chainId,
        orderUid: r.orderUid,
        owner: owner.toLowerCase(),
        generatorHash: r.generatorHash,
        orderType: r.orderType,
        status: r.status,
        sellAmount: r.sellAmount,
        buyAmount: r.buyAmount,
        feeAmount: r.feeAmount,
        validTo: r.validTo,
        creationDate: r.creationDate,
        executedSellAmount: r.executedSellAmount,
        executedBuyAmount: r.executedBuyAmount,
        executedFeeAmount: r.executedFeeAmount,
        fetchedAt: now,
      })))
      .onConflictDoUpdate({
        target: [composableOrderCache.chainId, composableOrderCache.orderUid],
        set: {
          status: sql`excluded.status`,
          validTo: sql`excluded.valid_to`,
          executedSellAmount: sql`excluded.executed_sell_amount`,
          executedBuyAmount: sql`excluded.executed_buy_amount`,
          executedFeeAmount: sql`excluded.executed_fee_amount`,
          fetchedAt: now,
        },
      });
  } catch (err) {
    log("warn", "ob:composableCacheWriteFailed", { chainId, rows: rows.length, err: String(err) });
  }
}
