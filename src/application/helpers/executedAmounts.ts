import { and, eq, inArray, sql } from "ponder";
import {
  conditionalOrderGenerator,
  discreteOrder,
} from "ponder:schema";
import type { Context } from "ponder:registry";

const ZERO_AMOUNTS = {
  executedSellAmount: "0",
  executedBuyAmount: "0",
  executedFeeAmount: "0",
};

/** Rebuild parent execution totals after a batch of part-order mutations. */
export async function refreshGeneratorExecutedAmounts(
  context: Context,
  chainId: number,
  generatorIds: string[],
): Promise<void> {
  const ids = [...new Set(generatorIds)];
  if (ids.length === 0) return;

  const rows = await context.db.sql
    .select({
      generatorId: discreteOrder.conditionalOrderGeneratorId,
      executedSellAmount: sql<string>`coalesce(sum(${discreteOrder.executedSellAmount}::numeric), 0)::text`,
      executedBuyAmount: sql<string>`coalesce(sum(${discreteOrder.executedBuyAmount}::numeric), 0)::text`,
      executedFeeAmount: sql<string>`coalesce(sum(${discreteOrder.executedFeeAmount}::numeric), 0)::text`,
    })
    .from(discreteOrder)
    .where(
      and(
        eq(discreteOrder.chainId, chainId),
        inArray(discreteOrder.conditionalOrderGeneratorId, ids),
      ),
    )
    .groupBy(discreteOrder.conditionalOrderGeneratorId);

  const totalsByGenerator = new Map(
    rows.map(({ generatorId, ...amounts }) => [generatorId, amounts]),
  );

  for (const eventId of ids) {
    await context.db
      .update(conditionalOrderGenerator, { chainId, eventId })
      .set(totalsByGenerator.get(eventId) ?? ZERO_AMOUNTS);
  }
}
