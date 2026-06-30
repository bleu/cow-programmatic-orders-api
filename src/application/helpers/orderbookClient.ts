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

import {
  conditionalOrderGenerator,
  discreteOrder,
} from "ponder:schema";
import { and, eq, inArray, sql } from "ponder";
import { pgSchema, integer, text } from "drizzle-orm/pg-core";
import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { type OrderType } from "../../utils/order-types";
import { COMPOSABLE_COW_HANDLER_ADDRESSES, ORDERBOOK_API_URLS } from "../../data";
import {
  BOOTSTRAP_MAX_PAGES,
  BOOTSTRAP_PAGE_SIZE,
  ORDERBOOK_HTTP_TIMEOUT_MS,
  ORDERBOOK_MAX_RETRIES,
  ORDERBOOK_RETRY_BASE_MS,
  ORDERBOOK_RETRY_BUDGET_MS,
  ORDERBOOK_RETRY_MAX_DELAY_MS,
  SIGNING_SCHEME_EIP1271,
} from "../../constants";
import { decodeEip1271Signature } from "../decoders/erc1271Signature";
import { fetchWithTimeout, TimeoutError, withTimeout } from "./withTimeout";
import { log } from "./logger";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Raw API response shape (subset of fields we use). */
interface OrderbookOrder {
  uid: string;
  status: "open" | "fulfilled" | "expired" | "cancelled" | "presignaturePending";
  kind: "sell" | "buy";
  receiver: string | null;
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  validTo: number;
  creationDate: string; // ISO 8601
  signingScheme: string;
  signature: string;
  executedSellAmount: string;
  executedBuyAmount: string;
}

/** Processed composable order stored in cache and returned to callers.
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
const PAGE_LIMIT = 1000;
const BATCH_SIZE = 50;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch composable orders for an owner, using per-UID cache for terminal orders.
 *
 * 1. Full fetch from /account/{owner}/orders, filter to eip1271, match to generators
 * 2. For each composable order: check UID cache — if terminal, use cached status
 * 3. Batch-refresh non-cached/open UIDs via POST /orders/by_uids
 * 4. Cache terminal results
 */
export async function fetchComposableOrders(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  owner: Hex,
): Promise<ComposableOrder[]> {
  const apiBaseUrl = ORDERBOOK_API_URLS[chainId];
  if (!apiBaseUrl) {
    log("warn", "ob:noApiUrl", { chainId });
    return [];
  }

  log("info", "ob:fetch", { owner, chainId });
  const allApiOrders = await fetchAccountOrders(apiBaseUrl, owner, BOOTSTRAP_MAX_PAGES, SIGNING_SCHEME_EIP1271, BOOTSTRAP_PAGE_SIZE);
  const composable = await filterAndProcess(context, chainId, allApiOrders);

  if (composable.length === 0) {
    log("info", "ob:fetchResult", { owner, chainId, apiTotal: allApiOrders.length, composable: 0 });
    return [];
  }

  // Check UID cache for terminal statuses
  const cachedStatuses = await getCachedUidStatuses(context, chainId, composable.map((o) => o.uid));

  const toRefresh: string[] = [];
  const results: ComposableOrder[] = [];

  for (const order of composable) {
    const cached = cachedStatuses.get(order.uid);
    if (cached && TERMINAL_STATUSES.has(cached.status)) {
      // Use cached terminal status — skip API refresh
      results.push({ ...order, status: cached.status as ComposableOrder["status"] });
    } else {
      toRefresh.push(order.uid);
      results.push(order);
    }
  }

  // Batch-refresh non-cached/open UIDs
  if (toRefresh.length > 0) {
    const refreshed = await fetchOrdersByUids(apiBaseUrl, toRefresh);
    const refreshedByUid = new Map(refreshed.map((o) => [o.uid, o]));

    for (const result of results) {
      const fresh = refreshedByUid.get(result.uid);
      if (fresh && toRefresh.includes(result.uid)) {
        result.status = fresh.status as ComposableOrder["status"];
        result.validTo = fresh.validTo;
        result.executedSellAmount = fresh.executedSellAmount;
        result.executedBuyAmount = fresh.executedBuyAmount;
      }
    }

    // Cache any newly terminal results
    const newTerminal = results.filter(
      (o) => toRefresh.includes(o.uid) && TERMINAL_STATUSES.has(o.status),
    );
    if (newTerminal.length > 0) {
      await cacheUidStatuses(context, chainId, newTerminal);
    }
  }

  log("info", "ob:fetchResult", { owner, chainId, apiTotal: allApiOrders.length, composable: composable.length, cached: composable.length - toRefresh.length, refreshed: toRefresh.length });
  return results;
}

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
  const orders = await fetchAccountOrders(apiBaseUrl, owner, maxPages);
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
 * never goes stale — it is cached in cow_cache.flash_loan_order_cache, which
 * survives reindex, so a schema-hash change does not re-hit the orderbook for
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

