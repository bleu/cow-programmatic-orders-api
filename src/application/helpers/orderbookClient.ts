/**
 * Orderbook client (Ponder-side) — status refresh, flash-loan enrichment, discrete-order
 * upsert, and the generator re-mapping used by the OwnerBackfill projection.
 *
 * The raw HTTP layer lives in orderbookHttp.ts and the durable composable cache +
 * drain-state queue in composableCache.ts — both Ponder-free so the standalone drain
 * worker can share them. This module is the part that touches Ponder's versioned schema
 * (conditionalOrderGenerator / discreteOrder), so it stays inside the Ponder runtime.
 *
 * Cache strategy (per-UID):
 * - Uses cow_cache.order_uid_cache to store per-UID terminal statuses
 * - Terminal orders (fulfilled/expired/cancelled) are cached and never re-fetched
 * - Open/non-cached orders are refreshed via POST /api/v1/orders/by_uids
 *
 * KNOWN LIMITATION — Off-chain cancellation gap:
 *   Orders cancelled via the CoW Orderbook API's DELETE endpoint (off-chain
 *   soft cancel) are NOT detected after they've been cached as terminal.
 *   This is rare for EIP-1271 composable orders, which follow the on-chain
 *   cancellation path via ComposableCoW.remove().
 */

import {
  conditionalOrderGenerator,
  discreteOrder,
} from "ponder:schema";
import { and, eq, inArray, sql } from "ponder";
import { pgSchema, integer, text } from "drizzle-orm/pg-core";
import { type Hex } from "viem";
import { type OrderType } from "../../utils/order-types";
import { ORDERBOOK_API_URLS } from "../../data";
import { ORDERBOOK_HTTP_TIMEOUT_MS } from "../../constants";
import { TimeoutError, withTimeout } from "./withTimeout";
import { log } from "./logger";
import { fetchAccountOrders, fetchOrdersByUids, type OrderbookOrder } from "./orderbookHttp";
import { type ComposableCacheRow, type DrizzleHandle } from "./composableCache";

// Re-export the account paginator so callers that only need the raw HTTP path can
// import it from here (the historical import site) without reaching into orderbookHttp.
export { fetchAccountOrders } from "./orderbookHttp";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Processed composable order returned to callers (discrete-order projection).
 *  Shares field types with the discreteOrder schema for the DB-mapped fields. */
export type ComposableOrder = Pick<
  typeof discreteOrder.$inferInsert,
  "status" | "sellAmount" | "buyAmount" | "feeAmount" | "validTo" | "executedSellAmount" | "executedBuyAmount"
> & {
  uid: string;
  generatorId: string;
  generatorHash: string;
  orderType: OrderType;
  creationDate: bigint;
};

/** Status + executed amounts returned by fetchOrderStatusByUids. */
export interface OrderStatusInfo {
  status: string;
  executedSellAmount: string | null;  // null when served from cache
  executedBuyAmount: string | null;
}

const TERMINAL_STATUSES = new Set(["fulfilled", "expired", "cancelled"]);

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Upsert composable orders into the discrete_order table.
 * Uses onConflictDoUpdate so the API's authoritative status overwrites
 * the block handler's initial "open".
 */
export async function upsertDiscreteOrders(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  orders: ComposableOrder[],
): Promise<number> {
  if (orders.length === 0) return 0;
  // One multi-row upsert instead of N individual roundtrips.
  await context.db.sql
    .insert(discreteOrder)
    .values(orders.map((order) => ({
      orderUid: order.uid,
      chainId,
      conditionalOrderGeneratorId: order.generatorId,
      status: order.status,
      sellAmount: order.sellAmount,
      buyAmount: order.buyAmount,
      feeAmount: order.feeAmount,
      validTo: order.validTo,
      creationDate: order.creationDate,
      executedSellAmount: order.executedSellAmount,
      executedBuyAmount: order.executedBuyAmount,
    })))
    .onConflictDoUpdate({
      target: [discreteOrder.chainId, discreteOrder.orderUid],
      set: {
        status: sql`excluded.status`,
        validTo: sql`excluded.valid_to`,
        executedSellAmount: sql`excluded.executed_sell_amount`,
        executedBuyAmount: sql`excluded.executed_buy_amount`,
      },
    });
  return orders.length;
}

/**
 * Fetch order statuses by UIDs from the API, using the per-UID cache.
 * Returns a Map of uid -> OrderStatusInfo. Executed amounts are null for
 * cached results (the amounts are already stored in discreteOrder from
 * the original fresh fetch).
 */
