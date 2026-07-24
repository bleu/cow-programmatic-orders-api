/**
 * Orderbook client — fetches and caches composable orders from the CoW Orderbook API.
 *
 * Cache strategy (per-UID):
 * - Uses cow_cache.order_uid_cache to store per-UID terminal statuses
 * - Terminal statuses are cached but only trusted permanently once provably
 *   beyond the chain's reorg window — see ./trust.ts (COW-1183). Soft rows
 *   keep re-fetching; a fetch that contradicts a cached terminal status
 *   (reorg revert) deletes the row.
 * - Open/non-cached orders are refreshed via POST /api/v1/orders/by_uids
 * - Cache is invalidated per-owner when ConditionalOrderCreated fires
 *
 * See orderbookClient.ts (the barrel) for the known off-chain cancellation gap.
 */

import { and, eq, inArray, sql } from "ponder";
import {
  discreteOrder,
} from "ponder:schema";
import type { Context } from "ponder:registry";
import { type Hex } from "viem";
import { ORDERBOOK_API_URLS, REORG_SAFETY_WINDOW_SECONDS, type SupportedChainId } from "../../../data";
import {
  DEFAULT_REORG_SAFETY_WINDOW_SECONDS,
  ORDERBOOK_HTTP_TIMEOUT_MS,
  SIGNING_SCHEME_EIP1271,
  UPSERT_CHUNK_SIZE,
} from "../../../constants";
import { TimeoutError, withTimeout } from "../withTimeout";
import { bumpGeneratorsUpdatedAt } from "../updatedAtBlock";
import { log } from "../logger";
import { refreshTwapExecutedTotals } from "../executedAmounts";
import { fetchAccountOrders, fetchOrdersByUids } from "./http";
import {
  advanceOwnerOffset,
  cacheFlashLoanEnrichment,
  cacheUidStatuses,
  deleteUidCacheEntries,
  getCachedFlashLoanEnrichment,
  getCachedUidStatuses,
  markOwnerFullyDrained,
  readOwnerComposableCache,
  readOwnerDrainState,
  toCacheRow,
  upsertComposableCache,
  writeOwnerDeltaCursor,
  type OwnerDrainState,
} from "./cache";
import {
  filterAndProcess,
  reconcileOpenCachedRows,
  remapToCurrentGenerators,
} from "./processing";
import { classifyCachedRow } from "./trust";
import {
  PAGE_LIMIT,
  TERMINAL_STATUSES,
  toBigIntOrNull,
  type ComposableOrder,
  type FlashLoanEnrichment,
  type OrderStatusInfo,
  type OrderbookOrder,
} from "./types";

// ─── Public API ──────────────────────────────────────────────────────────────

/** Outcome of one bounded drain attempt for an owner. */
export interface OwnerDrainResult {
  /** Orders upserted into discreteOrder during this slice. */
  discovered: number;
  /** True once the owner's history is fully covered — the caller may flip
   *  historyBackfilled. False means "made progress, continue on a later firing". */
  complete: boolean;
}

/** Unix seconds of an orderbook order's ISO creationDate. */
function creationSeconds(order: OrderbookOrder): number {
  return Math.floor(new Date(order.creationDate).getTime() / 1000);
}

/**
 * Run one bounded, resumable drain slice for an owner. All progress is recorded
 * in cow_cache.owner_drain (see setup.ts), so a slice ended by the abort signal
 * or a rate limit is never wasted — the next attempt continues where it stopped.
 *
 * Two modes, keyed on owner_drain.fully_drained:
 * - Full drain (initial, or after the durable cache was lost): resume the
 *   /account/{owner}/orders pagination at next_offset, persisting page-by-page.
 * - Delta (owner fully drained before, e.g. a redeploy): fetch only orders newer
 *   than delta_cursor, then rebuild the owner's set from the durable cache.
 */
export async function drainOwnerSlice(
  context: Context,
  chainId: number,
  owner: Hex,
  blockNumber: bigint,
  signal?: AbortSignal,
): Promise<OwnerDrainResult> {
  const apiBaseUrl = ORDERBOOK_API_URLS[chainId];
  if (!apiBaseUrl) {
    log("warn", "ob:noApiUrl", { chainId });
    return { discovered: 0, complete: false };
  }

  const state = await readOwnerDrainState(context, chainId, owner);
  return state.fullyDrained
    ? drainOwnerDelta(context, chainId, owner, apiBaseUrl, state, blockNumber, signal)
    : drainOwnerFull(context, chainId, owner, apiBaseUrl, state, blockNumber, signal);
}

