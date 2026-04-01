/**
 * Orderbook polling handler — discovers open and expired discrete orders.
 *
 * Fires every ORDERBOOK_POLL_INTERVAL blocks on each configured chain.
 * For each owner with an active conditional order, fetches their orders from
 * the CoW Orderbook API, filters for EIP-1271 signed orders, decodes the
 * signature to find the matching conditionalOrderGenerator, and upserts a
 * discrete_order row.
 *
 * Caching: per-owner API responses are stored in orderbook_cache with a short
 * TTL. That table is created by setup.ts via raw DDL (not in ponder.schema.ts)
 * so it survives Ponder full resyncs.
 *
 * Source: COW-737 | Reference: thoughts/reference_docs/m3-orderbook-api-research.md
 */

import { ponder } from "ponder:registry";
import {
  conditionalOrderGenerator,
  discreteOrder,
} from "ponder:schema";
import { and, eq, sql } from "ponder";
import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { COMPOSABLE_COW_HANDLER_ADDRESSES, ORDERBOOK_API_URLS } from "../../data";
import { decodeEip1271Signature } from "../decoders/erc1271Signature";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Stop processing API orders older than this window. */
const MAX_ORDER_LIFETIME_SECONDS = 7 * 24 * 60 * 60; // 7 days

/** Cache TTL for open orders (seconds). Terminal states cache indefinitely until evicted. */
const OPEN_ORDER_CACHE_TTL_SECONDS = 60;

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

// ─── Handler registrations ────────────────────────────────────────────────────
// One entry per chain. Both call the shared poll implementation.
// To add a new chain: add a matching OrderbookPoller<Chain> entry in ponder.config.ts
// and register a handler here.

ponder.on("OrderbookPollerMainnet:block", async ({ event, context }) => {
  await runOrderbookPoll(event, context);
});

ponder.on("OrderbookPollerGnosis:block", async ({ event, context }) => {
  await runOrderbookPoll(event, context);
});

// ─── Shared implementation ────────────────────────────────────────────────────

async function runOrderbookPoll(
  event: { block: { number: bigint; timestamp: bigint } },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
): Promise<void> {
  if (process.env.DISABLE_ORDERBOOK_POLL) {
    console.log(`[COW:OB:POLL] DISABLE_ORDERBOOK_POLL=true — skipping`);
    return;
  }

  const chainId: number = context.chain.id;
  const apiBaseUrl: string | undefined = ORDERBOOK_API_URLS[chainId];
  if (!apiBaseUrl) {
    console.warn(`[COW:OB:POLL] No API URL for chainId=${chainId} — skipping`);
    return;
  }

  const blockNumber: bigint = event.block.number;
  const blockTimestamp = Number(event.block.timestamp);
  const cutoffTimestamp = blockTimestamp - MAX_ORDER_LIFETIME_SECONDS;

  // Distinct owners with at least one Active conditional order on this chain
  const activeOwners = await context.db.sql
    .selectDistinct({ owner: conditionalOrderGenerator.owner })
    .from(conditionalOrderGenerator)
    .where(
      and(
        eq(conditionalOrderGenerator.chainId, chainId),
        eq(conditionalOrderGenerator.status, "Active"),
      ),
    ) as { owner: Hex }[];

  if (activeOwners.length === 0) return;

  console.log(
    `[COW:OB:POLL] ENTER block=${blockNumber} chain=${chainId} owners=${activeOwners.length}`,
  );

  let totalDiscovered = 0;
  let cacheHits = 0;

  for (const { owner } of activeOwners) {
    const { discovered, cacheHit } = await processOwner(
      context,
      chainId,
      apiBaseUrl,
      owner,
      blockTimestamp,
      cutoffTimestamp,
    );
    totalDiscovered += discovered;
    if (cacheHit) cacheHits++;
  }

  console.log(
    `[COW:OB:POLL] DONE block=${blockNumber} chain=${chainId} owners=${activeOwners.length} discovered=${totalDiscovered} cacheHits=${cacheHits}`,
  );
}

// ─── Per-owner processing ─────────────────────────────────────────────────────