export async function fetchOrderStatusByUids(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  uids: string[],
): Promise<Map<string, OrderStatusInfo>> {
  const result = new Map<string, OrderStatusInfo>();
  if (uids.length === 0) return result;

  const apiBaseUrl = ORDERBOOK_API_URLS[chainId];
  if (!apiBaseUrl) return result;

  // Check cache first
  const cached = await getCachedUidStatuses(context, chainId, uids);
  const toFetch: string[] = [];

  for (const uid of uids) {
    const cachedData = cached.get(uid);
    if (cachedData && TERMINAL_STATUSES.has(cachedData.status)) {
      result.set(uid, {
        status: cachedData.status,
        executedSellAmount: cachedData.executedSellAmount,
        executedBuyAmount: cachedData.executedBuyAmount,
      });
    } else {
      toFetch.push(uid);
    }
  }

  // Batch-fetch non-cached UIDs. Outer bound: if every chunk sits right at the
  // per-request cap, the sequential loop could still linger well past a block
  // budget — cap total HTTP wall-time for this call at 2 × the per-request cap.
  if (toFetch.length > 0) {
    let fetched: OrderbookOrder[];
    try {
      fetched = await withTimeout(
        fetchOrdersByUids(apiBaseUrl, toFetch),
        ORDERBOOK_HTTP_TIMEOUT_MS * 2,
        "ob:statusByUids",
      );
    } catch (err) {
      if (err instanceof TimeoutError) {
        log("warn", "ob:statusByUidsTimeout", { chainId, toFetch: toFetch.length, after: ORDERBOOK_HTTP_TIMEOUT_MS * 2 });
        return result; // cache-only map — caller treats missing UIDs as "not on API yet"
      }
      throw err;
    }

    const newTerminal: ComposableOrder[] = [];

    for (const order of fetched) {
      result.set(order.uid, {
        status: order.status,
        executedSellAmount: order.executedSellAmount,
        executedBuyAmount: order.executedBuyAmount,
      });
      if (TERMINAL_STATUSES.has(order.status)) {
        newTerminal.push({
          uid: order.uid,
          status: order.status as ComposableOrder["status"],
          generatorId: "",
          generatorHash: "",
          orderType: "Unknown",
          sellAmount: order.sellAmount,
          buyAmount: order.buyAmount,
          feeAmount: order.feeAmount,
          validTo: order.validTo,
          creationDate: 0n,
          executedSellAmount: order.executedSellAmount,
          executedBuyAmount: order.executedBuyAmount,
        });
      }
    }

    if (newTerminal.length > 0) {
      await cacheUidStatuses(context, chainId, newTerminal);
    }
  }

  return result;
}

/**
 * Fallback status lookup via GET /account/{owner}/orders.
 * Used when /orders/by_uids returns nothing for UIDs that may have aged out
 * of the API's retention window (e.g. TWAP parts near or past validTo).
 * Returns a Map of uid -> OrderStatusInfo for all orders found for this owner.
 */
export async function fetchOwnerOrderStatuses(
  chainId: number,
  owner: Hex,
  maxPages = 3,
): Promise<Map<string, OrderStatusInfo>> {
  const result = new Map<string, OrderStatusInfo>();
  const apiBaseUrl = ORDERBOOK_API_URLS[chainId];
  if (!apiBaseUrl) return result;
  const { orders } = await fetchAccountOrders(apiBaseUrl, owner, maxPages);
  for (const order of orders) {
    result.set(order.uid, {
      status: order.status,
      executedSellAmount: order.executedSellAmount,
      executedBuyAmount: order.executedBuyAmount,
    });
  }
  return result;
}

/** CoW-order fields used to enrich a flash-loan order, from the orderbook. */
export interface FlashLoanEnrichment {
  receiver: string | null;
  kind: "sell" | "buy";
  sellAmount: string;
  buyAmount: string;
  executedSellAmount: string;
  executedBuyAmount: string;
}

/**
 * Fetch CoW-order detail for flash-loan order UIDs, cache-first.
 *
 * Flash-loan adapters wipe their getHookData() struct in the settlement tx, so
 * the orderbook is the authoritative source for kind / receiver / intended
 * amounts. Flash-loan orders are always settled (terminal), so a fetched result
 * never goes stale — it is cached in cow_cache.order_uid_cache (shared with the
 * discrete path), which survives reindex, so a schema-hash change does not re-hit the orderbook for
 * historical orders. UIDs absent from both cache and the API body (not yet
 * indexed, or aged out) are omitted — the caller retries on a later block.
 */