/** Full-history drain: resumable page-by-page ingestion, then one completion pass. */
async function drainOwnerFull(
  context: Context,
  chainId: number,
  owner: Hex,
  apiBaseUrl: string,
  state: OwnerDrainState,
  blockNumber: bigint,
  signal?: AbortSignal,
): Promise<OwnerDrainResult> {
  log("info", "ob:fullDrain", { owner, chainId, startOffset: state.nextOffset });

  let discovered = 0;
  const onPage = async (pageOrders: OrderbookOrder[], nextOffset: number): Promise<void> => {
    const matched = await filterAndProcess(context, chainId, pageOrders);
    await upsertComposableCache(context, chainId, owner, matched.map(toCacheRow));
    discovered += await upsertDiscreteOrders(context, chainId, matched, blockNumber);

    // The first order of the offset-0 page is the newest order at drain start: the
    // delta-cursor candidate. Orders created mid-drain are newer, so a later delta
    // pass picks them up. Written before the offset advance so it can never be skipped.
    if (nextOffset === pageOrders.length && pageOrders[0]) {
      await writeOwnerDeltaCursor(context, chainId, owner, creationSeconds(pageOrders[0]));
    }

    // Advance the resume point only now that the page's rows are persisted.
    await advanceOwnerOffset(context, chainId, owner, nextOffset);
  };

  const { complete } = await fetchAccountOrders(
    apiBaseUrl, owner, 0, SIGNING_SCHEME_EIP1271, PAGE_LIMIT, undefined,
    { signal, startOffset: state.nextOffset, onPage },
  );

  if (!complete) {
    log("info", "ob:fullDrainPaused", { owner, chainId, discovered, aborted: signal?.aborted ?? false });
    return { discovered, complete: false };
  }

  // Reached the last page — materialize the complete set once. The durable cache can
  // hold rows this pass never saw (orders aged out of the API, cached by a prior
  // deployment), so rebuild from cache, refresh open statuses, re-map generators.
  const cachedRows = await readOwnerComposableCache(context, chainId, owner);
  const reconciled = await reconcileOpenCachedRows(context, chainId, owner, apiBaseUrl, cachedRows, signal);
  const results = await remapToCurrentGenerators(context, chainId, reconciled);
  // Counts only rows the reconcile actually changed — page upserts above already
  // counted the rest.
  discovered += await upsertDiscreteOrders(context, chainId, results, blockNumber);

  // If the slice deadline hit during the reconcile, statuses may be stale — keep the
  // owner eligible; the next attempt resumes at the tail (one page) and retries
  // completion with a fresh slice.
  if (signal?.aborted) {
    log("info", "ob:fullDrainPaused", { owner, chainId, discovered, aborted: true, at: "completion" });
    return { discovered, complete: false };
  }

  await markOwnerFullyDrained(context, chainId, owner);
  log("info", "ob:fullDrainDone", { owner, chainId, discovered, total: results.length });
  return { discovered, complete: true };
}

/** Delta drain: fetch only orders newer than delta_cursor, rebuild from the cache.
 *  The cursor advances ONLY on a complete pass — an incomplete delta re-fetches the
 *  same window later (overlap, never a gap). */
