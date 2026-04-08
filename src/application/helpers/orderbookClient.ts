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
import { and, eq, sql } from "ponder";
import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { COMPOSABLE_COW_HANDLER_ADDRESSES, ORDERBOOK_API_URLS } from "../../data";
import { SIGNING_SCHEME_EIP1271 } from "../../constants";
import { decodeEip1271Signature } from "../decoders/erc1271Signature";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Raw API response shape (subset of fields we use). */
interface OrderbookOrder {
  uid: string;
  status: "open" | "fulfilled" | "expired" | "cancelled" | "presignaturePending";
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  validTo: number;
  creationDate: string; // ISO 8601
  signingScheme: string;
  signature: string;
}

/** Batch endpoint wraps each order in { order: ... }. */
interface BatchOrderResponse {
  order: OrderbookOrder;
}

/** Processed composable order stored in cache and returned to callers. */
export interface ComposableOrder {
  uid: string;
  status: "open" | "fulfilled" | "expired" | "cancelled";
  generatorId: string;
  generatorHash: string;
  orderType: string;
  partIndex: bigint | null;
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  validTo: number;
  creationDate: number; // unix timestamp
}

const TERMINAL_STATUSES = new Set(["fulfilled", "expired", "cancelled"]);
const PAGE_LIMIT = 1000;

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
    console.warn(`[COW:OB] No API URL for chainId=${chainId}`);
    return [];
  }

  console.log(`[COW:OB] FETCH owner=${owner} chain=${chainId}`);
  const allApiOrders = await fetchAccountOrders(apiBaseUrl, owner);
  const composable = await filterAndProcess(context, chainId, allApiOrders);

  if (composable.length === 0) {
    console.log(`[COW:OB] owner=${owner} chain=${chainId} apiTotal=${allApiOrders.length} composable=0`);
    return [];
  }

  // Check UID cache for terminal statuses
  const cachedStatuses = await getCachedUidStatuses(context, chainId, composable.map((o) => o.uid));

  const toRefresh: string[] = [];
  const results: ComposableOrder[] = [];

  for (const order of composable) {
    const cached = cachedStatuses.get(order.uid);
    if (cached && TERMINAL_STATUSES.has(cached)) {
      // Use cached terminal status — skip API refresh
      results.push({ ...order, status: cached as ComposableOrder["status"] });
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

  console.log(
    `[COW:OB] owner=${owner} chain=${chainId} apiTotal=${allApiOrders.length} composable=${composable.length} cached=${composable.length - toRefresh.length} refreshed=${toRefresh.length}`,
  );
  return results;
}

/**
 * Invalidate the UID cache for orders belonging to an owner's generators.
 * Called when ConditionalOrderCreated fires so that the next fetch discovers new orders.
 *
 * Note: This is a no-op for per-UID cache since new orders won't have cache entries.
 * Kept for API compatibility; callers may add owner-level invalidation logic later.
 */
export async function invalidateOwnerCache(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _context: any,
  _chainId: number,
  _owner: Hex,
): Promise<void> {
  // Per-UID cache doesn't need owner-level invalidation — new orders
  // won't have cache entries, so they'll be fetched fresh from the API.
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
  let count = 0;
  for (const order of orders) {
    await context.db.sql
      .insert(discreteOrder)
      .values({
        orderUid: order.uid,
        chainId,
        conditionalOrderGeneratorId: order.generatorId,
        status: order.status,
        partIndex: order.partIndex,
        sellAmount: order.sellAmount,
        buyAmount: order.buyAmount,
        feeAmount: order.feeAmount,
        validTo: order.validTo,
        creationDate: BigInt(order.creationDate),
      })
      .onConflictDoUpdate({
        target: [discreteOrder.chainId, discreteOrder.orderUid],
        set: { status: order.status, validTo: order.validTo },
      });
    count++;
  }
  return count;
}

/**
 * Fetch order statuses by UIDs from the API, using the per-UID cache.
 * Returns a Map of uid -> status. Used by the backfill handler to check
 * pre-computed UIDs without a full owner fetch.
 */
export async function fetchOrderStatusByUids(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  uids: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (uids.length === 0) return result;

  const apiBaseUrl = ORDERBOOK_API_URLS[chainId];
  if (!apiBaseUrl) return result;

  // Check cache first
  const cached = await getCachedUidStatuses(context, chainId, uids);
  const toFetch: string[] = [];

  for (const uid of uids) {
    const cachedStatus = cached.get(uid);
    if (cachedStatus && TERMINAL_STATUSES.has(cachedStatus)) {
      result.set(uid, cachedStatus);
    } else {
      toFetch.push(uid);
    }
  }

  // Batch-fetch non-cached UIDs
  if (toFetch.length > 0) {
    const fetched = await fetchOrdersByUids(apiBaseUrl, toFetch);
    const newTerminal: ComposableOrder[] = [];

    for (const order of fetched) {
      result.set(order.uid, order.status);
      if (TERMINAL_STATUSES.has(order.status)) {
        newTerminal.push({
          uid: order.uid,
          status: order.status as ComposableOrder["status"],
          generatorId: "",
          generatorHash: "",
          orderType: "",
          partIndex: null,
          sellAmount: order.sellAmount,
          buyAmount: order.buyAmount,
          feeAmount: order.feeAmount,
          validTo: order.validTo,
          creationDate: 0,
        });
      }
    }

    if (newTerminal.length > 0) {
      await cacheUidStatuses(context, chainId, newTerminal);
    }
  }

  return result;
}

// ─── API calls ───────────────────────────────────────────────────────────────

/** Fetch all orders for an owner with pagination. */
async function fetchAccountOrders(
  apiBaseUrl: string,
  owner: Hex,
): Promise<OrderbookOrder[]> {
  const allOrders: OrderbookOrder[] = [];
  let offset = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const url = `${apiBaseUrl}/api/v1/account/${owner}/orders?limit=${PAGE_LIMIT}&offset=${offset}`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        console.warn(`[COW:OB] API ${response.status} owner=${owner}`);
        break;
      }
      const page = (await response.json()) as OrderbookOrder[];
      allOrders.push(...page);
      if (page.length < PAGE_LIMIT) break; // last page
      offset += page.length;
    } catch (err) {
      console.warn(`[COW:OB] Fetch failed owner=${owner} err=${err}`);
      break;
    }
  }

  return allOrders;
}

