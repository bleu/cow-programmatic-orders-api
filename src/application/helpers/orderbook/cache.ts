import { and, eq, inArray, sql } from "ponder";
import type { Context } from "ponder:registry";
import { pgSchema, integer, text, bigint, boolean } from "drizzle-orm/pg-core";
import { type Hex } from "viem";
import { UPSERT_CHUNK_SIZE } from "../../../constants";
import { log } from "../logger";
import {
  type CachedOrderData,
  type ComposableCacheRow,
  type ComposableOrder,
  type FlashLoanEnrichment,
} from "./types";

/** Project a freshly-decoded ComposableOrder into the durable-cache row shape.
 *  The cache tables store amounts as TEXT — bigints convert at this boundary. */
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
    executedSellAmount: o.executedSellAmount?.toString() ?? null,
    executedBuyAmount: o.executedBuyAmount?.toString() ?? null,
    executedFee: o.executedFee?.toString() ?? null,
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
  executedFee: text("executed_fee"),
  fetchedAt: bigint("fetched_at", { mode: "bigint" }).notNull(),
});

// Per-owner drain state for OwnerBackfillLive (see setup.ts for the DDL and the
// rationale). Progress is recorded explicitly, never derived from cached rows.
export const ownerDrain = cowCacheSchema.table("owner_drain", {
  chainId: integer("chain_id").notNull(),
  owner: text("owner").notNull(),
  nextOffset: integer("next_offset").notNull(),
  fullyDrained: boolean("fully_drained").notNull(),
  deltaCursor: bigint("delta_cursor", { mode: "number" }),
  lastAttemptAt: bigint("last_attempt_at", { mode: "number" }),
});