async function drainOwnerDelta(
  context: Context,
  chainId: number,
  owner: Hex,
  apiBaseUrl: string,
  state: OwnerDrainState,
  blockNumber: bigint,
  signal?: AbortSignal,
): Promise<OwnerDrainResult> {
  log("info", "ob:deltaDrain", { owner, chainId, since: state.deltaCursor ?? null });

  const { orders: deltaApiOrders, complete } = await fetchAccountOrders(
    apiBaseUrl, owner, 0, SIGNING_SCHEME_EIP1271, PAGE_LIMIT, state.deltaCursor,
    { signal },
  );
  if (!complete) {
    log("warn", "ob:deltaDrainIncomplete", { owner, chainId, aborted: signal?.aborted ?? false });
    return { discovered: 0, complete: false };
  }

  const delta = await filterAndProcess(context, chainId, deltaApiOrders);
  await upsertComposableCache(context, chainId, owner, delta.map(toCacheRow));

  // Rebuild the full owner set from the durable cache (delta + everything older).
  const cachedRows = await readOwnerComposableCache(context, chainId, owner);
  const reconciled = await reconcileOpenCachedRows(context, chainId, owner, apiBaseUrl, cachedRows, signal);
  const results = await remapToCurrentGenerators(context, chainId, reconciled);
  const discovered = await upsertDiscreteOrders(context, chainId, results, blockNumber);

  if (signal?.aborted) {
    log("warn", "ob:deltaDrainIncomplete", { owner, chainId, aborted: true, at: "reconcile" });
    return { discovered, complete: false };
  }

  // Newest raw order in the delta (pages are newest-first) becomes the next cursor.
  const newest = deltaApiOrders[0];
  if (newest) await writeOwnerDeltaCursor(context, chainId, owner, creationSeconds(newest));

  log("info", "ob:deltaDrainDone", { owner, chainId, since: state.deltaCursor ?? null, delta: delta.length, total: results.length, discovered });
  return { discovered, complete: true };
}

/**
 * Upsert composable orders into the discrete_order table.
 * Uses onConflictDoUpdate so the API's authoritative status overwrites
 * the block handler's initial "open". Chunked to stay clear of Postgres'
 * 65,535-bind-param statement cap on whale owners.
 * Returns the number of rows actually inserted or changed, not the input size.
 */
export async function upsertDiscreteOrders(
  context: Context,
  chainId: number,
  orders: ComposableOrder[],
  blockNumber: bigint,
): Promise<number> {
  if (orders.length === 0) return 0;

  let changedCount = 0;
  const changedGeneratorIds: string[] = [];
  for (let i = 0; i < orders.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = orders.slice(i, i + UPSERT_CHUNK_SIZE);

    // Skip no-op writes: resumed drain slices and delta rebuilds re-upsert pages
    // already persisted. Without this filter every retry would bump updatedAtBlock
    // on untouched rows and their parent generators, making cursor-synced clients
    // re-fetch data that never changed. Compare only the fields the upsert below
    // can change.
    const existingRows = await context.db.sql
      .select({
        orderUid: discreteOrder.orderUid,
        status: discreteOrder.status,
        validTo: discreteOrder.validTo,
        executedSellAmount: discreteOrder.executedSellAmount,
        executedBuyAmount: discreteOrder.executedBuyAmount,
        executedFee: discreteOrder.executedFee,
      })
      .from(discreteOrder)
      .where(
        and(
          eq(discreteOrder.chainId, chainId),
          inArray(discreteOrder.orderUid, chunk.map((order) => order.uid)),
        ),
      );
    const existingByUid = new Map(existingRows.map((row) => [row.orderUid, row]));
    // Executed columns compare on the post-coalesce effective value (incoming
    // null keeps the existing value — see the conflict set below), so a cached
    // null never marks an already-populated row as changed.
    const changedOrders = chunk.filter((order) => {
      const existing = existingByUid.get(order.uid);
      return !existing ||
        existing.status !== order.status ||
        existing.validTo !== order.validTo ||
        (order.executedSellAmount ?? existing.executedSellAmount) !== existing.executedSellAmount ||
        (order.executedBuyAmount ?? existing.executedBuyAmount) !== existing.executedBuyAmount ||
        (order.executedFee ?? existing.executedFee) !== existing.executedFee;
    });
    if (changedOrders.length === 0) continue;

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
        executedFee: order.executedFee,
        updatedAtBlock: blockNumber,
      })))
      .onConflictDoUpdate({
        target: [discreteOrder.chainId, discreteOrder.orderUid],
        set: {
          status: sql`excluded.status`,
          validTo: sql`excluded.valid_to`,
          // Durable-cache rows from before the executed_fee column carry nulls —
          // coalesce so they never erase values already written by a fresh fetch.
          executedSellAmount: sql`coalesce(excluded.executed_sell_amount, ${discreteOrder.executedSellAmount})`,
          executedBuyAmount: sql`coalesce(excluded.executed_buy_amount, ${discreteOrder.executedBuyAmount})`,
          executedFee: sql`coalesce(excluded.executed_fee, ${discreteOrder.executedFee})`,
          updatedAtBlock: sql`excluded.updated_at_block`,
        },
      });
    changedCount += changedOrders.length;
    changedGeneratorIds.push(...changedOrders.map((order) => order.generatorId));
  }

  await bumpGeneratorsUpdatedAt(context, chainId, changedGeneratorIds, blockNumber);
  await refreshTwapExecutedTotals(context, chainId, changedGeneratorIds);
  return changedCount;
}

