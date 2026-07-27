import { and, eq, inArray } from "ponder";
import type { Context } from "ponder:registry";
import {
  conditionalOrderGenerator,
} from "ponder:schema";
import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { type OrderType } from "../../../utils/order-types";
import {
  COMPOSABLE_COW_HANDLER_ADDRESSES,
  REORG_SAFETY_WINDOW_SECONDS,
  type SupportedChainId,
} from "../../../data";
import { DEFAULT_REORG_SAFETY_WINDOW_SECONDS, SIGNING_SCHEME_EIP1271 } from "../../../constants";
import { decodeEip1271Signature } from "../../decoders/erc1271Signature";
import { fetchOrdersByUids } from "./http";
import { upsertComposableCache } from "./cache";
import { classifyCachedRow } from "./trust";
import {
  toBigIntOrNull,
  type ComposableCacheRow,
  type ComposableOrder,
  type OrderbookOrder,
} from "./types";

// ─── Processing ──────────────────────────────────────────────────────────────

/** Filter API orders to composable eip1271, decode signatures, match to generators. */
export async function filterAndProcess(
  context: Context,
  chainId: number,
  apiOrders: OrderbookOrder[],
): Promise<ComposableOrder[]> {
  // Pure-CPU pass first: decode signatures and reproduce the param hash stored in
  // conditionalOrderGenerator.hash.
  const candidates: { order: OrderbookOrder; paramHash: Hex }[] = [];
  for (const order of apiOrders) {
    if (order.signingScheme !== SIGNING_SCHEME_EIP1271) continue;
    if (order.status === "presignaturePending") continue;

    const decoded = decodeEip1271Signature(order.signature as Hex);
    if (!decoded) continue;

    if (!COMPOSABLE_COW_HANDLER_ADDRESSES.has(decoded.handler)) continue;

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
    candidates.push({ order, paramHash });
  }
  if (candidates.length === 0) return [];

  // Resolve generators with one batched query per 500 hashes instead of a SELECT per
  // order. Uses context.db.sql (raw SQL) because Ponder ORM has no non-PK findMany.
  // Wrapped in try-catch: in multichain realtime mode a shared-qb race can cause a
  // SAVEPOINT error here; skipping the batch is safe — it's retried on a later block.
  const generatorByHash = new Map<string, { eventId: string; orderType: OrderType }>();
  const hashes = [...new Set(candidates.map((c) => c.paramHash))];
  try {
    const batchSize = 500;
    for (let i = 0; i < hashes.length; i += batchSize) {
      const rows = (await context.db.sql
        .select({
          eventId: conditionalOrderGenerator.eventId,
          orderType: conditionalOrderGenerator.orderType,
          hash: conditionalOrderGenerator.hash,
        })
        .from(conditionalOrderGenerator)
        .where(
          and(
            eq(conditionalOrderGenerator.chainId, chainId),
            inArray(conditionalOrderGenerator.hash, hashes.slice(i, i + batchSize)),
          ),
        )) as { eventId: string; orderType: OrderType; hash: string }[];
      for (const row of rows) {
        generatorByHash.set(row.hash, { eventId: row.eventId, orderType: row.orderType });
      }
    }
  } catch {
    return [];
  }

  const results: ComposableOrder[] = [];
  for (const { order, paramHash } of candidates) {
    const generator = generatorByHash.get(paramHash);
    if (!generator) continue;

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
      executedSellAmount: toBigIntOrNull(order.executedSellAmount),
      executedBuyAmount: toBigIntOrNull(order.executedBuyAmount),
      executedFee: toBigIntOrNull(order.executedFee),
    });
  }

  return results;
}

/** Re-check cached rows the trust rule doesn't consider final (open rows, and
 *  terminal rows still inside the chain's reorg window or written by an older
 *  cache version — see trust.ts) via by_uids; update status/validTo/executed
 *  and re-persist every row the fetch touched, including terminal statuses a
 *  reorg reverted back to open. Mutates and returns `rows`. */
export async function reconcileOpenCachedRows(
  context: Context,
  chainId: number,
  owner: Hex,
  apiBaseUrl: string,
  rows: ComposableCacheRow[],
  signal?: AbortSignal,
): Promise<ComposableCacheRow[]> {
  const window =
    REORG_SAFETY_WINDOW_SECONDS[chainId as SupportedChainId] ??
    DEFAULT_REORG_SAFETY_WINDOW_SECONDS;
  const nowSeconds = Math.floor(Date.now() / 1000);

  const staleUids = rows
    .filter((r) =>
      classifyCachedRow(
        {
          status: r.status,
          validTo: r.validTo,
          terminalSince: r.terminalSince ?? null,
          fetchedAt: r.fetchedAt ?? null,
          cacheVersion: r.cacheVersion ?? null,
        },
        nowSeconds,
        window,
      ) !== "trusted",
    )
    .map((r) => r.orderUid);
  if (staleUids.length === 0) return rows;

  const refreshed = await fetchOrdersByUids(apiBaseUrl, staleUids, signal);
  if (refreshed.length === 0) return rows;
  const byUid = new Map(refreshed.map((o) => [o.uid, o]));

  const touched: ComposableCacheRow[] = [];
  for (const row of rows) {
    const fresh = byUid.get(row.orderUid);
    if (!fresh) continue;
    row.status = fresh.status;
    row.validTo = fresh.validTo;
    row.executedSellAmount = fresh.executedSellAmount;
    row.executedBuyAmount = fresh.executedBuyAmount;
    row.executedFee = fresh.executedFee;
    touched.push(row);
  }

  if (touched.length > 0) {
    await upsertComposableCache(context, chainId, owner, touched);
  }
  return rows;
}

/** Map durable rows (keyed by the stable generator_hash) to ComposableOrder with the
 *  current per-deployment generator eventId. Rows with no current generator are dropped. */
export async function remapToCurrentGenerators(
  context: Context,
  chainId: number,
  rows: ComposableCacheRow[],
): Promise<ComposableOrder[]> {
  if (rows.length === 0) return [];
  const hashes = [...new Set(rows.map((r) => r.generatorHash))] as Hex[];

  let generators: { eventId: string; hash: string }[];
  try {
    generators = (await context.db.sql
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
      executedSellAmount: toBigIntOrNull(row.executedSellAmount),
      executedBuyAmount: toBigIntOrNull(row.executedBuyAmount),
      executedFee: toBigIntOrNull(row.executedFee),
    });
  }
  return results;
}