async function processOwner(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  apiBaseUrl: string,
  owner: Hex,
  blockTimestamp: number,
  cutoffTimestamp: number,
): Promise<{ discovered: number; cacheHit: boolean }> {
  const cacheKey = `${chainId}:${owner}`;

  // Try cache first
  const cached = await getCached(context, cacheKey, blockTimestamp);
  let orders: OrderbookOrder[];
  let cacheHit = false;

  if (cached !== null) {
    orders = JSON.parse(cached) as OrderbookOrder[];
    cacheHit = true;
  } else {
    const url = `${apiBaseUrl}/api/v1/account/${owner}/orders`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        console.warn(
          `[COW:OB:POLL] API ${response.status} owner=${owner} chain=${chainId}`,
        );
        return { discovered: 0, cacheHit: false };
      }
      orders = (await response.json()) as OrderbookOrder[];
    } catch (err) {
      console.warn(`[COW:OB:POLL] Fetch failed owner=${owner} err=${err}`);
      return { discovered: 0, cacheHit: false };
    }

    const expiresAt = blockTimestamp + OPEN_ORDER_CACHE_TTL_SECONDS;
    await setCached(context, cacheKey, JSON.stringify(orders), blockTimestamp, expiresAt);
  }

  let discovered = 0;

  for (const order of orders) {
    // Stop-early: API returns orders newest-first; once past the window, done.
    const orderTimestamp = Math.floor(new Date(order.creationDate).getTime() / 1000);
    if (orderTimestamp < cutoffTimestamp) break;

    if (order.signingScheme !== "eip1271") continue;
    if (order.status === "presignaturePending") continue;

    const upserted = await processOrder(context, chainId, order);
    if (upserted) discovered++;
  }

  return { discovered, cacheHit };
}

// ─── Per-order processing ─────────────────────────────────────────────────────

async function processOrder(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  order: OrderbookOrder,
): Promise<boolean> {
  const decoded = decodeEip1271Signature(order.signature as Hex);
  if (!decoded) {
    console.warn(`[COW:OB:POLL] Decode failed uid=${order.uid}`);
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
    // Generator not yet indexed (event not yet processed) — skip, will retry next poll
    return false;
  }

  const generator = generators[0]!;

  // Derive TWAP partIndex when t0 (startTime) is known from decoded params.
  // Formula: partIndex = (validTo - t0) / t - 1
  // When t0 === 0 (most TWAP orders use t0=0, meaning "start at first fill"),
  // we cannot derive partIndex without observing the first discrete order — leave null.
  let partIndex: bigint | null = null;
  if (generator.orderType === "TWAP" && generator.decodedParams) {
    const t0 = BigInt(generator.decodedParams["t0"] ?? "0");
    const t = BigInt(generator.decodedParams["t"] ?? "0");
    if (t0 > 0n && t > 0n) {
      const validTo = BigInt(order.validTo);
      partIndex = (validTo - t0) / t - 1n;
    }
  }

  const creationDate = BigInt(
    Math.floor(new Date(order.creationDate).getTime() / 1000),
  );

  // Upsert: on conflict update status only (other fields are immutable once set;
  // filledAtBlock is authoritative from the trade event handler COW-736)
  await context.db
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
      detectedBy: "orderbook_api" as const,
      creationDate,
    })
    .onConflictDoUpdate({
      target: [discreteOrder.chainId, discreteOrder.orderUid],
      set: { status: order.status },
    });

  return true;
}

// ─── orderbook_cache helpers ──────────────────────────────────────────────────
// orderbook_cache is created via raw DDL in setup.ts — not in ponder.schema.ts.
// Queries must go through context.db.sql.execute with sql tagged templates.

async function getCached(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  cacheKey: string,
  nowSeconds: number,
): Promise<string | null> {
  const result = await context.db.sql.execute(
    sql`SELECT response_json FROM orderbook_cache
        WHERE cache_key = ${cacheKey} AND expires_at > ${nowSeconds}`,
  ) as { rows: { response_json: string }[] };
  return result.rows.length > 0 ? result.rows[0]!.response_json : null;
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
    sql`INSERT INTO orderbook_cache (cache_key, response_json, fetched_at, expires_at)
        VALUES (${cacheKey}, ${responseJson}, ${fetchedAt}, ${expiresAt})
        ON CONFLICT (cache_key) DO UPDATE SET
          response_json = EXCLUDED.response_json,
          fetched_at    = EXCLUDED.fetched_at,
          expires_at    = EXCLUDED.expires_at`,
  );
}
