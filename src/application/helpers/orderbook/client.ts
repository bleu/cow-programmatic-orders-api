/**
 * Orderbook client — fetches and caches composable orders from the CoW Orderbook API.
 *
 * Cache strategy (per-UID):
 * - Uses cow_cache.order_uid_cache to store per-UID terminal statuses
 * - Terminal orders (fulfilled/expired/cancelled) are cached and never re-fetched
 * - Open/non-cached orders are refreshed via POST /api/v1/orders/by_uids
 * - Cache is invalidated per-owner when ConditionalOrderCreated fires
 *
 * KNOWN LIMITATION — Off-chain cancellation gap:
 *   Orders cancelled via the CoW Orderbook API's DELETE endpoint (off-chain
 *   soft cancel) are NOT detected after they've been cached as terminal.
 *   This is rare for EIP-1271 composable orders, which follow the on-chain
 *   cancellation path via ComposableCoW.remove().
 */

import { and, eq, inArray, sql } from "ponder";
import {
  discreteOrder,
} from "ponder:schema";
import type { Context } from "ponder:registry";
import { type Hex } from "viem";
import { ORDERBOOK_API_URLS } from "../../../data";
import {
  ORDERBOOK_HTTP_TIMEOUT_MS,
  SIGNING_SCHEME_EIP1271,
} from "../../../constants";
import { TimeoutError, withTimeout } from "../withTimeout";
import { bumpGeneratorsUpdatedAt } from "../updatedAtBlock";
import { log } from "../logger";
import { fetchAccountOrders, fetchOrdersByUids } from "./http";
import {
  cacheFlashLoanEnrichment,
  cacheUidStatuses,
  getCachedFlashLoanEnrichment,
  getCachedUidStatuses,
  readOwnerBackfillCursor,
  readOwnerComposableCache,
  toCacheRow,
  upsertComposableCache,
} from "./cache";
import {
  filterAndProcess,
  reconcileOpenCachedRows,
  remapToCurrentGenerators,
} from "./processing";
import {
  PAGE_LIMIT,
  TERMINAL_STATUSES,
  type ComposableOrder,
  type FlashLoanEnrichment,
  type OrderStatusInfo,
  type OrderbookOrder,
} from "./types";

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch composable orders for an owner, using per-UID cache for terminal orders.
 * Incremental drain: Ponder rebuilds the onchain discreteOrder table
 * from scratch on every schema-hash redeploy, so a naive implementation re-fetches
 * an owner's entire history each deploy. Instead the full composable-order rows are
 * kept in the durable cow_cache.composable_order table (survives reindex), and only
 * the delta newer than MAX(creation_date) is fetched from the orderbook:
 *
 * 1. cursor = newest creation_date already cached for this owner (undefined = full drain)
 * 2. Fetch /account/{owner}/orders newest-first, stopping once older than the cursor
 * 3. Decode → filter to composable → match to generators, then persist the delta
 * 4. Rebuild the full owner set from the durable cache (delta + all older rows)
 * 5. Re-check any still-open cached rows via by_uids so statuses don't go stale
 * 6. Re-map generator_hash → the current generator eventId (changes each reindex)
 */