/**
 * Fetch order statuses by UIDs from the API, using the per-UID cache.
 * Returns a Map of uid -> OrderStatusInfo. Executed amounts are null for
 * cached results (the amounts are already stored in discreteOrder from
 * the original fresh fetch).
 *
 * Cache reads go through the trust rule (trust.ts): only rows provably beyond
 * the chain's reorg window are served as final. Soft rows (recently terminal,
 * or written by an older cache version) are re-fetched, with the cached data
 * kept as a fallback in case the UID has aged out of /by_uids. A fetch that
 * contradicts a cached terminal status (reorg revert) deletes the cache row.
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

  const window =
    REORG_SAFETY_WINDOW_SECONDS[chainId as SupportedChainId] ??
    DEFAULT_REORG_SAFETY_WINDOW_SECONDS;
  const nowSeconds = Math.floor(Date.now() / 1000);

  const cached = await getCachedUidStatuses(context, chainId, uids);
  const toFetch: string[] = [];
  const staleFallbacks = new Map<string, OrderStatusInfo>();

  for (const uid of uids) {
    const cachedData = cached.get(uid);
    const trust = cachedData ? classifyCachedRow(cachedData, nowSeconds, window) : null;
    if (cachedData && trust !== null && trust !== "not-terminal") {
      const info: OrderStatusInfo = {
        status: cachedData.status,
        executedSellAmount: toBigIntOrNull(cachedData.executedSellAmount),
        executedBuyAmount: toBigIntOrNull(cachedData.executedBuyAmount),
        executedFee: toBigIntOrNull(cachedData.executedFee),
      };
      if (trust === "trusted") {
        result.set(uid, info);
      } else {
        staleFallbacks.set(uid, info);
        toFetch.push(uid);
      }
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
        // Cache-only map — callers treat missing UIDs as "not on API yet".
        // Stale-but-known entries still answer from cache.
        for (const [uid, info] of staleFallbacks) result.set(uid, info);
        return result;
      }
      throw err;
    }

    const newTerminal: ComposableOrder[] = [];
    const reverted: string[] = [];

    for (const order of fetched) {
      result.set(order.uid, {
        status: order.status,
        executedSellAmount: toBigIntOrNull(order.executedSellAmount),
        executedBuyAmount: toBigIntOrNull(order.executedBuyAmount),
        executedFee: toBigIntOrNull(order.executedFee),
      });
      // A cached terminal status the API now contradicts was reorged out —
      // drop the row so the stale fallback can't be served again.
      if (!TERMINAL_STATUSES.has(order.status) && staleFallbacks.has(order.uid)) {
        reverted.push(order.uid);
        staleFallbacks.delete(order.uid);
      }
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
          executedSellAmount: toBigIntOrNull(order.executedSellAmount),
          executedBuyAmount: toBigIntOrNull(order.executedBuyAmount),
          executedFee: toBigIntOrNull(order.executedFee),
        });
      }
    }

    if (newTerminal.length > 0) {
      await cacheUidStatuses(context, chainId, newTerminal);
    }
    if (reverted.length > 0) {
      await deleteUidCacheEntries(context, chainId, reverted);
    }

    // Stale UIDs the API no longer returns (aged out of /by_uids): answer with
    // the cached data rather than omitting them, so callers don't mistake a
    // long-settled order for "not on API yet".
    for (const [uid, info] of staleFallbacks) {
      if (!result.has(uid)) result.set(uid, info);
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
      executedSellAmount: toBigIntOrNull(order.executedSellAmount),
      executedBuyAmount: toBigIntOrNull(order.executedBuyAmount),
      executedFee: toBigIntOrNull(order.executedFee),
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

  const newlyFetched: { uid: string; enrichment: FlashLoanEnrichment; validTo: number | null }[] = [];
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
    newlyFetched.push({ uid: order.uid, enrichment, validTo: order.validTo ?? null });
  }

  if (newlyFetched.length > 0) {
    await cacheFlashLoanEnrichment(context, chainId, newlyFetched);
  }

  return result;
}