// ─── API calls ───────────────────────────────────────────────────────────────

/**
 * The orderbook API refused to answer (HTTP 429 or 5xx) after bounded retries.
 * Distinct from "the API has no such order" (a UID simply absent from a 2xx
 * body) so callers / dashboards can alarm on an unavailable API rather than
 * silently treating it as "order not on API yet".
 */
export class OrderbookUnavailableError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
  ) {
    super(`[COW:orderbook-unavailable] ${endpoint} responded ${status}`);
    this.name = "OrderbookUnavailableError";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds; null if absent/unparseable. */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

/**
 * `fetchWithTimeout` plus bounded retry/backoff for transient orderbook errors.
 *
 * Returns the Response on a 2xx. On 429 it honors `Retry-After` (capped at
 * ORDERBOOK_RETRY_MAX_DELAY_MS); on 5xx it uses exponential backoff. Retries
 * stop once ORDERBOOK_MAX_RETRIES is reached or the next sleep would push the
 * loop past ORDERBOOK_RETRY_BUDGET_MS — at which point it throws
 * OrderbookUnavailableError instead of holding the block transaction open.
 * A TimeoutError from the underlying fetch propagates unchanged.
 */
async function fetchOrderbook(
  url: string,
  init: RequestInit | undefined,
  endpoint: string,
): Promise<Response> {
  let spent = 0;
  for (let attempt = 0; ; attempt++) {
    const response = await fetchWithTimeout(url, init, ORDERBOOK_HTTP_TIMEOUT_MS, endpoint);
    if (response.ok) return response;

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= ORDERBOOK_MAX_RETRIES) {
      throw new OrderbookUnavailableError(response.status, endpoint);
    }

    const retryAfterMs =
      response.status === 429 ? parseRetryAfter(response.headers.get("retry-after")) : null;
    const backoffMs = ORDERBOOK_RETRY_BASE_MS * 2 ** attempt;
    const delay = Math.min(retryAfterMs ?? backoffMs, ORDERBOOK_RETRY_MAX_DELAY_MS);

    // Fail fast rather than hold the block transaction open past our budget.
    if (spent + delay > ORDERBOOK_RETRY_BUDGET_MS) {
      throw new OrderbookUnavailableError(response.status, endpoint);
    }

    log("warn", "ob:retry", { endpoint, status: response.status, attempt: attempt + 1, delayMs: delay, retryAfterMs });
    await sleep(delay);
    spent += delay;
  }
}

/** Fetch orders for an owner with pagination. maxPages limits how many pages are fetched (0 = unlimited).
 *  signingScheme, if provided, is appended as a query param — the API filters server-side when supported,
 *  reducing payload for owners with many ECDSA orders mixed with composable ones.
 *  pageSize overrides the default PAGE_LIMIT per request. */
async function fetchAccountOrders(
  apiBaseUrl: string,
  owner: Hex,
  maxPages = 0,
  signingScheme?: string,
  pageSize = PAGE_LIMIT,
): Promise<OrderbookOrder[]> {
  const allOrders: OrderbookOrder[] = [];
  let offset = 0;
  let pagesFetched = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
    if (signingScheme) params.set("signingScheme", signingScheme);
    const url = `${apiBaseUrl}/api/v1/account/${owner}/orders?${params.toString()}`;
    try {
      const response = await fetchOrderbook(url, undefined, "ob:account");
      const page = (await response.json()) as OrderbookOrder[];
      allOrders.push(...page);
      pagesFetched++;
      if (page.length < pageSize) break; // last page
      if (maxPages > 0 && pagesFetched >= maxPages) break; // page cap reached
      offset += page.length;
    } catch (err) {
      if (err instanceof OrderbookUnavailableError) {
        log("error", "ob:unavailable", { endpoint: "ob:account", status: err.status, owner });
        break;
      }
      if (err instanceof TimeoutError) {
        log("warn", "ob:accountTimeout", { owner, offset, after: ORDERBOOK_HTTP_TIMEOUT_MS });
        break;
      }
      log("warn", "ob:accountFetchFailed", { owner, err: String(err) });
      break;
    }
  }

  return allOrders;
}

