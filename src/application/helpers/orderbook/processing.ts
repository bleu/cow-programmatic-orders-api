import { and, eq, inArray } from "ponder";
import type { Context } from "ponder:registry";
import {
  conditionalOrderGenerator,
} from "ponder:schema";
import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { type OrderType } from "../../../utils/order-types";
import { COMPOSABLE_COW_HANDLER_ADDRESSES } from "../../../data";
import { SIGNING_SCHEME_EIP1271 } from "../../../constants";
import { decodeEip1271Signature } from "../../decoders/erc1271Signature";
import { fetchOrdersByUids } from "./http";
import { upsertComposableCache } from "./cache";
import {
  TERMINAL_STATUSES,
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
      executedFeeAmount: order.executedFeeAmount,
    });
  }

  return results;
}

/** Re-check non-terminal cached rows via by_uids; update status/validTo/executed and
 *  re-persist any that became terminal. Mutates and returns `rows`. */
export async function reconcileOpenCachedRows(
  context: Context,
  chainId: number,
  owner: Hex,
  apiBaseUrl: string,
  rows: ComposableCacheRow[],
): Promise<ComposableCacheRow[]> {
  const openUids = rows.filter((r) => !TERMINAL_STATUSES.has(r.status)).map((r) => r.orderUid);
  if (openUids.length === 0) return rows;

  const refreshed = await fetchOrdersByUids(apiBaseUrl, openUids);
  if (refreshed.length === 0) return rows;
  const byUid = new Map(refreshed.map((o) => [o.uid, o]));

  const newlyTerminal: ComposableCacheRow[] = [];
  for (const row of rows) {
    const fresh = byUid.get(row.orderUid);
    if (!fresh) continue;
    row.status = fresh.status;
    row.validTo = fresh.validTo;
    row.executedSellAmount = fresh.executedSellAmount;
    row.executedBuyAmount = fresh.executedBuyAmount;
    row.executedFeeAmount = fresh.executedFeeAmount;
    if (TERMINAL_STATUSES.has(fresh.status)) newlyTerminal.push(row);
  }

  if (newlyTerminal.length > 0) {
    await upsertComposableCache(context, chainId, owner, newlyTerminal);
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
      executedSellAmount: row.executedSellAmount,
      executedBuyAmount: row.executedBuyAmount,
      executedFeeAmount:
        row.executedFeeAmount ?? (row.status === "fulfilled" ? row.feeAmount : null),
    });
  }
  return results;
}
