import type { Context } from "ponder:registry";
import { and, eq, inArray } from "ponder";
import { conditionalOrderGenerator } from "ponder:schema";

export async function updateGeneratorWatermarks(
  context: Context,
  chainId: number,
  generatorIds: string[],
  updatedAtBlock: bigint,
): Promise<void> {
  const uniqueGeneratorIds = [...new Set(generatorIds)];
  if (uniqueGeneratorIds.length === 0) return;

  await context.db.sql
    .update(conditionalOrderGenerator)
    .set({ updatedAtBlock })
    .where(
      and(
        eq(conditionalOrderGenerator.chainId, chainId),
        inArray(conditionalOrderGenerator.eventId, uniqueGeneratorIds),
      ),
    );
}