/** Batch-fetch orders by UID to refresh status of open orders.
 *  Chunks into BATCH_SIZE to avoid HTTP 413, then fires all chunks in parallel
 *  so N chunks take the time of one instead of N × one. */
async function fetchOrdersByUids(
  apiBaseUrl: string,
  uids: string[],
): Promise<OrderbookOrder[]> {
  if (uids.length === 0) return [];

  const url = `${apiBaseUrl}/api/v1/orders/by_uids`;
  const chunks: string[][] = [];
  for (let i = 0; i < uids.length; i += BATCH_SIZE) {
    chunks.push(uids.slice(i, i + BATCH_SIZE));
  }

  const chunkResults = await Promise.all(
    chunks.map(async (chunk, idx) => {
      try {
        const response = await fetchOrderbook(
          url,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(chunk),
          },
          "ob:byUids",
        );
        const raw = (await response.json()) as { order: OrderbookOrder }[];
        return raw.flatMap((item) => (item?.order != null ? [item.order] : []));
      } catch (err) {
        if (err instanceof OrderbookUnavailableError) {
          log("error", "ob:unavailable", { endpoint: "ob:byUids", status: err.status, uids: chunk.length, offset: idx * BATCH_SIZE });
          return [] as OrderbookOrder[];
        }
        if (err instanceof TimeoutError) {
          log("warn", "ob:batchFetchTimeout", { uids: chunk.length, offset: idx * BATCH_SIZE, after: ORDERBOOK_HTTP_TIMEOUT_MS });
          return [] as OrderbookOrder[];
        }
        log("warn", "ob:batchFetchFailed", { err: String(err), offset: idx * BATCH_SIZE });
        return [] as OrderbookOrder[];
      }
    }),
  );

  return chunkResults.flat();
}

// ─── Processing ──────────────────────────────────────────────────────────────

/** Filter API orders to composable eip1271, decode signatures, match to generators. */
async function filterAndProcess(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  apiOrders: OrderbookOrder[],
): Promise<ComposableOrder[]> {
  const results: ComposableOrder[] = [];

  for (const order of apiOrders) {
    if (order.signingScheme !== SIGNING_SCHEME_EIP1271) continue;
    if (order.status === "presignaturePending") continue;

    const decoded = decodeEip1271Signature(order.signature as Hex);
    if (!decoded) continue;

    if (!COMPOSABLE_COW_HANDLER_ADDRESSES.has(decoded.handler)) continue;

    // Reproduce the same hash stored in conditionalOrderGenerator.hash
    const paramHash = keccak256(
      encodeAbiParameters(
        [
          {
            type: "tuple",
            components: [
              { name: "handler", type: "address" },
              { name: "salt", type: "bytes32" },
              { name: "staticInput", type: "bytes" },
            ],
          },
        ],
        [{ handler: decoded.handler, salt: decoded.salt, staticInput: decoded.staticInput }],
      ),
    );

    // Find the generator — there should be exactly one per (chainId, hash).
    // Uses context.db.sql (raw SQL) because Ponder ORM has no non-PK findMany.
    // Wrapped in try-catch: in multichain realtime mode a shared-qb race can cause
    // a SAVEPOINT error here; skipping the order is safe — it's retried next block.
    let generators: { eventId: string; orderType: OrderType }[];
    try {
      generators = (await context.db.sql
        .select({
          eventId: conditionalOrderGenerator.eventId,
          orderType: conditionalOrderGenerator.orderType,
        })
        .from(conditionalOrderGenerator)
        .where(
          and(
            eq(conditionalOrderGenerator.chainId, chainId),
            eq(conditionalOrderGenerator.hash, paramHash),
          ),
        )
        .limit(1)) as { eventId: string; orderType: OrderType }[];
    } catch {
      continue;
    }

    if (generators.length === 0) continue;

    const generator = generators[0]!;

    results.push({
      uid: order.uid,
      status: order.status as ComposableOrder["status"],
      generatorId: generator.eventId,
      generatorHash: paramHash,
      orderType: generator.orderType,
      sellAmount: order.sellAmount,
      buyAmount: order.buyAmount,
      feeAmount: order.feeAmount,
      validTo: order.validTo,
      creationDate: BigInt(Math.floor(new Date(order.creationDate).getTime() / 1000)),
      executedSellAmount: order.executedSellAmount,
      executedBuyAmount: order.executedBuyAmount,
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
