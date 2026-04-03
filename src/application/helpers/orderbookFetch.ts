/**
 * Shared orderbook fetch + match utility.
 *
 * Fetches all orders for an owner from the CoW Orderbook API, filters for
 * EIP-1271 signed composable cow orders, decodes signatures to match them
 * to their on-chain conditionalOrderGenerator, and upserts discrete_order rows.
 *
 * Used by composableCow.ts (fetch-on-creation) and potentially by future
 * sync recovery mechanisms.
 *
 * Cache: per-owner API responses are stored in cow_cache.orderbook_cache.
 * Terminal-status owners (all orders fulfilled/expired/cancelled) are cached
 * permanently. Owners with open orders are not cached — always re-fetched.
 *
 * Source: COW-737 (refactored from orderbookPoller.ts)
 */

import {
  conditionalOrderGenerator,
  discreteOrder,
} from "ponder:schema";
import { and, eq, sql } from "ponder";
import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { COMPOSABLE_COW_HANDLER_ADDRESSES } from "../../data";
import {
  MAX_ORDER_LIFETIME_SECONDS,
  SIGNING_SCHEME_EIP1271,
  TERMINAL_CACHE_EXPIRY_SECONDS,
} from "../../constants";
import { decodeEip1271Signature } from "../decoders/erc1271Signature";

// ─── API response shape ───────────────────────────────────────────────────────

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

/** Statuses that cannot transition — safe to cache indefinitely. */
const TERMINAL_STATUSES = new Set(["fulfilled", "expired", "cancelled", "unfilled"]);

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch all orders for an owner and upsert matching discrete orders.
 *
 * Returns the number of discrete orders discovered/updated.
 */
export async function fetchAndMatchOwnerOrders(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  apiBaseUrl: string,
  owner: Hex,
  blockTimestamp: number,
): Promise<number> {
  const cacheKey = `${chainId}:${owner}`;
  const cutoffTimestamp = blockTimestamp - MAX_ORDER_LIFETIME_SECONDS;

  // Try cache first
  const cached = await getCached(context, cacheKey, blockTimestamp);
  let orders: OrderbookOrder[];

  if (cached !== null) {
    orders = JSON.parse(cached) as OrderbookOrder[];
    console.log(
      `[COW:OB:FETCH] CACHE HIT owner=${owner} chain=${chainId} orders=${orders.length}`,
    );
  } else {
    const url = `${apiBaseUrl}/api/v1/account/${owner}/orders`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        console.warn(
          `[COW:OB:FETCH] API ${response.status} owner=${owner} chain=${chainId}`,
        );
        return 0;
      }
      orders = (await response.json()) as OrderbookOrder[];
    } catch (err) {
      console.warn(`[COW:OB:FETCH] Fetch failed owner=${owner} err=${err}`);
      return 0;
    }

    // Cache terminal-only owners permanently; skip caching if any orders are still open
    const allTerminal = orders.length > 0 && orders.every((o) => TERMINAL_STATUSES.has(o.status));
    if (allTerminal) {
      const expiresAt = blockTimestamp + TERMINAL_CACHE_EXPIRY_SECONDS;
      await setCached(context, cacheKey, JSON.stringify(orders), blockTimestamp, expiresAt);
    }
  }

  let discovered = 0;

  for (const order of orders) {
    // Stop-early: API returns orders newest-first; once past the window, done.
    const orderTimestamp = Math.floor(new Date(order.creationDate).getTime() / 1000);
    if (orderTimestamp < cutoffTimestamp) break;

    if (order.signingScheme !== SIGNING_SCHEME_EIP1271) continue;
    if (order.status === "presignaturePending") continue;

    const upserted = await matchAndUpsertOrder(context, chainId, order);
    if (upserted) discovered++;
  }

  console.log(
    `[COW:OB:FETCH] owner=${owner} chain=${chainId} total=${orders.length} discovered=${discovered}`,
  );

  return discovered;
}

// ─── Per-order matching ──────────────────────────────────────────────────────

async function matchAndUpsertOrder(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  order: OrderbookOrder,
): Promise<boolean> {
  const decoded = decodeEip1271Signature(order.signature as Hex);
  if (!decoded) {
    console.warn(`[COW:OB:FETCH] Decode failed uid=${order.uid}`);
    return false;
  }

  if (!COMPOSABLE_COW_HANDLER_ADDRESSES.has(decoded.handler)) {
    return false;
  }

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
  const generators = await context.db.sql
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
    .limit(1) as {
      eventId: string;
      orderType: string;
      decodedParams: Record<string, string> | null;
    }[];

  if (generators.length === 0) {
    return false;
  }

  const generator = generators[0]!;

  // Derive TWAP partIndex when t0 (startTime) is known from decoded params.
  // Formula: partIndex = (validTo + 1 - t0) / t - 1
  // The contract sets validTo = t0 + (part+1)*t - 1, so inverting requires +1 before dividing.
  // When t0 === 0 (most TWAP orders), we cannot derive partIndex — leave null.
  let partIndex: bigint | null = null;
  if (generator.orderType === "TWAP" && generator.decodedParams) {
    const t0 = BigInt(generator.decodedParams["t0"] ?? "0");
    const t = BigInt(generator.decodedParams["t"] ?? "0");
    if (t0 > 0n && t > 0n) {
      const validTo = BigInt(order.validTo);
      partIndex = (validTo + 1n - t0) / t - 1n;
    }
  }

  const creationDate = BigInt(
    Math.floor(new Date(order.creationDate).getTime() / 1000),
  );

  // Upsert: on conflict update status and validTo only (other fields are immutable;
  // filledAtBlock is authoritative from the trade event handler)
  await context.db.sql
    .insert(discreteOrder)
    .values({
      orderUid: order.uid,
      chainId,
      conditionalOrderGeneratorId: generator.eventId,
      status: order.status,
      partIndex,
      sellAmount: order.sellAmount,
      buyAmount: order.buyAmount,
      feeAmount: order.feeAmount,
      filledAtBlock: null,
      validTo: order.validTo,
      detectedBy: "orderbook_api" as const,
      creationDate,
    })
    .onConflictDoUpdate({
      target: [discreteOrder.chainId, discreteOrder.orderUid],
      set: { status: order.status, validTo: order.validTo },
    });

  return true;
}

// ─── cow_cache.orderbook_cache helpers ───────────────────────────────────────
// cow_cache schema is created by setup.ts. Fully qualified names required.

async function getCached(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  cacheKey: string,
  nowSeconds: number,
): Promise<string | null> {
  const rows = await context.db.sql.execute(
    sql`SELECT response_json FROM cow_cache.orderbook_cache
        WHERE cache_key = ${cacheKey} AND expires_at > ${nowSeconds}`,
  ) as { response_json: string }[];
  return rows.length > 0 ? rows[0]!.response_json : null;
}

async function setCached(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  cacheKey: string,
  responseJson: string,
  fetchedAt: number,
  expiresAt: number,
): Promise<void> {
  await context.db.sql.execute(
    sql`INSERT INTO cow_cache.orderbook_cache (cache_key, response_json, fetched_at, expires_at)
        VALUES (${cacheKey}, ${responseJson}, ${fetchedAt}, ${expiresAt})
        ON CONFLICT (cache_key) DO UPDATE SET
          response_json = EXCLUDED.response_json,
          fetched_at    = EXCLUDED.fetched_at,
          expires_at    = EXCLUDED.expires_at`,
  );
}
