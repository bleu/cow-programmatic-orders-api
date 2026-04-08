/**
 * Orderbook client — fetches and caches composable orders from the CoW Orderbook API.
 *
 * Cache strategy:
 * - Stores only processed composable (eip1271) orders per owner
 * - Always caches, even if owner has open orders
 * - Open orders are refreshed via POST /api/v1/orders/by_uids (cheap batch call)
 * - Cache is invalidated when ConditionalOrderCreated fires for this owner
 * - Terminal orders (fulfilled/expired/cancelled) are never re-fetched
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
import { COMPOSABLE_COW_HANDLER_ADDRESSES } from "../../data";
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

/** Shape stored in cow_cache.orderbook_cache. */
interface CachedOwnerData {
  orders: CachedOrder[];
  fetchedAt: number;
}

/** Serializable version of ComposableOrder for JSON storage. */
interface CachedOrder {
  uid: string;
  status: "open" | "fulfilled" | "expired" | "cancelled";
  generatorId: string;
  generatorHash: string;
  orderType: string;
  partIndex: string | null; // bigint serialized as string
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  validTo: number;
  creationDate: number;
}

const TERMINAL_STATUSES = new Set(["fulfilled", "expired", "cancelled"]);
const PAGE_LIMIT = 1000;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch composable orders for an owner, using cache when possible.
 *
 * - No cache → full fetch from /account/{owner}/orders, filter, cache all
 * - Cache with open orders → refresh only open UIDs via /orders/by_uids
 * - Cache all terminal → return cached, no API call
 */
export async function fetchComposableOrders(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  apiBaseUrl: string,
  owner: Hex,
): Promise<ComposableOrder[]> {
  const cacheKey = `${chainId}:${owner}`;
  const cached = await getCache(context, cacheKey);

  if (cached) {
    const openOrders = cached.orders.filter((o) => o.status === "open");

    if (openOrders.length === 0) {
      // All terminal — use cache as-is
      console.log(
        `[COW:OB] CACHE HIT (all terminal) owner=${owner} chain=${chainId} orders=${cached.orders.length}`,
      );
      return cached.orders.map(deserializeCachedOrder);
    }

    // Refresh only open orders via batch UID endpoint
    const openUids = openOrders.map((o) => o.uid);
    console.log(
      `[COW:OB] CACHE PARTIAL owner=${owner} chain=${chainId} refreshing=${openUids.length} terminal=${cached.orders.length - openUids.length}`,
    );

    const refreshed = await fetchOrdersByUids(apiBaseUrl, openUids);
    const refreshedByUid = new Map(refreshed.map((o) => [o.uid, o]));

    // Merge: update open orders with refreshed status, keep terminal as-is
    const updatedCachedOrders = cached.orders.map((co) => {
      if (co.status !== "open") return co; // terminal — unchanged
      const fresh = refreshedByUid.get(co.uid);
      if (!fresh) return co; // API didn't return it — keep as-is
      return { ...co, status: fresh.status as CachedOrder["status"], validTo: fresh.validTo };
    });

    await setCache(context, cacheKey, { orders: updatedCachedOrders, fetchedAt: Date.now() / 1000 });
    return updatedCachedOrders.map(deserializeCachedOrder);
  }

  // No cache — full fetch
  console.log(`[COW:OB] FULL FETCH owner=${owner} chain=${chainId}`);
  const allApiOrders = await fetchAccountOrders(apiBaseUrl, owner);
  const composable = await filterAndProcess(context, chainId, allApiOrders);

  if (composable.length > 0) {
    await setCache(context, cacheKey, {
      orders: composable.map(serializeComposableOrder),
      fetchedAt: Date.now() / 1000,
    });
  }

  console.log(
    `[COW:OB] owner=${owner} chain=${chainId} apiTotal=${allApiOrders.length} composable=${composable.length}`,
  );
  return composable;
}

/**
 * Invalidate the cache for an owner. Called when ConditionalOrderCreated fires
 * so that the next fetch does a full API call and discovers new orders.
 */
export async function invalidateOwnerCache(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  owner: Hex,
): Promise<void> {
  const cacheKey = `${chainId}:${owner}`;
  await deleteCache(context, cacheKey);
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
        detectedBy: "orderbook_api" as const,
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

// ─── Serialization ───────────────────────────────────────────────────────────

function serializeComposableOrder(o: ComposableOrder): CachedOrder {
  return {
    ...o,
    partIndex: o.partIndex !== null ? o.partIndex.toString() : null,
  };
}

function deserializeCachedOrder(co: CachedOrder): ComposableOrder {
  return {
    ...co,
    partIndex: co.partIndex !== null ? BigInt(co.partIndex) : null,
  };
}

// ─── Cache helpers ───────────────────────────────────────────────────────────
// cow_cache schema is created by setup.ts. Fully qualified names required.

async function getCache(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  cacheKey: string,
): Promise<CachedOwnerData | null> {
  try {
    const rows = (await context.db.sql.execute(
      sql`SELECT response_json FROM cow_cache.orderbook_cache
          WHERE cache_key = ${cacheKey}`,
    )) as { response_json: string }[];
    if (rows.length === 0) return null;
    const parsed = JSON.parse(rows[0]!.response_json);
    // Handle old raw-JSON format gracefully — treat as cache miss
    if (!parsed.orders || !Array.isArray(parsed.orders)) return null;
    return parsed as CachedOwnerData;
  } catch {
    return null;
  }
}

async function setCache(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  cacheKey: string,
  data: CachedOwnerData,
): Promise<void> {
  const json = JSON.stringify(data);
  await context.db.sql.execute(
    sql`INSERT INTO cow_cache.orderbook_cache (cache_key, response_json, fetched_at)
        VALUES (${cacheKey}, ${json}, ${Math.floor(data.fetchedAt)})
        ON CONFLICT (cache_key) DO UPDATE SET
          response_json = EXCLUDED.response_json,
          fetched_at    = EXCLUDED.fetched_at`,
  );
}

async function deleteCache(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  cacheKey: string,
): Promise<void> {
  await context.db.sql.execute(
    sql`DELETE FROM cow_cache.orderbook_cache WHERE cache_key = ${cacheKey}`,
  );
}
