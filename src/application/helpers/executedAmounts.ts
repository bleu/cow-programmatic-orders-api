import { and, eq, inArray, sql } from "ponder";
import {
  conditionalOrderGenerator,
  discreteOrder,
  type TwapAdditionalData,
} from "ponder:schema";
import type { Context } from "ponder:registry";

const ZERO_TOTALS: TwapAdditionalData = {
  executedSellAmount: "0",
  executedBuyAmount: "0",
  executedFee: "0",
};

/** Rebuild TWAP parents' execution totals (additionalData) after part-order writes.
 *  TWAP-only: every part sells the same token, so summing raw amounts is unit-safe
 *  (the orderbook reports executedFee in the sell token for sell orders). Other
 *  order types keep additionalData null — e.g. PerpetualSwap parts alternate
 *  direction, so a single sum would mix token units. */
export async function refreshTwapExecutedTotals(
  context: Context,
  chainId: number,
  generatorIds: string[],
): Promise<void> {
  const ids = [...new Set(generatorIds)];
  if (ids.length === 0) return;

  const generators = (await context.db.sql
    .select({
      eventId: conditionalOrderGenerator.eventId,
      orderType: conditionalOrderGenerator.orderType,
    })
    .from(conditionalOrderGenerator)
    .where(
      and(
        eq(conditionalOrderGenerator.chainId, chainId),
        inArray(conditionalOrderGenerator.eventId, ids),
      ),
    )) as { eventId: string; orderType: string }[];

  const twapIds = generators
    .filter((generator) => generator.orderType === "TWAP")
    .map((generator) => generator.eventId);
  if (twapIds.length === 0) return;

  // The .as() aliases are load-bearing: drizzle does not auto-alias raw sql
  // fragments, so without them all three columns come back named "coalesce".
  // Ponder's context.db.sql maps result rows positionally via Object.values(row),
  // and the duplicate keys collapse — the fee sum landed in executedSellAmount
  // and the other two fields were dropped from the stored JSON.
  const rows = await context.db.sql
    .select({
      generatorId: discreteOrder.conditionalOrderGeneratorId,
      executedSellAmount: sql<string>`coalesce(sum(${discreteOrder.executedSellAmount}::numeric), 0)::text`.as("executed_sell_amount_sum"),
      executedBuyAmount: sql<string>`coalesce(sum(${discreteOrder.executedBuyAmount}::numeric), 0)::text`.as("executed_buy_amount_sum"),
      executedFee: sql<string>`coalesce(sum(${discreteOrder.executedFee}::numeric), 0)::text`.as("executed_fee_sum"),
    })
    .from(discreteOrder)
    .where(
      and(
        eq(discreteOrder.chainId, chainId),
        inArray(discreteOrder.conditionalOrderGeneratorId, twapIds),
      ),
    )
    .groupBy(discreteOrder.conditionalOrderGeneratorId);

  const totalsByGenerator = new Map(
    rows.map(({ generatorId, ...totals }) => [generatorId, totals]),
  );

  for (const eventId of twapIds) {
    await context.db
      .update(conditionalOrderGenerator, { chainId, eventId })
      .set({ additionalData: totalsByGenerator.get(eventId) ?? ZERO_TOTALS });
  }
}