export async function fetchComposableOrders(
  context: Context,
  chainId: number,
  owner: Hex,
): Promise<{ orders: ComposableOrder[]; complete: boolean }> {
  const apiBaseUrl = ORDERBOOK_API_URLS[chainId];
  if (!apiBaseUrl) {
    log("warn", "ob:noApiUrl", { chainId });
    return { orders: [], complete: false };
  }

  // Only fetch orders newer than what we've already durably cached for this owner.
  const cursor = await readOwnerBackfillCursor(context, chainId, owner);
  log("info", "ob:fetch", { owner, chainId, since: cursor ?? null });

  // complete=false (pagination cut short by rate limit / timeout) means the caller must
  // NOT mark the owner backfilled — it stays eligible and is retried on a later block.
  const { orders: deltaApiOrders, complete } = await fetchAccountOrders(apiBaseUrl, owner, 0, SIGNING_SCHEME_EIP1271, PAGE_LIMIT, cursor);
  const delta = await filterAndProcess(context, chainId, deltaApiOrders);

  // Persist the delta (account-endpoint status is the live status) into the durable cache.
  await upsertComposableCache(context, chainId, owner, delta.map(toCacheRow));

  // Rebuild the full owner set from the durable cache (delta + everything older).
  const cachedRows = await readOwnerComposableCache(context, chainId, owner);

  // Re-check any still-open cached rows — long-lived orders that terminated below the
  // cursor since a prior drain would otherwise keep a stale "open" status forever.
  const reconciled = await reconcileOpenCachedRows(context, chainId, owner, apiBaseUrl, cachedRows);

  // The per-deployment generator eventId changes each reindex; re-map by the stable hash.
  const results = await remapToCurrentGenerators(context, chainId, reconciled);

  log("info", "ob:fetchResult", { owner, chainId, since: cursor ?? null, delta: delta.length, total: results.length, complete });
  return { orders: results, complete };
}

/**
 * Upsert composable orders into the discrete_order table.
 * Uses onConflictDoUpdate so the API's authoritative status overwrites
 * the block handler's initial "open".
 * Returns the number of rows actually inserted or changed, not the input size.
 */
export async function upsertDiscreteOrders(
  context: Context,
  chainId: number,
  orders: ComposableOrder[],
  blockNumber: bigint,
): Promise<number> {
  if (orders.length === 0) return 0;

  // Skip no-op writes: OwnerBackfill retries partially-drained owners, so the
  // same pages get re-upserted. Without this filter every retry would bump
  // updatedAtBlock on untouched rows and their parent generators, making
  // cursor-synced clients re-fetch data that never changed. Compare only the
  // fields the upsert below can change.
  const existingRows = await context.db.sql
    .select({
      orderUid: discreteOrder.orderUid,
      status: discreteOrder.status,
      validTo: discreteOrder.validTo,
      executedSellAmount: discreteOrder.executedSellAmount,
      executedBuyAmount: discreteOrder.executedBuyAmount,
    })
    .from(discreteOrder)
    .where(
      and(
        eq(discreteOrder.chainId, chainId),
        inArray(discreteOrder.orderUid, orders.map((order) => order.uid)),
      ),
    );
  const existingByUid = new Map(existingRows.map((row) => [row.orderUid, row]));
  const changedOrders = orders.filter((order) => {
    const existing = existingByUid.get(order.uid);
    return !existing ||
      existing.status !== order.status ||
      existing.validTo !== order.validTo ||
      existing.executedSellAmount !== order.executedSellAmount ||
      existing.executedBuyAmount !== order.executedBuyAmount;
  });
  if (changedOrders.length === 0) return 0;

  // One multi-row upsert instead of N individual roundtrips.
  await context.db.sql
    .insert(discreteOrder)
    .values(changedOrders.map((order) => ({
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
      updatedAtBlock: blockNumber,
    })))
    .onConflictDoUpdate({
      target: [discreteOrder.chainId, discreteOrder.orderUid],
      set: {
        status: sql`excluded.status`,
        validTo: sql`excluded.valid_to`,
        executedSellAmount: sql`excluded.executed_sell_amount`,
        executedBuyAmount: sql`excluded.executed_buy_amount`,
        updatedAtBlock: sql`excluded.updated_at_block`,
      },
    });
  await bumpGeneratorsUpdatedAt(
    context,
    chainId,
    changedOrders.map((order) => order.generatorId),
    blockNumber,
  );
  return changedOrders.length;
}

/**
 * Fetch order statuses by UIDs from the API, using the per-UID cache.
 * Returns a Map of uid -> OrderStatusInfo. Executed amounts are null for
 * cached results (the amounts are already stored in discreteOrder from
 * the original fresh fetch).
 */
export async function fetchOrderStatusByUids(
  context: Context,
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
  context: Context,
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