export async function fetchFlashLoanEnrichmentByUids(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  uids: string[],
): Promise<Map<string, FlashLoanEnrichment>> {
  const result = new Map<string, FlashLoanEnrichment>();
  if (uids.length === 0) return result;

  const apiBaseUrl = ORDERBOOK_API_URLS[chainId];
  if (!apiBaseUrl) return result;

  // Cache first — served from cow_cache across reindexes.
  const cached = await getCachedFlashLoanEnrichment(context, chainId, uids);
  const toFetch: string[] = [];
  for (const uid of uids) {
    const hit = cached.get(uid);
    if (hit) result.set(uid, hit);
    else toFetch.push(uid);
  }
  if (toFetch.length === 0) return result;

  let fetched: OrderbookOrder[];
  try {
    fetched = await withTimeout(
      fetchOrdersByUids(apiBaseUrl, toFetch),
      ORDERBOOK_HTTP_TIMEOUT_MS * 2,
      "ob:flashLoanByUids",
    );
  } catch (err) {
    if (err instanceof TimeoutError) {
      log("warn", "ob:flashLoanByUidsTimeout", { chainId, toFetch: toFetch.length, after: ORDERBOOK_HTTP_TIMEOUT_MS * 2 });
      return result; // cache-only — caller treats missing UIDs as "not on API yet"
    }
    throw err;
  }

  const newlyFetched: { uid: string; enrichment: FlashLoanEnrichment }[] = [];
  for (const order of fetched) {
    const enrichment: FlashLoanEnrichment = {
      receiver: order.receiver ? order.receiver.toLowerCase() : null,
      kind: order.kind,
      sellAmount: order.sellAmount,
      buyAmount: order.buyAmount,
      executedSellAmount: order.executedSellAmount,
      executedBuyAmount: order.executedBuyAmount,
    };
    result.set(order.uid, enrichment);
    newlyFetched.push({ uid: order.uid, enrichment });
  }

  if (newlyFetched.length > 0) {
    await cacheFlashLoanEnrichment(context, chainId, newlyFetched);
  }

  return result;
}

// ─── Projection: durable cache → current generators ──────────────────────────

/** Map durable rows (keyed by the stable generator_hash) to ComposableOrder with the
 *  current per-deployment generator eventId. Rows with no current generator are dropped.
 *  This is the hash → eventId join the drain worker deliberately skips. */
export async function remapToCurrentGenerators(
  db: DrizzleHandle,
  chainId: number,
  rows: ComposableCacheRow[],
): Promise<ComposableOrder[]> {
  if (rows.length === 0) return [];
  const hashes = [...new Set(rows.map((r) => r.generatorHash))] as Hex[];

  let generators: { eventId: string; hash: string }[];
  try {
    generators = (await db
      .select({ eventId: conditionalOrderGenerator.eventId, hash: conditionalOrderGenerator.hash })
      .from(conditionalOrderGenerator)
      .where(
        and(
          eq(conditionalOrderGenerator.chainId, chainId),
          inArray(conditionalOrderGenerator.hash, hashes),
        ),
      )) as { eventId: string; hash: string }[];
  } catch {
    return [];
  }

  const eventIdByHash = new Map(generators.map((g) => [g.hash, g.eventId]));

  const results: ComposableOrder[] = [];
  for (const row of rows) {
    const generatorId = eventIdByHash.get(row.generatorHash);
    if (!generatorId) continue;
    results.push({
      uid: row.orderUid,
      status: row.status as ComposableOrder["status"],
      generatorId,
      generatorHash: row.generatorHash,
      orderType: row.orderType,
      sellAmount: row.sellAmount,
      buyAmount: row.buyAmount,
      feeAmount: row.feeAmount,
      validTo: row.validTo,
      creationDate: row.creationDate,
      executedSellAmount: row.executedSellAmount,
      executedBuyAmount: row.executedBuyAmount,
    });
  }
  return results;
}

// ─── Per-UID cache helpers ──────────────────────────────────────────────────
// cow_cache.order_uid_cache is created by setup.ts. One per-UID cache of terminal
// order data, shared by the discrete path (status + executed amounts) and the
// flash-loan path (kind/receiver/intended + executed amounts). The flash-loan
// columns are nullable; the two UID populations are disjoint.
const cowCacheSchema = pgSchema("cow_cache");

const orderUidCache = cowCacheSchema.table("order_uid_cache", {
  chainId: integer("chain_id").notNull(),
  orderUid: text("order_uid").notNull(),
  status: text("status").notNull(),
  fetchedAt: integer("fetched_at").notNull(),
  executedSellAmount: text("executed_sell_amount"),
  executedBuyAmount: text("executed_buy_amount"),
  kind: text("kind"),
  receiver: text("receiver"),
  sellAmount: text("sell_amount"),
  buyAmount: text("buy_amount"),
});

/** Read cached flash-loan enrichment for a list of UIDs. */
async function getCachedFlashLoanEnrichment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
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
async function cacheFlashLoanEnrichment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
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

/** Cached order data returned by getCachedUidStatuses. */
interface CachedOrderData {
  status: string;
  executedSellAmount: string | null;
  executedBuyAmount: string | null;
}

/** Get cached data for a list of UIDs. Returns a Map of uid -> CachedOrderData. */
async function getCachedUidStatuses(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
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
        });
      }
    }
  } catch {
    // Cache miss on error — will re-fetch from API
  }

  return result;
}

/** Cache terminal statuses and executed amounts for composable orders. */
async function cacheUidStatuses(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
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
      })))
      .onConflictDoUpdate({
        target: [orderUidCache.chainId, orderUidCache.orderUid],
        set: {
          status: sql`excluded.status`,
          fetchedAt: now,
          executedSellAmount: sql`excluded.executed_sell_amount`,
          executedBuyAmount: sql`excluded.executed_buy_amount`,
        },
      });
  } catch {
    // Best-effort cache write
  }
}