/** Batch-fetch orders by UID to refresh status of open orders. */
async function fetchOrdersByUids(
  apiBaseUrl: string,
  uids: string[],
): Promise<OrderbookOrder[]> {
  if (uids.length === 0) return [];

  const url = `${apiBaseUrl}/api/v1/orders/by_uids`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(uids),
    });
    if (!response.ok) {
      console.warn(`[COW:OB] Batch fetch ${response.status} uids=${uids.length}`);
      return [];
    }
    const results = (await response.json()) as BatchOrderResponse[];
    return results.map((r) => r.order);
  } catch (err) {
    console.warn(`[COW:OB] Batch fetch failed err=${err}`);
    return [];
  }
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

    // Find the generator — there should be exactly one per (chainId, hash)
    const generators = (await context.db.sql
      .select({
        eventId: conditionalOrderGenerator.eventId,
        orderType: conditionalOrderGenerator.orderType,
        decodedParams: conditionalOrderGenerator.decodedParams,
      })
      .from(conditionalOrderGenerator)
      .where(
        and(
          eq(conditionalOrderGenerator.chainId, chainId),
          eq(conditionalOrderGenerator.hash, paramHash),
        ),
      )
      .limit(1)) as {
      eventId: string;
      orderType: string;
      decodedParams: Record<string, string> | null;
    }[];

    if (generators.length === 0) continue;

    const generator = generators[0]!;

    // Derive TWAP partIndex when t0 is known
    let partIndex: bigint | null = null;
    if (generator.orderType === "TWAP" && generator.decodedParams) {
      const t0 = BigInt(generator.decodedParams["t0"] ?? "0");
      const t = BigInt(generator.decodedParams["t"] ?? "0");
      if (t0 > 0n && t > 0n) {
        partIndex = (BigInt(order.validTo) + 1n - t0) / t - 1n;
      }
    }

    results.push({
      uid: order.uid,
      status: order.status as ComposableOrder["status"],
      generatorId: generator.eventId,
      generatorHash: paramHash,
      orderType: generator.orderType,
      partIndex,
      sellAmount: order.sellAmount,
      buyAmount: order.buyAmount,
      feeAmount: order.feeAmount,
      validTo: order.validTo,
      creationDate: Math.floor(new Date(order.creationDate).getTime() / 1000),
    });
  }

  return results;
}

// ─── Per-UID cache helpers ──────────────────────────────────────────────────
// cow_cache.order_uid_cache is created by setup.ts. Fully qualified names required.

/** Get cached statuses for a list of UIDs. Returns a Map of uid -> status. */
async function getCachedUidStatuses(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  uids: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (uids.length === 0) return result;

  try {
    // Query in batches to avoid overly long IN clauses
    const batchSize = 500;
    for (let i = 0; i < uids.length; i += batchSize) {
      const batch = uids.slice(i, i + batchSize);
      const placeholders = batch.map((uid) => `'${uid.replace(/'/g, "''")}'`).join(",");
      const rows = (await context.db.sql.execute(
        sql.raw(
          `SELECT order_uid, status FROM cow_cache.order_uid_cache
           WHERE chain_id = ${chainId} AND order_uid IN (${placeholders})`,
        ),
      )) as { order_uid: string; status: string }[];
      for (const row of rows) {
        result.set(row.order_uid, row.status);
      }
    }
  } catch {
    // Cache miss on error — will re-fetch from API
  }

  return result;
}

/** Cache terminal statuses for composable orders. */
async function cacheUidStatuses(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  orders: ComposableOrder[],
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  for (const order of orders) {
    try {
      await context.db.sql.execute(
        sql`INSERT INTO cow_cache.order_uid_cache (chain_id, order_uid, status, fetched_at)
            VALUES (${chainId}, ${order.uid}, ${order.status}, ${now})
            ON CONFLICT (chain_id, order_uid) DO UPDATE SET
              status     = EXCLUDED.status,
              fetched_at = EXCLUDED.fetched_at`,
      );
    } catch {
      // Best-effort cache write
    }
  }
}
