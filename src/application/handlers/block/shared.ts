import { discreteOrderStatusEnum, flashLoanOrder } from "ponder:schema";
import { and, asc, eq, inArray, isNull, lt, sql } from "ponder";
import type { Hex } from "viem";
import { MAX_FLASH_LOAN_ENRICHMENT_ATTEMPTS } from "../../../constants";
import { fetchFlashLoanEnrichmentByUids } from "../../helpers/orderbookClient";
import { log } from "../../helpers/logger";

export type DiscreteStatus = (typeof discreteOrderStatusEnum.enumValues)[number];

export type PendingFlashLoanRow = {
  orderUid: string;
  adapter: Hex;
  sellToken: Hex;
  buyToken: Hex;
  feeAmount: string;
  txHash: Hex;
  blockNumber: bigint;
  blockTimestamp: bigint;
  validTo: number;
  owner: Hex | null;
  type: "RepayWithCollateral" | "CollateralSwap" | "DebtSwap" | null;
  executedSellAmount: string;
  executedBuyAmount: string;
  enrichmentAttempts: number;
};

/** Select pending (un-enriched, under the attempt cap) flash-loan orders, oldest-first. */
export async function selectPendingFlashLoanOrders(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  limit?: number,
): Promise<PendingFlashLoanRow[]> {
  const query = context.db.sql
    .select({
      orderUid: flashLoanOrder.orderUid,
      adapter: flashLoanOrder.adapter,
      sellToken: flashLoanOrder.sellToken,
      buyToken: flashLoanOrder.buyToken,
      feeAmount: flashLoanOrder.feeAmount,
      txHash: flashLoanOrder.txHash,
      blockNumber: flashLoanOrder.blockNumber,
      blockTimestamp: flashLoanOrder.blockTimestamp,
      validTo: flashLoanOrder.validTo,
      owner: flashLoanOrder.owner,
      type: flashLoanOrder.type,
      executedSellAmount: flashLoanOrder.executedSellAmount,
      executedBuyAmount: flashLoanOrder.executedBuyAmount,
      enrichmentAttempts: flashLoanOrder.enrichmentAttempts,
    })
    .from(flashLoanOrder)
    .where(
      and(
        eq(flashLoanOrder.chainId, chainId),
        isNull(flashLoanOrder.enrichedAt),
        lt(flashLoanOrder.enrichmentAttempts, MAX_FLASH_LOAN_ENRICHMENT_ATTEMPTS),
      ),
    )
    .orderBy(asc(flashLoanOrder.blockNumber));
  return (limit !== undefined ? await query.limit(limit) : await query) as PendingFlashLoanRow[];
}

/**
 * Enrich one batch of pending rows from the orderbook (cache-first) and persist.
 * Hits → one multi-row upsert writing only the orderbook fields + enrichedAt.
 * Misses (not yet on the API) → bump enrichmentAttempts so they eventually stop
 * being polled. On an orderbook fetch failure, leaves the batch pending (retried
 * later). Shared by both the backfiller and the live enricher.
 */
export async function enrichFlashLoanOrders(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  enrichedAtTs: bigint,
  rows: PendingFlashLoanRow[],
): Promise<{ enriched: number; missing: number }> {
  if (rows.length === 0) return { enriched: 0, missing: 0 };

  let enrichment: Awaited<ReturnType<typeof fetchFlashLoanEnrichmentByUids>>;
  try {
    enrichment = await fetchFlashLoanEnrichmentByUids(context, chainId, rows.map((o) => o.orderUid));
  } catch (err) {
    log("warn", "FlashLoanEnrich:fetch_failed", { chainId, uids: rows.length, err: err instanceof Error ? err.message : String(err) });
    return { enriched: 0, missing: 0 }; // leave pending — retried on a later block / run
  }

  const enrichedRows: (typeof flashLoanOrder.$inferInsert)[] = [];
  const missingUids: string[] = [];

  for (const order of rows) {
    const info = enrichment.get(order.orderUid);
    if (!info) {
      missingUids.push(order.orderUid);
      continue;
    }
    enrichedRows.push({
      orderUid: order.orderUid,
      chainId,
      adapter: order.adapter,
      sellToken: order.sellToken,
      buyToken: order.buyToken,
      executedSellAmount: info.executedSellAmount,
      executedBuyAmount: info.executedBuyAmount,
      feeAmount: order.feeAmount,
      txHash: order.txHash,
      blockNumber: order.blockNumber,
      blockTimestamp: order.blockTimestamp,
      validTo: order.validTo,
      owner: order.owner,
      receiver: (info.receiver as Hex | null) ?? null,
      kind: info.kind,
      sellAmountIntended: info.sellAmount,
      buyAmountIntended: info.buyAmount,
      source: "aave",
      type: order.type,
      enrichedAt: enrichedAtTs,
    });
  }

  if (enrichedRows.length > 0) {
    await context.db.sql
      .insert(flashLoanOrder)
      .values(enrichedRows)
      .onConflictDoUpdate({
        target: [flashLoanOrder.chainId, flashLoanOrder.orderUid],
        set: {
          receiver: sql`excluded.receiver`,
          kind: sql`excluded.kind`,
          sellAmountIntended: sql`excluded.sell_amount_intended`,
          buyAmountIntended: sql`excluded.buy_amount_intended`,
          executedSellAmount: sql`excluded.executed_sell_amount`,
          executedBuyAmount: sql`excluded.executed_buy_amount`,
          enrichedAt: sql`excluded.enriched_at`,
        },
      });
  }

  if (missingUids.length > 0) {
    await context.db.sql
      .update(flashLoanOrder)
      .set({ enrichmentAttempts: sql`${flashLoanOrder.enrichmentAttempts} + 1` })
      .where(
        and(
          eq(flashLoanOrder.chainId, chainId),
          inArray(flashLoanOrder.orderUid, missingUids),
        ),
      );
  }

  return { enriched: enrichedRows.length, missing: missingUids.length };
}