const orderUidCache = cowCacheSchema.table("order_uid_cache", {
  chainId: integer("chain_id").notNull(),
  orderUid: text("order_uid").notNull(),
  status: text("status").notNull(),
  fetchedAt: integer("fetched_at").notNull(),
  executedSellAmount: text("executed_sell_amount"),
  executedBuyAmount: text("executed_buy_amount"),
  executedFee: text("executed_fee"),
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
          executedFee: orderUidCache.executedFee,
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
          executedFee: row.executedFee,
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
        executedSellAmount: order.executedSellAmount?.toString() ?? null,
        executedBuyAmount: order.executedBuyAmount?.toString() ?? null,
        executedFee: order.executedFee?.toString() ?? null,
      })))
      .onConflictDoUpdate({
        target: [orderUidCache.chainId, orderUidCache.orderUid],
        set: {
          status: sql`excluded.status`,
          fetchedAt: now,
          executedSellAmount: sql`excluded.executed_sell_amount`,
          executedBuyAmount: sql`excluded.executed_buy_amount`,
          executedFee: sql`excluded.executed_fee`,
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

// ─── Owner drain state ────────────────────────────────────────────────────────
// One row per (chain_id, owner) in cow_cache.owner_drain. All writes are
// best-effort (logged, swallowed): losing a write only causes harmless overlap —
// the drain re-fetches a page or re-drains an owner, and every downstream write
// is an idempotent upsert. Gaps are impossible because state only ever advances
// after the data it covers has been persisted.

export interface OwnerDrainState {
  nextOffset: number;
  fullyDrained: boolean;
  deltaCursor: number | undefined;
}

const FRESH_DRAIN_STATE: OwnerDrainState = {
  nextOffset: 0,
  fullyDrained: false,
  deltaCursor: undefined,
};

/** Drain state for an owner; fresh (offset 0, not drained) when no row exists. */
export async function readOwnerDrainState(
  context: Context,
  chainId: number,
  owner: Hex,
): Promise<OwnerDrainState> {
  try {
    const rows = await context.db.sql
      .select({
        nextOffset: ownerDrain.nextOffset,
        fullyDrained: ownerDrain.fullyDrained,
        deltaCursor: ownerDrain.deltaCursor,
      })
      .from(ownerDrain)
      .where(and(eq(ownerDrain.chainId, chainId), eq(ownerDrain.owner, owner.toLowerCase())))
      .limit(1);
    const row = rows[0];
    if (!row) return FRESH_DRAIN_STATE;
    return {
      nextOffset: row.nextOffset,
      fullyDrained: row.fullyDrained,
      deltaCursor: row.deltaCursor ?? undefined,
    };
  } catch (err) {
    log("warn", "ob:drainStateReadFailed", { chainId, owner, err: String(err) });
    return FRESH_DRAIN_STATE; // treat as fresh — worst case re-drains (idempotent)
  }
}

/** Upsert the owner's drain row applying `set`; inserts a fresh row when absent. */
async function upsertOwnerDrain(
  context: Context,
  chainId: number,
  owner: Hex,
  set: Partial<{ nextOffset: number; fullyDrained: boolean; deltaCursor: number; lastAttemptAt: number }>,
): Promise<void> {
  try {
    await context.db.sql
      .insert(ownerDrain)
      .values({
        chainId,
        owner: owner.toLowerCase(),
        nextOffset: set.nextOffset ?? 0,
        fullyDrained: set.fullyDrained ?? false,
        deltaCursor: set.deltaCursor,
        lastAttemptAt: set.lastAttemptAt,
      })
      .onConflictDoUpdate({
        target: [ownerDrain.chainId, ownerDrain.owner],
        set,
      });
  } catch (err) {
    log("warn", "ob:drainStateWriteFailed", { chainId, owner, set: JSON.stringify(set), err: String(err) });
  }
}

/** Stamp last_attempt_at at the start of a drain attempt (drives rotation). */
export async function stampOwnerAttempt(
  context: Context,
  chainId: number,
  owner: Hex,
): Promise<void> {
  await upsertOwnerDrain(context, chainId, owner, {
    lastAttemptAt: Math.floor(Date.now() / 1000),
  });
}

/** Advance the full-drain resume offset — call only AFTER the page's rows are persisted. */
export async function advanceOwnerOffset(
  context: Context,
  chainId: number,
  owner: Hex,
  nextOffset: number,
): Promise<void> {
  await upsertOwnerDrain(context, chainId, owner, { nextOffset });
}

/** Record the newest creation_date seen at offset 0. Written during the drain but
 *  only READ once fully_drained — until then it is just a candidate. */
export async function writeOwnerDeltaCursor(
  context: Context,
  chainId: number,
  owner: Hex,
  deltaCursor: number,
): Promise<void> {
  await upsertOwnerDrain(context, chainId, owner, { deltaCursor });
}

/** Flip fully_drained after a full pass reached the last page. */
export async function markOwnerFullyDrained(
  context: Context,
  chainId: number,
  owner: Hex,
): Promise<void> {
  await upsertOwnerDrain(context, chainId, owner, { fullyDrained: true });
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
        executedFee: composableOrderCache.executedFee,
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

/** Upsert durable composable rows; excluded status/validTo/executed overwrite on conflict.
 *  Chunked: 13 columns × unbounded rows would hit Postgres' 65,535-bind-param cap on
 *  whale owners. */
export async function upsertComposableCache(
  context: Context,
  chainId: number,
  owner: Hex,
  rows: ComposableCacheRow[],
): Promise<void> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
    await upsertComposableCacheChunk(context, chainId, owner, rows.slice(i, i + UPSERT_CHUNK_SIZE), now);
  }
}

async function upsertComposableCacheChunk(
  context: Context,
  chainId: number,
  owner: Hex,
  rows: ComposableCacheRow[],
  now: bigint,
): Promise<void> {
  if (rows.length === 0) return;
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
        executedFee: r.executedFee,
        fetchedAt: now,
      })))
      .onConflictDoUpdate({
        target: [composableOrderCache.chainId, composableOrderCache.orderUid],
        set: {
          status: sql`excluded.status`,
          validTo: sql`excluded.valid_to`,
          executedSellAmount: sql`excluded.executed_sell_amount`,
          executedBuyAmount: sql`excluded.executed_buy_amount`,
          executedFee: sql`excluded.executed_fee`,
          fetchedAt: now,
        },
      });
  } catch (err) {
    log("warn", "ob:composableCacheWriteFailed", { chainId, rows: rows.length, err: String(err) });
  }
}
